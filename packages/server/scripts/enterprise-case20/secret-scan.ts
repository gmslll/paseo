import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const GENERIC_SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~-]{12,}/i,
  /\bpso_[A-Za-z0-9._~-]{12,}/,
  /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9._~-]{12,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /(?:access|refresh|id|oauth)[_-]?token["'=:\s]+[A-Za-z0-9._~-]{12,}/i,
  /(?:cookie|set-cookie)["'=:\s]+[^\s,;]{8,}/i,
] as const;

function fingerprints(secrets: readonly string[]): readonly string[] {
  return secrets
    .filter((secret) => secret.length >= 8)
    .flatMap((secret) => [secret, createHash("sha256").update(secret).digest("hex")]);
}

export async function assertFileContainsNoSecrets(input: {
  readonly filePath: string;
  readonly knownSecrets: readonly string[];
}): Promise<void> {
  const needles = fingerprints(input.knownSecrets);
  const lines = createInterface({
    input: createReadStream(input.filePath),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (
      needles.some((needle) => line.includes(needle)) ||
      GENERIC_SECRET_PATTERNS.some((pattern) => pattern.test(line))
    ) {
      throw new Error(`Case20 secret material detected in ${input.filePath}:${lineNumber}`);
    }
  }
}

function collectStrings(value: unknown, key: string, output: string[]): void {
  if (typeof value === "string") {
    if (/(?:token|secret|password|api[_-]?key|cookie|authorization)/i.test(key)) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, key, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value)) collectStrings(child, childKey, output);
}

export async function readKnownSecretsFromJson(filePath: string): Promise<readonly string[]> {
  const contents = await readFile(filePath, "utf8").catch(() => null);
  if (!contents) return [];
  return readKnownSecretsFromJsonContents(contents);
}

export function readKnownSecretsFromJsonContents(contents: string): readonly string[] {
  const output: string[] = [];
  collectStrings(JSON.parse(contents) as unknown, "root", output);
  return [...new Set(output.filter((entry) => entry.length >= 8))];
}
