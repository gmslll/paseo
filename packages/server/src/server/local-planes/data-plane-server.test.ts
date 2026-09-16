import { request, type IncomingMessage } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DataPlaneFrameKind,
  decodeDataPlaneFrame,
  encodeDataPlaneFrame,
  type DataPlaneFrame,
} from "@getpaseo/protocol/binary-frames/data-plane";
import {
  LengthPrefixedFrameDecoder,
  encodeLengthPrefixedFrame,
} from "@getpaseo/protocol/binary-frames/length-prefix";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { DataPlaneChannel } from "./data-plane-access.js";
import {
  startDataPlane,
  type DataPlaneAdmission,
  type DataPlaneServer,
} from "./data-plane-server.js";

const TOKEN = "local-token-value";
const ATTACH_TOKEN = "attach-token-value";

let directory: string;
let socketPath: string;
let plane: DataPlaneServer | null;

interface Recorder {
  readonly verified: string[];
  readonly frames: DataPlaneFrame[];
  detaches: number;
  channel: DataPlaneChannel | null;
}

function recorder(): Recorder {
  return { verified: [], frames: [], detaches: 0, channel: null };
}

function createAdmission(input: {
  recorder: Recorder;
  ticket?: boolean;
  attachment?: boolean;
}): DataPlaneAdmission {
  return {
    verify: (token) => {
      input.recorder.verified.push(token);
      return input.ticket === false ? null : { sessionId: "ses_1" };
    },
    attach: (_ticket, channel) => {
      if (input.attachment === false) return null;
      input.recorder.channel = channel;
      return {
        handleFrame: (frame) => input.recorder.frames.push(frame),
        detach: () => {
          input.recorder.detaches += 1;
        },
      };
    },
  };
}

type UpgradeResult =
  | { kind: "upgraded"; socket: Socket; head: Buffer }
  | { kind: "response"; status: number };

function openData(headers: Record<string, string>, method = "POST"): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method, path: "/v1/data", headers });
    outgoing.on("upgrade", (_response: IncomingMessage, socket: Socket, head: Buffer) =>
      resolve({ kind: "upgraded", socket, head }),
    );
    outgoing.on("response", (response) => {
      response.resume();
      resolve({ kind: "response", status: response.statusCode ?? 0 });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

const upgradeHeaders = {
  connection: "Upgrade",
  upgrade: "paseo-data/1",
  "x-paseo-local-token": TOKEN,
  "x-paseo-attach-token": ATTACH_TOKEN,
};

function nextFrames(socket: Socket, count: number): Promise<DataPlaneFrame[]> {
  return new Promise((resolve) => {
    const decoder = new LengthPrefixedFrameDecoder({ maxFrameBytes: 1_048_576 });
    const frames: DataPlaneFrame[] = [];
    const onData = (chunk: Buffer) => {
      for (const bytes of decoder.push(chunk)) {
        const frame = decodeDataPlaneFrame(bytes);
        if (frame) frames.push(frame);
      }
      if (frames.length >= count) {
        socket.off("data", onData);
        resolve(frames.slice(0, count));
      }
    };
    socket.on("data", onData);
  });
}

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  // Below vitest's test timeout, so a stuck wait reports its label instead of a bare timeout.
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function start(admission: DataPlaneAdmission): Promise<void> {
  plane = await startDataPlane({
    endpoint: { transport: "unix", path: socketPath },
    token: TOKEN,
    admission,
    logger: createTestLogger(),
  });
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-data-plane-"));
  socketPath = path.join(directory, "data.sock");
  plane = null;
});

afterEach(async () => {
  await plane?.close();
  await rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("data plane server", () => {
  test("carries document frames both ways over an attached channel", async () => {
    const recorded = recorder();
    await start(createAdmission({ recorder: recorded }));

    const opened = await openData(upgradeHeaders);
    if (opened.kind !== "upgraded") throw new Error(`expected an upgrade, got ${opened.status}`);
    expect(recorded.verified).toEqual([ATTACH_TOKEN]);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

    const outbound = nextFrames(opened.socket, 1);
    recorded.channel?.send(
      encodeDataPlaneFrame({
        kind: DataPlaneFrameKind.Snapshot,
        docId: "wf",
        payload: Uint8Array.from([7]),
      }),
    );
    expect(await outbound).toEqual([
      { kind: DataPlaneFrameKind.Snapshot, docId: "wf", payload: Uint8Array.from([7]) },
    ]);
    expect(recorded.channel?.bufferedAmount()).toBeGreaterThanOrEqual(0);

    opened.socket.write(
      encodeLengthPrefixedFrame(
        encodeDataPlaneFrame({
          kind: DataPlaneFrameKind.Update,
          docId: "s:agent-1",
          payload: Uint8Array.from([1, 2]),
        }),
      ),
    );
    await waitUntil(() => recorded.frames.length === 1, "an inbound document frame");
    expect(recorded.frames).toEqual([
      { kind: DataPlaneFrameKind.Update, docId: "s:agent-1", payload: Uint8Array.from([1, 2]) },
    ]);

    opened.socket.end();
    await waitUntil(() => recorded.detaches === 1, "detach after the client closes");
  });

  test("drops a channel that sends bytes it cannot decode", async () => {
    const recorded = recorder();
    await start(createAdmission({ recorder: recorded }));

    const opened = await openData(upgradeHeaders);
    if (opened.kind !== "upgraded") throw new Error("expected an upgrade");

    // A terminal opcode is not a data frame: the plane refuses it instead of skipping past it.
    opened.socket.write(encodeLengthPrefixedFrame(Uint8Array.from([0x01, 0x00, 0x68])));

    await waitUntil(() => recorded.detaches === 1, "detach after an undecodable frame");
    expect(recorded.frames).toEqual([]);
  });

  test("refuses a bad local token, a missing attach token, and a spent one", async () => {
    const recorded = recorder();
    await start(createAdmission({ recorder: recorded, ticket: false }));

    expect(await openData({ ...upgradeHeaders, "x-paseo-local-token": "guess" })).toMatchObject({
      status: 401,
    });
    const { "x-paseo-attach-token": _attach, ...withoutAttach } = upgradeHeaders;
    expect(await openData(withoutAttach)).toMatchObject({ status: 401 });
    expect(recorded.verified).toEqual([]);

    expect(await openData(upgradeHeaders)).toMatchObject({ status: 401 });
    expect(recorded.verified).toEqual([ATTACH_TOKEN]);
  });

  test("closes the stream when the Session will not serve documents", async () => {
    const recorded = recorder();
    await start(createAdmission({ recorder: recorded, attachment: false }));

    const opened = await openData(upgradeHeaders);
    if (opened.kind !== "upgraded") throw new Error("expected an upgrade");

    await new Promise<void>((resolve) => opened.socket.once("close", () => resolve()));
    expect(recorded.detaches).toBe(0);
  });

  test("answers plain requests with 426 and wrong upgrades with 400", async () => {
    await start(createAdmission({ recorder: recorder() }));

    expect(await openData({ "x-paseo-local-token": TOKEN }, "GET")).toMatchObject({ status: 426 });
    expect(await openData({ ...upgradeHeaders, upgrade: "paseo-terminal/1" })).toMatchObject({
      status: 400,
    });
  });

  test("detaches open channels and removes its socket when it stops", async () => {
    const recorded = recorder();
    await start(createAdmission({ recorder: recorded }));
    const opened = await openData(upgradeHeaders);
    if (opened.kind !== "upgraded") throw new Error("expected an upgrade");

    await plane?.close();
    plane = null;
    await waitUntil(() => recorded.detaches === 1, "detach when the plane stops");

    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
