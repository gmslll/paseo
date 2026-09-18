import { describe, expect, test } from "vitest";

import {
  NdjsonLineDecoder,
  NdjsonLineTooLargeError,
  classifyControlPlaneLine,
  decodeBase64,
  encodeBase64,
  encodeControlPlaneBinaryLine,
  encodeControlPlaneCloseLine,
} from "./local-planes.js";

const encoder = new TextEncoder();

describe("control plane NDJSON framing", () => {
  test("reassembles lines split across chunks, including a multi-byte character", () => {
    const decoder = new NdjsonLineDecoder({ maxLineBytes: 64 });
    const bytes = encoder.encode('{"type":"hello"}\n{"text":"naïve ✓"}\r\n{"type":"ping"}');

    const lines = [
      ...decoder.push(bytes.subarray(0, 5)),
      ...decoder.push(bytes.subarray(5, 27)),
      ...decoder.push(bytes.subarray(27)),
      ...decoder.push(encoder.encode("\n")),
    ];

    expect(lines).toEqual(['{"type":"hello"}', '{"text":"naïve ✓"}', '{"type":"ping"}']);
  });

  test("refuses a line over the limit even before its newline arrives", () => {
    const decoder = new NdjsonLineDecoder({ maxLineBytes: 8 });

    expect(() => decoder.push(encoder.encode("123456789"))).toThrow(NdjsonLineTooLargeError);
    expect(decoder.push(encoder.encode("ok\n"))).toEqual(["ok"]);
  });

  test("encodes base64 like the platform encoder for every padding length", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 255]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256);
      const expected = Buffer.from(bytes).toString("base64");

      expect(encodeBase64(bytes)).toBe(expected);
      expect([...decodeBase64(expected)]).toEqual([...bytes]);
    }
    expect(() => decodeBase64("abc")).toThrow();
    expect(() => decodeBase64("ab!=")).toThrow();
  });

  test("classifies text, binary, and close lines without touching ordinary messages", () => {
    const frame = Uint8Array.from([0x01, 0x00, 0xff, 0x7f]);

    expect(classifyControlPlaneLine('{"type":"session","message":{"type":"ping"}}')).toEqual({
      kind: "text",
      text: '{"type":"session","message":{"type":"ping"}}',
    });
    expect(classifyControlPlaneLine(encodeControlPlaneBinaryLine(frame))).toEqual({
      kind: "binary",
      bytes: frame,
    });
    expect(
      classifyControlPlaneLine(encodeControlPlaneCloseLine({ code: 4001, reason: "auth failed" })),
    ).toEqual({ kind: "close", code: 4001, reason: "auth failed" });
    expect(() => classifyControlPlaneLine('{"type":"paseo.close","code":1}')).toThrow();
  });
});
