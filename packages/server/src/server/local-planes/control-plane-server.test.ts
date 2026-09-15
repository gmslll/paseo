import { request, type IncomingMessage } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { encodeControlPlaneCloseLine } from "@getpaseo/protocol/local-planes";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { WebSocketLike } from "../websocket-server.js";
import {
  startControlPlane,
  type ControlPlaneAdmission,
  type ControlPlaneServer,
} from "./control-plane-server.js";

const TOKEN = "local-token-value";

let directory: string;
let socketPath: string;
let plane: ControlPlaneServer | null;

// Bytes the server sends with its 101 response arrive in `head`, not as later socket data.
type UpgradeResult =
  | { kind: "upgraded"; socket: Socket; head: Buffer }
  | { kind: "response"; status: number; headers: IncomingMessage["headers"] };

function openSession(headers: Record<string, string>, method = "POST"): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method, path: "/v1/session", headers });
    outgoing.on("upgrade", (_response, socket, head) =>
      resolve({ kind: "upgraded", socket, head }),
    );
    outgoing.on("response", (response) => {
      response.resume();
      resolve({ kind: "response", status: response.statusCode ?? 0, headers: response.headers });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

const upgradeHeaders = {
  connection: "Upgrade",
  upgrade: "paseo-ndjson/1",
  "x-paseo-local-token": TOKEN,
};

function readLines(opened: { socket: Socket; head: Buffer }, count: number): Promise<string[]> {
  return new Promise((resolve) => {
    let buffered = opened.head.toString("utf8");
    const settleIfComplete = (): boolean => {
      const lines = buffered.split("\n").filter((line) => line.length > 0);
      if (lines.length < count) return false;
      resolve(lines.slice(0, count));
      return true;
    };
    if (settleIfComplete()) return;
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (settleIfComplete()) opened.socket.off("data", onData);
    };
    opened.socket.on("data", onData);
  });
}

// Echoes each text frame, the way a Session answers a request.
function echoAdmission(input: {
  allow: boolean;
  attached: WebSocketLike[];
  bearers: Array<string | null>;
}): ControlPlaneAdmission {
  return {
    authenticate: async (bearer) => {
      input.bearers.push(bearer);
      return input.allow ? { kind: "allowed" } : { kind: "denied" };
    },
    attach: async (socket) => {
      input.attached.push(socket);
      socket.on("message", (message) => socket.send(`{"echo":${JSON.stringify(String(message))}}`));
    },
  };
}

async function start(admission: ControlPlaneAdmission): Promise<void> {
  plane = await startControlPlane({
    endpoint: { transport: "unix", path: socketPath },
    token: TOKEN,
    admission,
    logger: createTestLogger(),
  });
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-control-"));
  socketPath = path.join(directory, "control.sock");
  plane = null;
});

afterEach(async () => {
  await plane?.close();
  await rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("control plane server", () => {
  test("upgrades a request with the local token and carries the Session both ways", async () => {
    const attached: WebSocketLike[] = [];
    const bearers: Array<string | null> = [];
    await start(echoAdmission({ allow: true, attached, bearers }));

    const opened = await openSession({ ...upgradeHeaders, authorization: "Bearer pat_abc" });
    if (opened.kind !== "upgraded") throw new Error(`expected an upgrade, got ${opened.status}`);
    const lines = readLines(opened, 1);
    opened.socket.write('{"type":"hello"}\n');

    expect(await lines).toEqual(['{"echo":"{\\"type\\":\\"hello\\"}"}']);
    expect(attached).toHaveLength(1);
    expect(bearers).toEqual(["pat_abc"]);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    opened.socket.destroy();
  });

  test("refuses a missing or wrong local token before admission runs", async () => {
    const attached: WebSocketLike[] = [];
    const bearers: Array<string | null> = [];
    await start(echoAdmission({ allow: true, attached, bearers }));

    const missing = await openSession({ connection: "Upgrade", upgrade: "paseo-ndjson/1" });
    const wrong = await openSession({ ...upgradeHeaders, "x-paseo-local-token": "guess" });

    expect(missing).toMatchObject({ kind: "response", status: 401 });
    expect(wrong).toMatchObject({ kind: "response", status: 401 });
    expect(bearers).toEqual([]);
    expect(attached).toEqual([]);
  });

  test("refuses the upgrade when admission denies the caller", async () => {
    const attached: WebSocketLike[] = [];
    const bearers: Array<string | null> = [];
    await start(echoAdmission({ allow: false, attached, bearers }));

    expect(await openSession(upgradeHeaders)).toMatchObject({ kind: "response", status: 401 });
    expect(bearers).toEqual([null]);
    expect(attached).toEqual([]);
  });

  test("answers plain requests with 426 and wrong upgrades with 400", async () => {
    await start(echoAdmission({ allow: true, attached: [], bearers: [] }));

    const plain = await openSession({ "x-paseo-local-token": TOKEN }, "GET");
    expect(plain).toMatchObject({ kind: "response", status: 426 });
    if (plain.kind === "response") expect(plain.headers.upgrade).toBe("paseo-ndjson/1");
    expect(await openSession({ ...upgradeHeaders, upgrade: "websocket" })).toMatchObject({
      kind: "response",
      status: 400,
    });
    expect(await openSession(upgradeHeaders, "GET")).toMatchObject({
      kind: "response",
      status: 400,
    });
  });

  test("closes upgraded Sessions and removes its socket when it stops", async () => {
    const attached: WebSocketLike[] = [];
    await start(echoAdmission({ allow: true, attached, bearers: [] }));
    const opened = await openSession(upgradeHeaders);
    if (opened.kind !== "upgraded") throw new Error("expected an upgrade");
    const ended = new Promise<void>((resolve) => opened.socket.once("close", () => resolve()));

    await plane?.close();
    plane = null;

    await ended;
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("closes the stream when the Session cannot attach", async () => {
    await start({
      authenticate: async () => ({ kind: "allowed" }),
      attach: async () => {
        throw new Error("daemon is shutting down");
      },
    });

    const opened = await openSession(upgradeHeaders);
    if (opened.kind !== "upgraded") throw new Error("expected an upgrade");

    expect(await readLines(opened, 1)).toEqual([
      encodeControlPlaneCloseLine({ code: 1011, reason: "Session attach failed" }),
    ]);
  });
});
