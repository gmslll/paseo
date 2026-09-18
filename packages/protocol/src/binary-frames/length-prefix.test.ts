import { describe, expect, it } from "vitest";

import {
  LENGTH_PREFIX_BYTES,
  LengthPrefixedFrameDecoder,
  LengthPrefixedFrameTooLargeError,
  encodeLengthPrefixedFrame,
} from "./index.js";

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("length-prefixed frames", () => {
  it("writes a big-endian u32 length before the payload", () => {
    const encoded = encodeLengthPrefixedFrame(new Uint8Array([7, 8, 9]));

    expect(Array.from(encoded)).toEqual([0, 0, 0, 3, 7, 8, 9]);
  });

  it("reassembles frames split at every byte boundary", () => {
    const first = new TextEncoder().encode("hello");
    const second = new Uint8Array(300).map((_, index) => index % 251);
    const stream = concat([encodeLengthPrefixedFrame(first), encodeLengthPrefixedFrame(second)]);
    const decoder = new LengthPrefixedFrameDecoder({ maxFrameBytes: 1024 });

    const frames: Uint8Array[] = [];
    for (let index = 0; index < stream.byteLength; index += 1) {
      frames.push(...decoder.push(stream.subarray(index, index + 1)));
    }

    expect(frames).toEqual([first, second]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("returns every complete frame in one chunk and keeps the partial remainder", () => {
    const decoder = new LengthPrefixedFrameDecoder({ maxFrameBytes: 16 });
    const partial = encodeLengthPrefixedFrame(new Uint8Array([4, 5, 6]));
    const chunk = concat([
      encodeLengthPrefixedFrame(new Uint8Array([1])),
      encodeLengthPrefixedFrame(new Uint8Array(0)),
      partial.subarray(0, 5),
    ]);

    expect(decoder.push(chunk)).toEqual([new Uint8Array([1]), new Uint8Array(0)]);
    expect(decoder.bufferedBytes).toBe(5);
    expect(decoder.push(partial.subarray(5))).toEqual([new Uint8Array([4, 5, 6])]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("rejects an oversized length before buffering its body and clears the stream", () => {
    const decoder = new LengthPrefixedFrameDecoder({ maxFrameBytes: 8 });
    const header = new Uint8Array(LENGTH_PREFIX_BYTES);
    new DataView(header.buffer).setUint32(0, 9, false);

    let caught: unknown;
    try {
      decoder.push(header);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LengthPrefixedFrameTooLargeError);
    expect(caught).toMatchObject({ frameBytes: 9, maxFrameBytes: 8 });
    expect(decoder.bufferedBytes).toBe(0);
  });
});
