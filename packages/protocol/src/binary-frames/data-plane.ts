// Data plane frames (ADR-0038): [u8 opcode][u16 BE docId byte length][docId UTF-8][payload].
// The same bytes travel inside a length-prefixed data.sock frame or as one WebSocket binary frame.

export const DataPlaneFrameKind = {
  Hello: 0x20,
  SyncRequest: 0x21,
  Update: 0x22,
  Snapshot: 0x23,
  Presence: 0x24,
  Ack: 0x25,
  Error: 0x26,
} as const;

export type DataPlaneFrameKind = (typeof DataPlaneFrameKind)[keyof typeof DataPlaneFrameKind];

// 0x27–0x2F are reserved for later data plane kinds.
export const DATA_PLANE_OPCODE_MIN = 0x20;
export const DATA_PLANE_OPCODE_MAX = 0x2f;

const HEADER_BYTES = 3;
const MAX_DOC_ID_BYTES = 0xffff;

export interface DataPlaneFrame {
  kind: DataPlaneFrameKind;
  docId: string;
  payload: Uint8Array;
}

export function isDataPlaneOpcode(value: number): boolean {
  return value >= DATA_PLANE_OPCODE_MIN && value <= DATA_PLANE_OPCODE_MAX;
}

function isDataPlaneFrameKind(value: number): value is DataPlaneFrameKind {
  return value >= DataPlaneFrameKind.Hello && value <= DataPlaneFrameKind.Error;
}

export function encodeDataPlaneFrame(input: {
  kind: DataPlaneFrameKind;
  docId: string;
  payload?: Uint8Array;
}): Uint8Array {
  const docId = new TextEncoder().encode(input.docId);
  if (docId.byteLength === 0 || docId.byteLength > MAX_DOC_ID_BYTES) {
    throw new RangeError(`data plane docId must be 1-${MAX_DOC_ID_BYTES} UTF-8 bytes`);
  }
  const payload = input.payload ?? new Uint8Array(0);
  const bytes = new Uint8Array(HEADER_BYTES + docId.byteLength + payload.byteLength);
  bytes[0] = input.kind;
  new DataView(bytes.buffer).setUint16(1, docId.byteLength, false);
  bytes.set(docId, HEADER_BYTES);
  bytes.set(payload, HEADER_BYTES + docId.byteLength);
  return bytes;
}

export function decodeDataPlaneFrame(bytes: Uint8Array): DataPlaneFrame | null {
  if (bytes.byteLength < HEADER_BYTES) {
    return null;
  }
  const kind = bytes[0];
  if (!isDataPlaneFrameKind(kind)) {
    return null;
  }
  const docIdBytes = new DataView(bytes.buffer, bytes.byteOffset + 1, 2).getUint16(0, false);
  const docIdEnd = HEADER_BYTES + docIdBytes;
  if (docIdBytes === 0 || bytes.byteLength < docIdEnd) {
    return null;
  }
  const docId = decodeUtf8(bytes.subarray(HEADER_BYTES, docIdEnd));
  if (docId === null) {
    return null;
  }
  return { kind, docId, payload: bytes.subarray(docIdEnd) };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
