import { randomBytes } from "node:crypto";

import { z } from "zod";

import {
  COLLAB_STREAM_LIMITS,
  StreamOffsetSchema,
} from "@getpaseo/protocol/enterprise-collaboration";

import {
  parseRequestTimeout,
  requestBytes,
  requestJson,
  signNodeRequest,
  type RequestBytesInput,
  type RequestBytesResult,
  type RequestJsonInput,
} from "../node-request.js";
import type { ManagedNodeRelationship } from "../relationship-store.js";
import type { CollabRepoStore, ProducerState } from "./loro-repo-store.js";

/**
 * Carries one container's streams between the node's replica and the management plane (ADR-0032).
 *
 * The node only ever dials out: every exchange is an ordinary signed request to the plane, so a
 * node behind NAT needs nothing opened. Uploads drain the replica's pending queue; downloads resume
 * from the cursor the replica kept, which is what makes a restart continue instead of replay.
 *
 * Deliberately has no timer and no loop. Each call does one exchange and returns what happened, so
 * the behaviour under a stale epoch, a gap, or an oversized update can be tested against a real
 * plane without waiting on a scheduler.
 */

const STREAM_HEADERS = {
  producerId: "producer-id",
  producerEpoch: "producer-epoch",
  producerSeq: "producer-seq",
} as const;

const StreamReadResponseSchema = z.object({
  messages: z.array(z.object({ offset: StreamOffsetSchema, update: z.string() })),
  nextOffset: StreamOffsetSchema,
  lowerBoundOffset: StreamOffsetSchema,
  upToDate: z.boolean(),
});

const StaleEpochSchema = z.object({
  error: z.object({ code: z.literal("stale_producer_epoch"), currentEpoch: z.number().int() }),
});

/**
 * How the uplink reaches the plane. The default is the signed, CA-pinned HTTPS every other node
 * request uses; a caller supplies its own only to put the exchange somewhere a test can drive it,
 * which is the one part of this file that is not the plane's real behaviour.
 */
export interface StreamUplinkTransport {
  sendBytes(input: RequestBytesInput): Promise<RequestBytesResult>;
  readJson<T>(input: RequestJsonInput<T>): Promise<T>;
}

const HTTPS_TRANSPORT: StreamUplinkTransport = {
  sendBytes: requestBytes,
  readJson: requestJson,
};

export interface StreamUplinkOptions {
  readonly relationship: ManagedNodeRelationship;
  readonly caCertificate: string | Buffer;
  readonly containerId: string;
  readonly store: CollabRepoStore;
  readonly requestTimeoutMs?: number;
  readonly clock?: { readonly nowMs: () => number };
  readonly transport?: StreamUplinkTransport;
}

export type FlushOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "uploaded"; readonly count: number; readonly throughSeq: number }
  /** The plane fenced this producer; the epoch has been raised and the work is still queued. */
  | { readonly kind: "refenced"; readonly epoch: number }
  /** Larger than the contract allows, so no epoch will ever accept it. Left queued for the caller. */
  | { readonly kind: "too_large"; readonly producerSeq: number };

export interface PullOutcome {
  readonly applied: number;
  readonly nextOffset: string;
  readonly upToDate: boolean;
}

export class CollabStreamUplink {
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly transport: StreamUplinkTransport;

  constructor(private readonly options: StreamUplinkOptions) {
    this.timeoutMs = parseRequestTimeout(options.requestTimeoutMs);
    this.now = options.clock?.nowMs ?? (() => Date.now());
    this.transport = options.transport ?? HTTPS_TRANSPORT;
  }

  /**
   * Sends this segment's queued updates in order, stopping at the first one the plane does not
   * accept. A replay the plane already holds counts as accepted: the queue is what would otherwise
   * resend it forever.
   */
  async flushSegment(segment: string): Promise<FlushOutcome> {
    const pending = this.options.store.listPendingUpdates(segment);
    if (pending.length === 0) return { kind: "idle" };

    let uploaded = 0;
    let throughSeq = 0;
    for (const entry of pending) {
      if (entry.update.byteLength > COLLAB_STREAM_LIMITS.maxAppendBytes) {
        if (uploaded > 0) this.options.store.confirmUploaded(segment, throughSeq);
        return { kind: "too_large", producerSeq: entry.producerSeq };
      }
      const path = this.segmentPath(segment);
      const body = Buffer.from(entry.update);
      const response = await this.transport.sendBytes({
        baseUrl: this.options.relationship.managementBaseUrl,
        method: "PUT",
        path,
        body,
        caCertificate: this.options.caCertificate,
        timeoutMs: this.timeoutMs,
        headers: {
          ...this.signedHeaders("PUT", path, body),
          [STREAM_HEADERS.producerId]: this.producerId(),
          [STREAM_HEADERS.producerEpoch]: String(entry.producerEpoch),
          [STREAM_HEADERS.producerSeq]: String(entry.producerSeq),
        },
      });

      // 201 stored it, 204 says the plane already had it. Both mean stop resending it.
      if (response.status === 201 || response.status === 204) {
        uploaded += 1;
        throughSeq = entry.producerSeq;
        continue;
      }
      if (uploaded > 0) this.options.store.confirmUploaded(segment, throughSeq);
      if (response.status === 403) return this.refence(segment, response.body);
      // A gap means the plane's idea of this producer's sequence is not ours, and the only thing
      // that resets both is a new epoch, which renumbers what is still queued from 1.
      if (response.status === 409) return this.refence(segment, null);
      if (response.status === 413) return { kind: "too_large", producerSeq: entry.producerSeq };
      throw new Error(`append refused with status ${response.status}`);
    }

    this.options.store.confirmUploaded(segment, throughSeq);
    return { kind: "uploaded", count: uploaded, throughSeq };
  }

