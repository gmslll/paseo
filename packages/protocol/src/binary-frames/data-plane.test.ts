import { describe, expect, it } from "vitest";

import {
  DATA_PLANE_OPCODE_MAX,
  DATA_PLANE_OPCODE_MIN,
  DataPlaneFrameKind,
  FileTransferOpcode,
  LengthPrefixedFrameDecoder,
  TerminalStreamOpcode,
  decodeBinaryFrame,
  decodeDataPlaneFrame,
  encodeDataPlaneFrame,
  encodeLengthPrefixedFrame,
  isDataPlaneOpcode,
} from "./index.js";

describe("data plane binary frames", () => {
  it("encodes opcode, big-endian docId length, docId, and payload", () => {
    const docId = "cws_0123456789abcdef:s:agent-1";
    const payload = new Uint8Array([1, 2, 3]);
    const encoded = encodeDataPlaneFrame({ kind: DataPlaneFrameKind.Update, docId, payload });

    expect(encoded[0]).toBe(0x22);
    expect((encoded[1] << 8) | encoded[2]).toBe(docId.length);
    expect(new TextDecoder().decode(encoded.subarray(3, 3 + docId.length))).toBe(docId);
    expect(decodeDataPlaneFrame(encoded)).toEqual({
      kind: DataPlaneFrameKind.Update,
      docId,
      payload,
    });
  });

  it("round-trips a multi-byte docId and an empty payload", () => {
    const encoded = encodeDataPlaneFrame({ kind: DataPlaneFrameKind.Hello, docId: "工作区:meta" });

    expect(decodeDataPlaneFrame(encoded)).toEqual({
      kind: DataPlaneFrameKind.Hello,
      docId: "工作区:meta",
      payload: new Uint8Array(0),
    });
  });

  it("rejects an empty or oversized docId when encoding", () => {
    expect(() => encodeDataPlaneFrame({ kind: DataPlaneFrameKind.Ack, docId: "" })).toThrow(
      RangeError,
    );
    expect(() =>
      encodeDataPlaneFrame({ kind: DataPlaneFrameKind.Ack, docId: "x".repeat(0x10000) }),
    ).toThrow(RangeError);
  });

  it.each([
    ["truncated header", new Uint8Array([0x22, 0])],
    ["truncated docId", new Uint8Array([0x22, 0, 4, 0x61])],
    ["empty docId", new Uint8Array([0x22, 0, 0])],
    ["invalid UTF-8 docId", new Uint8Array([0x22, 0, 1, 0xff])],
    ["reserved opcode", new Uint8Array([0x2f, 0, 1, 0x61])],
  ])("returns null for a %s", (_label, bytes) => {
    expect(decodeDataPlaneFrame(bytes)).toBeNull();
  });

  it("uses an opcode range that no existing binary frame claims", () => {
    const existing = [...Object.values(TerminalStreamOpcode), ...Object.values(FileTransferOpcode)];
    for (const opcode of existing) {
      expect(isDataPlaneOpcode(opcode)).toBe(false);
    }
    expect(isDataPlaneOpcode(DATA_PLANE_OPCODE_MIN)).toBe(true);
    expect(isDataPlaneOpcode(DATA_PLANE_OPCODE_MAX)).toBe(true);

    const frame = encodeDataPlaneFrame({ kind: DataPlaneFrameKind.Snapshot, docId: "meta" });
    expect(decodeBinaryFrame(frame)).toBeNull();
  });

  it("travels inside length-prefixed socket frames", () => {
    const frames = [
      encodeDataPlaneFrame({ kind: DataPlaneFrameKind.SyncRequest, docId: "wf" }),
      encodeDataPlaneFrame({
        kind: DataPlaneFrameKind.Update,
        docId: "wf",
        payload: new Uint8Array([9, 9]),
      }),
    ];
    const stream = new Uint8Array(frames.reduce((sum, frame) => sum + 4 + frame.byteLength, 0));
    let offset = 0;
    for (const frame of frames) {
      const prefixed = encodeLengthPrefixedFrame(frame);
      stream.set(prefixed, offset);
      offset += prefixed.byteLength;
    }
    const decoder = new LengthPrefixedFrameDecoder({ maxFrameBytes: 64 });

    const decoded = [
      ...decoder.push(stream.subarray(0, 6)),
      ...decoder.push(stream.subarray(6)),
    ].map(decodeDataPlaneFrame);

    expect(decoded).toEqual([
      { kind: DataPlaneFrameKind.SyncRequest, docId: "wf", payload: new Uint8Array(0) },
      { kind: DataPlaneFrameKind.Update, docId: "wf", payload: new Uint8Array([9, 9]) },
    ]);
  });
});
