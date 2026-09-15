import { spawn } from "node:child_process";
import { request } from "node:http";
import { lstat, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ProbeState } from "@getpaseo/protocol/local-planes";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { startProbePlane, type ProbePlaneServer } from "./probe-plane-server.js";

const state: ProbeState = {
  pid: process.pid,
  serverId: "srv_probe",
  version: "0.9.0",
  startedAt: "2026-09-16T08:00:00.000Z",
  uptimeMs: 1_000,
  lifecycle: "running",
  desktopManaged: false,
  planes: { probe: { status: "listening", path: "/tmp/probe.sock" } },
  websocket: { listen: "127.0.0.1:6767" },
  relay: { enabled: true, connected: false },
  eventLoopDelayMs: { p50: 0.5, p99: 2, max: 4 },
  counts: { sessions: 1, agents: 2, terminals: 0 },
  managedRuntimes: [],
  enterprise: null,
};

let directory: string;
let server: ProbePlaneServer | null;

function probeRequest(
  socketPath: string,
  method: string,
  requestPath: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method, path: requestPath }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }),
      );
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

// A process killed with SIGKILL never unlinks its listening socket, like a crashed daemon.
async function leaveOrphanedSocket(socketPath: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => console.log("ready"))`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.once("data", () => resolve());
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

async function start(readState: () => Promise<ProbeState>): Promise<string> {
  const socketPath = path.join(directory, "probe.sock");
  server = await startProbePlane({
    endpoint: { transport: "unix", path: socketPath },
    readState,
    logger: createTestLogger(),
  });
  return socketPath;
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-probe-"));
  server = null;
});

afterEach(async () => {
  await server?.close();
  await rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("probe plane server", () => {
  test("serves health and validated state on an owner-only socket", async () => {
    const socketPath = await start(async () => state);

    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect(await probeRequest(socketPath, "GET", "/healthz")).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    expect(await probeRequest(socketPath, "GET", "/state")).toEqual({ status: 200, body: state });
    expect(await probeRequest(socketPath, "POST", "/state")).toEqual({
      status: 405,
      body: { error: "method_not_allowed" },
    });
    expect(await probeRequest(socketPath, "GET", "/v1/session")).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
  });

  test("answers 500 instead of publishing state that fails the schema", async () => {
    const socketPath = await start(async () => ({ ...state, pid: -1 }));

    expect(await probeRequest(socketPath, "GET", "/state")).toEqual({
      status: 500,
      body: { error: "state_unavailable" },
    });
  });

  test("replaces a socket left by a crashed daemon but not another kind of file", async () => {
    const socketPath = path.join(directory, "probe.sock");
    await leaveOrphanedSocket(socketPath);
    expect((await lstat(socketPath)).isSocket()).toBe(true);

    server = await startProbePlane({
      endpoint: { transport: "unix", path: socketPath },
      readState: async () => state,
      logger: createTestLogger(),
    });
    expect((await probeRequest(socketPath, "GET", "/healthz")).status).toBe(200);

    const regularFile = path.join(directory, "not-a-socket.sock");
    await writeFile(regularFile, "keep me");
    await expect(
      startProbePlane({
        endpoint: { transport: "unix", path: regularFile },
        readState: async () => state,
        logger: createTestLogger(),
      }),
    ).rejects.toThrow("it is not a socket");
  });

  test("removes its socket when it closes", async () => {
    const socketPath = await start(async () => state);

    await server?.close();
    server = null;

    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
