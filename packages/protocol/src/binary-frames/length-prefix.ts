// Stream framing for local plane sockets (ADR-0038): a big-endian u32 byte length, then the frame.

export const LENGTH_PREFIX_BYTES = 4;
const MAX_LENGTH_PREFIX_VALUE = 0xffff_ffff;

export class LengthPrefixedFrameTooLargeError extends Error {
  constructor(
    public readonly frameBytes: number,
    public readonly maxFrameBytes: number,
  ) {
    super(`length-prefixed frame of ${frameBytes} bytes exceeds ${maxFrameBytes} bytes`);
    this.name = "LengthPrefixedFrameTooLargeError";
  }
}

export function encodeLengthPrefixedFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_LENGTH_PREFIX_VALUE) {
    throw new LengthPrefixedFrameTooLargeError(payload.byteLength, MAX_LENGTH_PREFIX_VALUE);
  }
  const bytes = new Uint8Array(LENGTH_PREFIX_BYTES + payload.byteLength);
  new DataView(bytes.buffer).setUint32(0, payload.byteLength, false);
  bytes.set(payload, LENGTH_PREFIX_BYTES);
  return bytes;
}

export interface LengthPrefixedFrameDecoderOptions {
  maxFrameBytes: number;
}

/**
 * Reassembles frames from arbitrary stream chunks. Pushed chunks are retained by reference until
 * consumed, so callers must not mutate them. An oversized length throws and clears the buffer; the
 * stream cannot resynchronize and the connection must close.
 */
export class LengthPrefixedFrameDecoder {
  private readonly maxFrameBytes: number;
  private chunks: Uint8Array[] = [];
  private buffered = 0;

  constructor(options: LengthPrefixedFrameDecoderOptions) {
    this.maxFrameBytes = options.maxFrameBytes;
  }

  get bufferedBytes(): number {
    return this.buffered;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.byteLength;
    }
    const frames: Uint8Array[] = [];
    while (this.buffered >= LENGTH_PREFIX_BYTES) {
      const header = this.read(LENGTH_PREFIX_BYTES, false);
      const frameBytes = new DataView(header.buffer).getUint32(0, false);
      if (frameBytes > this.maxFrameBytes) {
        this.chunks = [];
        this.buffered = 0;
        throw new LengthPrefixedFrameTooLargeError(frameBytes, this.maxFrameBytes);
      }
      if (this.buffered < LENGTH_PREFIX_BYTES + frameBytes) {
        break;
      }
      this.read(LENGTH_PREFIX_BYTES, true);
      frames.push(this.read(frameBytes, true));
    }
    return frames;
  }

  private read(byteLength: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(byteLength);
    let written = 0;
    let index = 0;
    while (written < byteLength) {
      const chunk = this.chunks[index];
      const take = Math.min(chunk.byteLength, byteLength - written);
      out.set(chunk.subarray(0, take), written);
      written += take;
      if (!consume) {
        index += 1;
      } else if (take === chunk.byteLength) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(take);
      }
    }
    if (consume) {
      this.buffered -= byteLength;
    }
    return out;
  }
}
