import { request, type IncomingMessage } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TERMINAL_PLANE_JSON_OPCODE } from "@getpaseo/protocol/local-planes";
import {
  LengthPrefixedFrameDecoder,
  encodeLengthPrefixedFrame,
} from "@getpaseo/protocol/binary-frames/length-prefix";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  startTerminalPlane,
  type TerminalPlaneAdmission,
  type TerminalPlaneAttachment,
  type TerminalPlaneChannel,
  type TerminalPlaneServer,
} from "./terminal-plane-server.js";

const TOKEN = "local-token-value";
const ATTACH_TOKEN = "attach-token-value";

let directory: string;
let socketPath: string;
let plane: TerminalPlaneServer | null;

interface Recorder {
  readonly verified: string[];
  readonly terminalFrames: Uint8Array[];
  readonly jsonMessages: string[];
  detaches: number;
  channel: TerminalPlaneChannel | null;
}

function createAdmission(input: {
  recorder: Recorder;
  ticket?: boolean;
  attachment?: boolean;
}): TerminalPlaneAdmission {
  return {
    verify: (token) => {
      input.recorder.verified.push(token);
      return input.ticket === false ? null : { sessionId: "ses_1" };
    },
    attach: (_ticket, channel): TerminalPlaneAttachment | null => {
      if (input.attachment === false) return null;
      input.recorder.channel = channel;
      return {
        handleTerminalFrame: (frame) => input.recorder.terminalFrames.push(frame),
        handleJsonMessage: (text) => input.recorder.jsonMessages.push(text),
        detach: () => {
          input.recorder.detaches += 1;
        },
      };
    },
  };
}

function recorder(): Recorder {
  return { verified: [], terminalFrames: [], jsonMessages: [], detaches: 0, channel: null };
}

type UpgradeResult =
  | { kind: "upgraded"; socket: Socket; head: Buffer }
  | { kind: "response"; status: number };

function openTerminal(headers: Record<string, string>, method = "POST"): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method, path: "/v1/terminal", headers });
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
  upgrade: "paseo-terminal/1",
  "x-paseo-local-token": TOKEN,
  "x-paseo-attach-token": ATTACH_TOKEN,
};

function nextFrames(socket: Socket, count: number): Promise<Uint8Array[]> {
  return new Promise((resolve) => {
    const decoder = new LengthPrefixedFrameDecoder({ maxFrameBytes: 1_048_576 });
    const frames: Uint8Array[] = [];
    const onData = (chunk: Buffer) => {
      frames.push(...decoder.push(chunk));
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

async function start(admission: TerminalPlaneAdmission): Promise<void> {
  plane = await startTerminalPlane({
    endpoint: { transport: "unix", path: socketPath },
    token: TOKEN,
    admission,
    logger: createTestLogger(),
  });
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-terminal-plane-"));
  socketPath = path.join(directory, "terminal.sock");
  plane = null;
});

afterEach(async () => {
  await plane?.close();
  await rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("terminal plane server", () => {
  test("carries terminal frames and JSON messages over an attached channel", async () => {
    const recorded = recorder();
    await start(createAdmission({ recorder: recorded }));

    const opened = await openTerminal(upgradeHeaders);
    if (opened.kind !== "upgraded") throw new Error(`expected an upgrade, got ${opened.status}`);
    expect(recorded.verified).toEqual([ATTACH_TOKEN]);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

    const outbound = nextFrames(opened.socket, 1);
    recorded.channel?.send(Uint8Array.from([0x01, 0x00, 0x68, 0x69]));
    expect([...(await outbound)[0]!]).toEqual([0x01, 0x00, 0x68, 0x69]);
    expect(recorded.channel?.bufferedAmount()).toBeGreaterThanOrEqual(0);

    opened.socket.write(encodeLengthPrefixedFrame(Uint8Array.from([0x02, 0x00, 0x6c, 0x73])));
    const json = `{"type":"terminal_resize","cols":80}`;
    opened.socket.write(
      encodeLengthPrefixedFrame(
        Uint8Array.from([TERMINAL_PLANE_JSON_OPCODE, ...new TextEncoder().encode(json)]),
      ),
    );
    await waitUntil(
      () => recorded.terminalFrames.length === 1 && recorded.jsonMessages.length === 1,
      "inbound terminal frames",
    );

    expect(recorded.terminalFrames.map((frame) => [...frame])).toEqual([[0x02, 0x00, 0x6c, 0x73]]);
    expect(recorded.jsonMessages).toEqual([json]);

    // end() sends EOF; destroy() can reset the socket without the daemon noticing promptly.
    opened.socket.end();
    await waitUntil(() => recorded.detaches === 1, "detach after the client closes");
  });

  test("refuses a bad local token, a missing attach token, and a spent one", async () => {
    const recorded = recorder();
    await start(createAdmission({ recorder: recorded, ticket: false }));

    expect(await openTerminal({ ...upgradeHeaders, "x-paseo-local-token": "guess" })).toMatchObject(
      {
        status: 401,
      },
    );
    const { "x-paseo-attach-token": _attach, ...withoutAttach } = upgradeHeaders;
    expect(await openTerminal(withoutAttach)).toMatchObject({ status: 401 });
    expect(recorded.verified).toEqual([]);

    expect(await openTerminal(upgradeHeaders)).toMatchObject({ status: 401 });
    expect(recorded.verified).toEqual([ATTACH_TOKEN]);
  });

  test("closes the stream when the Session it was issued for is gone", async () => {
    const recorded = recorder();
    await start(createAdmission({ recorder: recorded, attachment: false }));

    const opened = await openTerminal(upgradeHeaders);
    if (opened.kind !== "upgraded") throw new Error("expected an upgrade");

    await new Promise<void>((resolve) => opened.socket.once("close", () => resolve()));
    expect(recorded.detaches).toBe(0);
  });

  test("answers plain requests with 426 and wrong upgrades with 400", async () => {
    await start(createAdmission({ recorder: recorder() }));

    expect(await openTerminal({ "x-paseo-local-token": TOKEN }, "GET")).toMatchObject({
      status: 426,
    });
    expect(await openTerminal({ ...upgradeHeaders, upgrade: "paseo-ndjson/1" })).toMatchObject({
      status: 400,
    });
  });

  test("detaches open channels and removes its socket when it stops", async () => {
    const recorded = recorder();
    await start(createAdmission({ recorder: recorded }));
    const opened = await openTerminal(upgradeHeaders);
    if (opened.kind !== "upgraded") throw new Error("expected an upgrade");

    await plane?.close();
    plane = null;
    await waitUntil(() => recorded.detaches === 1, "detach when the plane stops");

    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
