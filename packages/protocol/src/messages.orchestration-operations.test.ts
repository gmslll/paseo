import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  OrchestrationOperationGetRequestSchema,
  OrchestrationOperationListRequestSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const operation = {
  requesterAgentId: "agent-parent",
  operationId: "fan-out",
  kind: "agent_create_many",
  status: "running",
  errorCode: null,
  chainDepth: 1,
  createdAt: "2026-09-16T08:00:00.000Z",
  deadlineAt: "2026-09-17T08:00:00.000Z",
  finishedAt: null,
  items: [
    { itemIndex: 0, agentId: "agent-a", state: "settled", outcome: "finished", error: null },
    { itemIndex: 1, agentId: "agent-b", state: "running", outcome: null, error: null },
  ],
};

describe("orchestration operation RPCs", () => {
  test("the daemon session accepts operation list, get, and cancel requests", () => {
    const list = { type: "orchestration.operation.list.request", requestId: "r1", limit: 20 };
    const get = {
      type: "orchestration.operation.get.request",
      requestId: "r2",
      requesterAgentId: "agent-parent",
      operationId: "fan-out",
    };
    const cancel = { ...get, type: "orchestration.operation.cancel.request", requestId: "r3" };

    expect(SessionInboundMessageSchema.parse(list)).toEqual(list);
    expect(SessionInboundMessageSchema.parse(get)).toEqual(get);
    expect(SessionInboundMessageSchema.parse(cancel)).toEqual(cancel);
    expect(
      OrchestrationOperationGetRequestSchema.safeParse({ ...get, operationId: undefined }).success,
    ).toBe(false);
    expect(OrchestrationOperationListRequestSchema.safeParse({ ...list, limit: 201 }).success).toBe(
      false,
    );
  });

  test("clients parse operation responses, including an operation that does not exist", () => {
    const list = {
      type: "orchestration.operation.list.response",
      payload: { requestId: "r1", operations: [operation] },
    };
    const missing = {
      type: "orchestration.operation.get.response",
      payload: { requestId: "r2", operation: null },
    };
    const canceled = {
      type: "orchestration.operation.cancel.response",
      payload: { requestId: "r3", operation: { ...operation, status: "canceled" } },
    };

    expect(SessionOutboundMessageSchema.parse(list)).toEqual(list);
    expect(SessionOutboundMessageSchema.parse(missing)).toEqual(missing);
    expect(SessionOutboundMessageSchema.parse(canceled)).toEqual(canceled);
  });

  test("an older client parses states and fields a newer daemon adds", () => {
    const LegacySummarySchema = z.object({
      operationId: z.string(),
      status: z.string(),
      items: z.array(z.object({ agentId: z.string(), outcome: z.string().nullable() })),
    });
    const newer = {
      ...operation,
      status: "paused",
      priority: "high",
      items: [{ ...operation.items[0], outcome: "handed_off", reviewer: "agent-c" }],
    };

    expect(LegacySummarySchema.parse(newer)).toEqual({
      operationId: "fan-out",
      status: "paused",
      items: [{ agentId: "agent-a", outcome: "handed_off" }],
    });
  });
});
