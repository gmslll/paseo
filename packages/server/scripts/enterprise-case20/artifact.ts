import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { Case20RawEvent, Case20Summary } from "./model.js";
import { assertFileContainsNoSecrets, assertTextContainsNoSecrets } from "./secret-scan.js";

const SECRET_KEY = /(token|password|authorization|cookie|secret|credential)/i;
const CREDENTIAL_VALUE =
  /(?:bearer\s+|paseo\.bearer\.|pso_[a-z]_|sk-(?:proj-|or-v1-)?)[a-zA-Z0-9._~-]{12,}|\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b|(?:cookie|set-cookie)["'=:\s]+[^\s,;]{8,}/i;

function assertSecretFree(value: unknown, key = "root"): void {
  if (SECRET_KEY.test(key)) throw new Error(`Case20 artifact rejected secret-bearing key: ${key}`);
  if (typeof value === "string" && CREDENTIAL_VALUE.test(value))
    throw new Error("Case20 artifact rejected a credential-like value");
  if (Array.isArray(value)) {
    for (const entry of value) assertSecretFree(entry, key);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value))
    assertSecretFree(childValue, childKey);
}

export async function writeCase20BufferCompletely(
  contents: Uint8Array,
  write: (buffer: Uint8Array, offset: number, length: number) => Promise<number>,
): Promise<void> {
  let offset = 0;
  while (offset < contents.byteLength) {
    const bytesWritten = await write(contents, offset, contents.byteLength - offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0)
      throw new Error("Case20 artifact write made no forward progress");
    if (bytesWritten > contents.byteLength - offset)
      throw new Error("Case20 artifact write exceeded the requested length");
    offset += bytesWritten;
  }
}

export async function validateCase20RawJsonl(filePath: string): Promise<number> {
  const contents = await readFile(filePath, "utf8");
  if (!contents.endsWith("\n")) throw new Error("Case20 raw JSONL has a truncated final line");
  const lines = contents.slice(0, -1).split("\n");
  if (lines.length === 0 || (lines.length === 1 && lines[0] === ""))
    throw new Error("Case20 raw JSONL is empty");
  for (const [index, line] of lines.entries()) {
    if (!line) throw new Error(`Case20 raw JSONL contains an empty line at ${index + 1}`);
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`Case20 raw JSONL line ${index + 1} is not an object`);
  }
  return lines.length;
}

export interface Case20ArtifactWriter {
  readonly directory: string;
  readonly rawPath: string;
  readonly summaryPath: string;
  readonly inventoryPath: string;
  append(event: Case20RawEvent, options?: { readonly durable?: boolean }): Promise<void>;
  finish(
    summary: Case20Summary,
    options?: {
      readonly knownSecrets?: readonly string[];
      readonly evidenceFiles?: readonly string[];
    },
  ): Promise<void>;
  close(): Promise<void>;
}

export async function createCase20ArtifactWriter(input: {
  readonly artifactRoot: string;
  readonly runId: string;
}): Promise<Case20ArtifactWriter> {
  const directory = path.resolve(input.artifactRoot, input.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const rawPath = path.join(directory, "raw.jsonl");
  const summaryPath = path.join(directory, "summary.json");
  const inventoryPath = path.join(directory, "inventory.json");
  const handle = await open(
    rawPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  let closed = false;
  let tail = Promise.resolve();
  let writerFailure: unknown;
  let pending = 0;
  const periodicSync = setInterval(() => {
    tail = tail.then(async () => {
      if (writerFailure) return;
      try {
        await handle.sync();
      } catch (error) {
        writerFailure ??= error;
      }
      return undefined;
    });
  }, 1_000);
  periodicSync.unref();
  const append = (
    event: Case20RawEvent,
    options?: { readonly durable?: boolean },
  ): Promise<void> => {
    if (closed) return Promise.reject(new Error("Case20 artifact writer is closed"));
    if (pending >= 256) return Promise.reject(new Error("Case20 artifact queue is full"));
    assertSecretFree(event);
    pending += 1;
    const operation = tail.then(async () => {
      if (writerFailure) throw writerFailure;
      const contents = Buffer.from(`${JSON.stringify(event)}\n`);
      await writeCase20BufferCompletely(contents, async (buffer, offset, length) => {
        const result = await handle.write(buffer, offset, length);
        return result.bytesWritten;
      });
      if (options?.durable) await handle.sync();
      return undefined;
    });
    tail = operation.then(
      () => {
        pending -= 1;
        return undefined;
      },
      (error: unknown) => {
        pending -= 1;
        writerFailure ??= error;
        return undefined;
      },
    );
    return operation;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(periodicSync);
    let failure: unknown;
    try {
      await tail;
      if (!writerFailure) await handle.sync();
    } catch (error) {
      writerFailure ??= error;
    } finally {
      await handle.close().catch((error) => (failure ??= error));
    }
    failure ??= writerFailure;
    if (failure) throw failure;
  };
  async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
    const temporaryPath = `${filePath}.tmp`;
    const temporary = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      try {
        await temporary.writeFile(`${JSON.stringify(value, null, 2)}\n`);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return {
    directory,
    rawPath,
    summaryPath,
    inventoryPath,
    append,
    async finish(summary, options) {
      try {
        assertSecretFree(summary);
        await tail;
        if (writerFailure) throw writerFailure;
        await handle.sync();
        await validateCase20RawJsonl(rawPath);
        const knownSecrets = options?.knownSecrets ?? [];
        assertTextContainsNoSecrets({
          text: JSON.stringify(summary),
          label: "summary.json",
          knownSecrets,
        });
        const evidenceFiles = new Set([rawPath, ...(options?.evidenceFiles ?? [])]);
        for (const name of await readdir(directory)) {
          if (name.endsWith(".tmp")) continue;
          const filePath = path.join(directory, name);
          if ((await stat(filePath)).isFile()) evidenceFiles.add(filePath);
        }
        for (const filePath of evidenceFiles) {
          const info = await stat(filePath).catch(() => null);
          if (info?.isFile()) await assertFileContainsNoSecrets({ filePath, knownSecrets });
        }
        await writePrivateJson(summaryPath, summary);
        const entries = [];
        for (const name of (await readdir(directory)).sort()) {
          if (name === path.basename(inventoryPath) || name.endsWith(".tmp")) continue;
          const filePath = path.join(directory, name);
          const info = await stat(filePath);
          if (!info.isFile()) continue;
          const contents = await readFile(filePath);
          entries.push({
            name,
            size: info.size,
            sha256: createHash("sha256").update(contents).digest("hex"),
          });
        }
        await writePrivateJson(inventoryPath, { schemaVersion: 1, entries });
      } catch (error) {
        const cleanupFailures: unknown[] = [];
        await close().catch((failure) => cleanupFailures.push(failure));
        await rm(directory, { recursive: true, force: true }).catch((failure) =>
          cleanupFailures.push(failure),
        );
        if (cleanupFailures.length > 0)
          // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the rejected artifact error as cause and first member.
          throw new AggregateError(
            [error, ...cleanupFailures],
            "Case20 rejected artifact cleanup failed",
            { cause: error },
          );
        throw error;
      }
    },
    close,
  };
}

export function assertCase20ArtifactSecretFree(value: unknown): void {
  assertSecretFree(value);
}