  /**
   * Reads whatever the plane has past this segment's cursor and applies it to the replica.
   *
   * `live` holds the request open until something arrives, which is how a node follows a segment
   * without polling it. ADR-0032 gives single-stream reads long-poll only; sse there is not
   * implemented, and the multiplexed route is for clients.
   */
  async pullSegment(segment: string, input: { live?: boolean } = {}): Promise<PullOutcome> {
    const cursor = this.options.store.remoteCursor(segment);
    const query = new URLSearchParams();
    if (cursor) query.set("offset", cursor);
    if (input.live) query.set("live", "long-poll");
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    // The plane verifies the signature over `url.pathname`, so the query string is sent but never
    // signed. Signing the whole thing would fail every read that carries an offset.
    const pathname = this.segmentPath(segment);

    const result = await this.transport.readJson({
      baseUrl: this.options.relationship.managementBaseUrl,
      method: "GET",
      path: `${pathname}${suffix}`,
      body: "",
      caCertificate: this.options.caCertificate,
      timeoutMs: this.timeoutMs,
      headers: this.signedHeaders("GET", pathname, ""),
      schema: StreamReadResponseSchema,
    });

    this.options.store.applyRemoteUpdates(
      segment,
      result.messages.map((message) => ({
        offset: message.offset,
        update: new Uint8Array(Buffer.from(message.update, "base64")),
      })),
      result.nextOffset,
    );
    return {
      applied: result.messages.length,
      nextOffset: result.nextOffset,
      upToDate: result.upToDate,
    };
  }

  /**
   * Opens this segment's producer epoch. Every local write requires one — the replica refuses an
   * enqueue without it — and the epoch rises per call, so a queue that survived a restart cannot
   * collide with what the plane already holds under the old one.
   *
   * Here rather than on the caller because the producer identity belongs to this uplink. A second
   * copy of it elsewhere is a fencing bug that surfaces only as a refused append.
   */
  beginEpoch(segment: string): ProducerState {
    return this.options.store.beginProducerEpoch(segment, this.producerId());
  }

  /** One producer identity per node per container, so the plane's fencing is per node. */
  private producerId(): string {
    return `nod:${this.options.relationship.node.nodeId}`;
  }

  private segmentPath(segment: string): string {
    return `/v1/ds/${this.options.containerId}/${encodeURIComponent(segment)}`;
  }

  /**
   * Raises the local epoch past whatever the plane is holding. The replica renumbers the queue from
   * 1, so the next flush opens the new epoch on a sequence the plane will accept.
   */
  private refence(segment: string, body: unknown): FlushOutcome {
    const stale = StaleEpochSchema.safeParse(body);
    const planeEpoch = stale.success ? stale.data.error.currentEpoch : 0;
    let state = this.options.store.beginProducerEpoch(segment, this.producerId());
    while (state.epoch <= planeEpoch) {
      state = this.options.store.beginProducerEpoch(segment, this.producerId());
    }
    return { kind: "refenced", epoch: state.epoch };
  }

  private signedHeaders(
    method: string,
    path: string,
    body: string | Buffer,
  ): Record<string, string> {
    const timestampMs = this.now();
    const nonce = randomBytes(18).toString("base64url");
    return {
      "x-paseo-node-id": this.options.relationship.node.nodeId,
      "x-paseo-node-timestamp": String(timestampMs),
      "x-paseo-node-nonce": nonce,
      "x-paseo-node-signature": signNodeRequest(this.options.relationship.nodePrivateKeyPem, {
        method,
        path,
        timestampMs,
        nonce,
        body,
      }),
    };
  }
}
