import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  encodeControlPlaneBinaryLine,
  encodeControlPlaneCloseLine,
} from "@getpaseo/protocol/local-planes";

import { NdjsonSocketAdapter } from "./ndjson-socket.js";

let directory: string;
let server: Server;
let client: Socket;
let adapter: NdjsonSocketAdapter;

async function connectPair(): Promise<void> {
  const socketPath = path.join(directory, "control.sock");
  const accepted = new Promise<Socket>((resolve) => {
    server = createServer((socket) => resolve(socket));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  client = connect(socketPath);
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  adapter = new NdjsonSocketAdapter(await accepted);
}

function nextClientLines(count: number): Promise<string[]> {
  return new Promise((resolve) => {
    let buffered = "";
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n").filter((line) => line.length > 0);
      if (lines.length >= count) {
        client.off("data", onData);
        resolve(lines.slice(0, count));
      }
    };
    client.on("data", onData);
  });
}

function nextEvent(event: "close" | "error"): Promise<unknown[]> {
  return new Promise((resolve) => adapter.once(event, (...args) => resolve(args)));
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-ndjson-"));
});

afterEach(async () => {
  client?.destroy();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("NdjsonSocketAdapter", () => {
  test("holds lines sent before the daemon listens and delivers them in order", async () => {
    await connectPair();
    client.write('{"type":"hello","clientId":"a"}\n{"type":"se');
    client.write('ssion","message":{"type":"ping"}}\n');
    client.write(`${encodeControlPlaneBinaryLine(Uint8Array.from([2, 0, 9]))}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const received: unknown[] = [];
    await new Promise<void>((resolve) => {
      adapter.on("message", (message) => {
        received.push(message);
        if (received.length === 3) resolve();
      });
    });

    expect(received).toEqual([
      '{"type":"hello","clientId":"a"}',
      '{"type":"session","message":{"type":"ping"}}',
      Buffer.from([2, 0, 9]),
    ]);
  });

  test("writes text frames as lines and binary frames as reserved lines", async () => {
    await connectPair();
    const lines = nextClientLines(2);

    adapter.send('{"type":"session","message":{"type":"pong"}}');
    await new Promise<void>((resolve, reject) => {
      adapter.send(Uint8Array.from([1, 255]), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    expect(await lines).toEqual([
      '{"type":"session","message":{"type":"pong"}}',
      encodeControlPlaneBinaryLine(Uint8Array.from([1, 255])),
    ]);
    expect(adapter.bufferedAmount).toBeGreaterThanOrEqual(0);
  });

  test("sends a close line once and reports the close to the daemon", async () => {
    await connectPair();
    const lines = nextClientLines(1);
    const closed = nextEvent("close");

    adapter.close(4001, "Enterprise authentication failed");
    adapter.close(1000, "again");

    expect(await lines).toEqual([
      encodeControlPlaneCloseLine({ code: 4001, reason: "Enterprise authentication failed" }),
    ]);
    expect(await closed).toEqual([4001, "Enterprise authentication failed"]);
    expect(adapter.readyState).toBe(3);
  });

  test("reports a client close line with its code and reason", async () => {
    await connectPair();
    adapter.on("message", () => undefined);
    const closed = nextEvent("close");

    client.write(`${encodeControlPlaneCloseLine({ code: 1000, reason: "done" })}\n`);

    expect(await closed).toEqual([1000, "done"]);
  });

  test("closes with 1009 when a line exceeds the limit", async () => {
    await connectPair();
    const errored = nextEvent("error");
    const closed = nextEvent("close");

    client.write(Buffer.alloc(8 * 1_048_576 + 1, 0x61));

    expect((await errored)[0]).toBeInstanceOf(Error);
    expect(await closed).toEqual([1009, "line too large"]);
  });
});
