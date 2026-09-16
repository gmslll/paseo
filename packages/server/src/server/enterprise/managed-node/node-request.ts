import { createHash, sign, type KeyObject } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";

import { z } from "zod";

import { normalizeManagementOrigin } from "./relationship-store.js";

/**
 * Signed HTTPS requests to the management plane.
 *
 * Extracted from management-client.ts unchanged, so the collaboration uplink (ADR-0032) reaches the
 * data plane with the same signature, the same TLS pinning, and the same response bounds as every
 * other node request, rather than growing a second way of talking to the plane that would drift.
 *
 * `ManagementPlaneRequestError` lives here now but is re-exported by management-client.ts: callers
 * outside this directory import it from there, and moving where they import it from is not part of
 * this change.
 */

export const MAX_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const SIGNATURE_MAX_SKEW_MS = 60_000;

const ErrorResponseSchema = z
  .object({
    error: z.object({ code: z.string().min(1), message: z.string().min(1).max(512) }).strict(),
  })
  .strict();

export class ManagementPlaneRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ManagementPlaneRequestError";
  }
}

export function parseRequestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > SIGNATURE_MAX_SKEW_MS) {
    throw new Error("invalid management request timeout");
  }
  return timeout;
}

export function signNodeRequest(
  privateKey: KeyObject | string | Buffer,
  input: {
    readonly method: string;
    readonly path: string;
    readonly timestampMs: number;
    readonly nonce: string;
    // Buffer as well as string: a data-plane append carries Loro update bytes, which do not survive
    // being decoded as UTF-8 to be signed.
    readonly body: string | Buffer;
  },
): string {
  const digest = createHash("sha256").update(input.body).digest("base64url");
  const message = Buffer.from(
    [
      "paseo-node-request-v1",
      input.method.toUpperCase(),
      input.path,
      String(input.timestampMs),
      input.nonce,
      digest,
    ].join("\n"),
  );
  return sign(null, message, privateKey).toString("base64url");
}

export interface RequestJsonInput<T> {
  readonly baseUrl: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly body: string;
  readonly caCertificate: string | Buffer;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly schema: z.ZodType<T>;
}

export function requestJson<T>(input: RequestJsonInput<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const target = new URL(input.path, `${normalizeManagementOrigin(input.baseUrl)}/`);
    const request = httpsRequest(
      target,
      {
        method: input.method,
        ca: input.caCertificate,
        rejectUnauthorized: true,
        timeout: input.timeoutMs,
        headers: {
          accept: "application/json",
          ...(input.body.length > 0
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(input.body)),
              }
            : {}),
          ...input.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("management response too large"));
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", reject);
        response.once("end", () => {
          try {
            const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              const failure = ErrorResponseSchema.safeParse(decoded);
              throw new ManagementPlaneRequestError(
                status,
                failure.success ? failure.data.error.code : "invalid_response",
                failure.success ? failure.data.error.message : "management request failed",
              );
            }
            resolve(input.schema.parse(decoded));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("management request timed out")));
    request.once("error", reject);
    if (input.body.length > 0) request.write(input.body);
    request.end();
  });
}

export interface RequestStreamInput {
  readonly baseUrl: string;
  readonly path: string;
  readonly caCertificate: string | Buffer;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

export function requestStream(input: RequestStreamInput): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const target = new URL(input.path, `${normalizeManagementOrigin(input.baseUrl)}/`);
    const request = httpsRequest(
      target,
      {
        method: "GET",
        ca: input.caCertificate,
        rejectUnauthorized: true,
        timeout: input.timeoutMs,
        headers: { accept: "application/octet-stream", ...input.headers },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          // The timeout covers connecting and the response head; the installer bounds the body.
          request.setTimeout(0);
          resolve(response);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("management response too large"));
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", reject);
        response.once("end", () => {
          const failure = ErrorResponseSchema.safeParse(
            safeJsonParse(Buffer.concat(chunks).toString("utf8")),
          );
          reject(
            new ManagementPlaneRequestError(
              status,
              failure.success ? failure.data.error.code : "invalid_response",
              failure.success ? failure.data.error.message : "management request failed",
            ),
          );
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("management request timed out")));
    request.once("error", reject);
    request.end();
  });
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
