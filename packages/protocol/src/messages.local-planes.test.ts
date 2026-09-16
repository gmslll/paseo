import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  LocalPlaneAttachTokenCreateRequestSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const response = {
  type: "local_plane.attach_token.create.response",
  payload: {
    requestId: "r1",
    plane: "terminal",
    token: "6Qm1Yl0Zt2c",
    expiresAt: "2026-09-16T08:01:00.000Z",
    endpoint: { transport: "unix", path: "/home/me/.paseo/run/terminal.sock", protocolVersion: 1 },
  },
};

describe("local plane attach token RPC", () => {
  test("the daemon session accepts attach token requests for attachable planes only", () => {
    const request = {
      type: "local_plane.attach_token.create.request",
      requestId: "r1",
      plane: "terminal",
    };

    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    expect(
      SessionInboundMessageSchema.parse({ ...request, plane: "data", requestId: "r2" }),
    ).toMatchObject({ plane: "data" });
    for (const plane of ["control", "probe", "websocket"]) {
      expect(
        LocalPlaneAttachTokenCreateRequestSchema.safeParse({ ...request, plane }).success,
      ).toBe(false);
    }
  });

  test("clients parse the token, its expiry, and the plane endpoint", () => {
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
    expect(
      SessionOutboundMessageSchema.safeParse({
        ...response,
        payload: { ...response.payload, token: "" },
      }).success,
    ).toBe(false);
  });

  test("an older client reads the token without knowing later payload fields", () => {
    const LegacySchema = z.object({
      payload: z.object({ token: z.string(), expiresAt: z.string() }),
    });

    expect(
      LegacySchema.parse({
        ...response,
        payload: { ...response.payload, attempt: 2, rotatesAt: "2026-09-16T08:02:00.000Z" },
      }),
    ).toEqual({ payload: { token: "6Qm1Yl0Zt2c", expiresAt: "2026-09-16T08:01:00.000Z" } });
  });
});
