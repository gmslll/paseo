import { z } from "zod";
import {
  ManagementPlaneRequestError,
  requestJson,
} from "./enterprise/managed-node/node-request.js";

const PasswordSessionTicketSchema = z
  .object({
    ticket: z.string().startsWith("pmt_v1."),
    endpoint: z.string().url(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PasswordSessionTicket = z.infer<typeof PasswordSessionTicketSchema>;

const PasswordSessionRequestSchema = z
  .object({
    username: z.string().trim().min(3).max(64),
    password: z.string().min(12).max(128),
    clientId: z.string().min(1).max(160),
    ttlMs: z.number().int().positive(),
  })
  .strict();
export type PasswordSessionRequest = z.infer<typeof PasswordSessionRequestSchema>;

export function parseEnterprisePasswordSessionRequest(
  body: unknown,
): PasswordSessionRequest | null {
  const parsed = PasswordSessionRequestSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** Phone clients cannot pin the management CA, so the node forwards the password exchange. */
export async function exchangeManagedNodePasswordSession(input: {
  readonly managementBaseUrl: string;
  readonly caCertificate: Buffer;
  readonly nodeId: string;
  readonly username: string;
  readonly password: string;
  readonly clientId: string;
  readonly ttlMs: number;
}): Promise<PasswordSessionTicket> {
  return requestJson({
    baseUrl: input.managementBaseUrl,
    method: "POST",
    path: "/v1/auth/password/session",
    body: JSON.stringify({
      username: input.username,
      password: input.password,
      nodeId: input.nodeId,
      clientId: input.clientId,
      ttlMs: input.ttlMs,
    }),
    caCertificate: input.caCertificate,
    timeoutMs: 10_000,
    headers: {},
    schema: PasswordSessionTicketSchema,
  });
}

export function isInvalidPasswordExchange(error: unknown): boolean {
  return error instanceof ManagementPlaneRequestError && error.status === 401;
}
