import { fork, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Case20Mode } from "./model.js";

export interface Case20PartAClientFixture {
  readonly clientId: string;
  readonly principalId: string;
  readonly personalAccessToken: string;
  readonly agentId: string;
  readonly streamCanary: string;
}

export interface Case20AuditVerification {
  readonly restored: true;
  readonly filesScanned: number;
  readonly auditFiles: number;
}

export interface Case20PartAFixture {
  readonly daemonUrl: string;
  readonly daemonPid: number;
  readonly daemonLogPath: string;
  readonly childLogPath: string;
  readonly clients: readonly Case20PartAClientFixture[];
  close(): Promise<Case20AuditVerification>;
}

type ChildMessage =
  | {
      readonly type: "ready";
      readonly daemonUrl: string;
      readonly daemonPid: number;
      readonly clients: readonly Case20PartAClientFixture[];
    }
  | { readonly type: "closed"; readonly audit: Case20AuditVerification }
  | { readonly type: "failed"; readonly phase: "start" | "close"; readonly message: string };

function isChildMessage(value: unknown): value is ChildMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { readonly type?: unknown }).type;
  return type === "ready" || type === "closed" || type === "failed";
}

function waitForMessage(
  child: ChildProcess,
  accept: (message: ChildMessage) => boolean,
  timeoutMs: number,
): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Case20 daemon child timed out")), timeoutMs);
    const onMessage = (value: unknown) => {
      if (!isChildMessage(value) || !accept(value)) return;
      finish(null, value);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Case20 daemon child exited early (${String(code)}/${String(signal)})`));
    };
    const finish = (error: Error | null, message?: ChildMessage) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else if (message) resolve(message);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Case20 daemon child did not exit after cleanup"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sendShutdownToChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send({ type: "shutdown" }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function daemonChildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(?:token|key|secret|password|cookie|authorization|credential)/i.test(key),
    ),
  );
}

export async function createCase20PartAFixture(input: {
  readonly daemonLogPath: string;
  readonly childLogPath: string;
  readonly mode: Case20Mode;
}): Promise<Case20PartAFixture> {
  const childLog = await open(input.childLogPath, "wx", 0o600);
  const runningFromTypeScript = fileURLToPath(import.meta.url).endsWith(".ts");
  const childModule = fileURLToPath(
    new URL(runningFromTypeScript ? "./part-a-daemon.ts" : "./part-a-daemon.js", import.meta.url),
  );
  let child: ChildProcess;
  try {
    child = fork(childModule, [], {
      execArgv: runningFromTypeScript ? ["--import", "tsx"] : [],
      env: {
        ...daemonChildEnvironment(),
        CASE20_DAEMON_LOG_PATH: input.daemonLogPath,
        CASE20_MODE: input.mode,
      },
      stdio: ["ignore", childLog.fd, childLog.fd, "ipc"],
    });
  } catch (error) {
    const closeFailure = await childLog.close().then(
      () => null,
      (failure: unknown) => failure,
    );
    if (closeFailure !== null)
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the fork error as its cause and first member.
      throw new AggregateError([error, closeFailure], "Case20 child fork cleanup failed", {
        cause: error,
      });
    throw error;
  }
  let closed = false;
  try {
    const message = await waitForMessage(
      child,
      (candidate) => candidate.type === "ready" || candidate.type === "failed",
      90_000,
    );
    if (message.type === "failed")
      throw new Error(`Case20 daemon ${message.phase} failed: ${message.message}`);
    if (message.type !== "ready")
      throw new Error("Case20 daemon child returned an invalid start message");
    return {
      daemonUrl: message.daemonUrl,
      daemonPid: message.daemonPid,
      daemonLogPath: input.daemonLogPath,
      childLogPath: input.childLogPath,
      clients: message.clients,
      async close() {
        if (closed) throw new Error("Case20 daemon child was already closed");
        closed = true;
        const pending = waitForMessage(
          child,
          (candidate) => candidate.type === "closed" || candidate.type === "failed",
          90_000,
        );
        const exited = waitForExit(child, 10_000);
        let result: ChildMessage;
        try {
          await sendShutdownToChild(child);
          [result] = await Promise.all([pending, exited]);
        } catch (error) {
          child.kill("SIGTERM");
          const cleanup = await Promise.allSettled([pending, exited, childLog.close()]);
          const failures = cleanup
            .filter((entry) => entry.status === "rejected")
            .map((entry) => entry.reason);
          if (failures.length > 0)
            // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the shutdown error as its cause and first member.
            throw new AggregateError(
              [error, ...failures],
              "Case20 daemon child shutdown cleanup failed",
              { cause: error },
            );
          throw error;
        }
        await childLog.close();
        if (result.type === "failed")
          throw new Error(`Case20 daemon ${result.phase} failed: ${result.message}`);
        if (result.type !== "closed")
          throw new Error("Case20 daemon child returned an invalid close message");
        return result.audit;
      },
    };
  } catch (error) {
    child.kill("SIGTERM");
    const cleanup = await Promise.allSettled([waitForExit(child, 10_000), childLog.close()]);
    const failures = cleanup
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0)
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the startup error as cause and first member.
      throw new AggregateError([error, ...failures], "Case20 child startup cleanup failed", {
        cause: error,
      });
    throw error;
  }
}
