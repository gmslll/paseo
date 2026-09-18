import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import {
  COLLAB_STREAM_LIMITS,
  collabContainerKind,
  parseCollabSegment,
} from "@getpaseo/protocol/enterprise-collaboration";

import type { StreamAppendResult, StreamReadResult } from "./stream-store.js";

// The HTTP surface of the collaboration streams (ADR-0032). This module holds the parts that are
// pure: path and header parsing, the body reader, and the mapping from a store outcome to a status
// code. The route itself lives in http-server.ts next to the other routes.

export const STREAM_HEADERS = {
  producerId: "producer-id",
  producerEpoch: "producer-epoch",
  producerSeq: "producer-seq",
  nextOffset: "stream-next-offset",
  lowerBoundOffset: "stream-lower-bound-offset",
} as const;

const STREAM_PATH = /^\/v1\/ds\/([^/]+)\/(.+)$/;

export interface StreamTarget {
  containerId: string;
  segment: string;
}

/** Returns the target only when both the container and the segment are ones the contract names. */
export function parseStreamPath(path: string): StreamTarget | null {
  const match = STREAM_PATH.exec(path);
  if (!match) return null;
  const containerId = decodeURIComponent(match[1]!);
  const segment = decodeURIComponent(match[2]!);
  if (!collabContainerKind(containerId)) return null;
  return parseCollabSegment(segment) ? { containerId, segment } : null;
}

export interface ProducerHeaders {
  producerId: string;
  producerEpoch: number;
  producerSeq: number;
}

function readHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return typeof value === "string" ? value : "";
}

function readCount(headers: IncomingHttpHeaders, name: string): number | null {
  const raw = readHeader(headers, name);
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseProducerHeaders(headers: IncomingHttpHeaders): ProducerHeaders | null {
  const producerId = readHeader(headers, STREAM_HEADERS.producerId);
  const producerEpoch = readCount(headers, STREAM_HEADERS.producerEpoch);
  const producerSeq = readCount(headers, STREAM_HEADERS.producerSeq);
  if (!producerId || producerEpoch === null || producerSeq === null || producerSeq < 1) return null;
  return { producerId, producerEpoch, producerSeq };
}

/**
 * Reads the body as bytes. The shared readBody decodes UTF-8, which would corrupt a Loro update, so
 * the data plane reads its own body and enforces the contract's append limit while doing it.
 */
export async function readStreamBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > COLLAB_STREAM_LIMITS.maxAppendBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export interface StreamHttpOutcome {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

// ADR-0032 states these outcomes as status codes: a stale epoch is 403, a replay is 204, and a gap
// is 409. They are ordinary protocol answers rather than failures, so the route writes them itself
// instead of throwing into the handler's error mapping.
export function appendOutcome(result: StreamAppendResult): StreamHttpOutcome {
  switch (result.kind) {
    case "appended":
      return {
        status: 201,
        headers: { [STREAM_HEADERS.nextOffset]: result.offset },
        body: { offset: result.offset },
      };
    case "duplicate":
      return {
        status: 204,
        headers: result.offset ? { [STREAM_HEADERS.nextOffset]: result.offset } : {},
        body: null,
      };
    case "stale_epoch":
      return {
        status: 403,
        headers: {},
        body: { error: { code: "stale_producer_epoch", currentEpoch: result.currentEpoch } },
      };
    case "gap":
      return {
        status: 409,
        headers: {},
        body: { error: { code: "producer_sequence_gap", expectedSeq: result.expectedSeq } },
      };
    case "too_large":
      return {
        status: 413,
        headers: {},
        body: { error: { code: "append_too_large", limitBytes: result.limitBytes } },
      };
    case "closed":
      return { status: 409, headers: {}, body: { error: { code: "stream_closed" } } };
  }
}

export function readOutcome(result: StreamReadResult): StreamHttpOutcome {
  return {
    status: 200,
    headers: {
      [STREAM_HEADERS.nextOffset]: result.nextOffset,
      [STREAM_HEADERS.lowerBoundOffset]: result.lowerBoundOffset,
    },
    body: {
      messages: result.messages.map((message) => ({
        offset: message.offset,
        update: Buffer.from(message.update).toString("base64"),
      })),
      nextOffset: result.nextOffset,
      lowerBoundOffset: result.lowerBoundOffset,
      upToDate: result.upToDate,
    },
  };
}
