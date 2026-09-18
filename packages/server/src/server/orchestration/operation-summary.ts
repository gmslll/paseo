import type { OrchestrationOperationSummary } from "@getpaseo/protocol/messages";

import type { OperationRecord } from "./operation-store.js";

function isoTime(value: number): string {
  return new Date(value).toISOString();
}

export function toOrchestrationOperationSummary(
  operation: OperationRecord,
): OrchestrationOperationSummary {
  return {
    requesterAgentId: operation.requesterAgentId,
    operationId: operation.operationId,
    kind: operation.kind,
    status: operation.status,
    errorCode: operation.errorCode,
    chainDepth: operation.chainDepth,
    createdAt: isoTime(operation.createdAt),
    deadlineAt: isoTime(operation.deadlineAt),
    finishedAt: operation.finishedAt === null ? null : isoTime(operation.finishedAt),
    items: operation.items.map((item) => ({
      itemIndex: item.itemIndex,
      agentId: item.targetAgentId,
      state: item.state,
      outcome: item.outcome,
      error: item.errorMessage,
    })),
  };
}
