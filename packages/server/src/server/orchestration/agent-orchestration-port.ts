import type { Logger } from "pino";
import { z } from "zod";

import { watchAgentCompletion } from "../agent/agent-completion-watch.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import type { AgentManager } from "../agent/agent-manager.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { DeliveryInjection } from "./delivery-worker.js";
import type { OrchestrationAgentPort } from "./operation-service.js";

// Everything a delegated creation needs, resolved when the operation is accepted so a creation
// retried after a restart runs with the same placement and settings.
export const DelegatedCreateSpecSchema = z.object({
  provider: z.string(),
  title: z.string(),
  initialPrompt: z.string(),
  workspaceId: z.string(),
  cwd: z.string().optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  labels: z.record(z.string(), z.string()).optional(),
  callerContext: z
    .object({
      lockedCwd: z.string().optional(),
      allowCustomCwd: z.boolean().optional(),
      childAgentDefaultLabels: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

export type DelegatedCreateSpec = z.infer<typeof DelegatedCreateSpecSchema>;

export interface AgentOrchestrationPortDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  logger: Logger;
}

export function createAgentOrchestrationPort(
  dependencies: AgentOrchestrationPortDependencies,
): OrchestrationAgentPort {
  const { agentManager, agentStorage, logger } = dependencies;
  const loadDependencies = { agentManager, agentStorage, logger };

  async function isRequesterAvailable(agentId: string): Promise<boolean> {
    const record = await agentStorage.get(agentId);
    return Boolean(record && !record.archivedAt);
  }

  async function timelineContains(injection: DeliveryInjection): Promise<boolean> {
    await ensureAgentLoaded(injection.requesterAgentId, loadDependencies);
    const timeline = agentManager.fetchTimeline(injection.requesterAgentId, {
      direction: "tail",
      limit: 0,
    });
    return timeline.rows.some(
      (row) =>
        row.item.type === "user_message" &&
        (row.item.clientMessageId === injection.messageId ||
          row.item.text.includes(injection.marker)),
    );
  }

  return {
    async agentExists(agentId) {
      return Boolean(agentManager.getAgent(agentId) ?? (await agentStorage.get(agentId)));
    },

    async createAgent({ agentId, requesterAgentId, spec, messageId }) {
      const parsed = DelegatedCreateSpecSchema.parse(spec);
      // The child inherits cwd and settings from its parent, which a restart may not have loaded.
      await ensureAgentLoaded(requesterAgentId, loadDependencies);
      await dependencies.createAgent({
        kind: "mcp",
        agentId,
        clientMessageId: messageId,
        provider: parsed.provider,
        title: parsed.title,
        initialPrompt: parsed.initialPrompt,
        // The options were the parent's provider options, stored as JSON when the operation was accepted.
        config: parsed.providerOptions
          ? { providerOptions: parsed.providerOptions as AgentSessionConfig["providerOptions"] }
          : undefined,
        cwd: parsed.cwd,
        workspaceId: parsed.workspaceId,
        thinking: parsed.thinkingOptionId,
        features: parsed.features,
        labels: parsed.labels,
        mode: parsed.modeId,
        background: true,
        notifyOnFinish: false,
        promptFailure: "throw",
        callerAgentId: requesterAgentId,
        callerContext: parsed.callerContext ?? null,
      });
    },

    async promptAgent({ agentId, prompt, sessionMode, messageId }) {
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId,
        prompt,
        sessionMode,
        messageId,
        logger,
      });
    },

    watchCompletion(input) {
      return watchAgentCompletion({ agentManager, ...input });
    },

    async lastAssistantMessage(agentId) {
      try {
        return await agentManager.getLastAssistantMessage(agentId);
      } catch (error) {
        logger.debug({ err: error, agentId }, "Delegated Agent has no readable last message");
        return null;
      }
    },

    subscribeUserMessages(listener) {
      return agentManager.subscribe(
        (event) => {
          if (event.type !== "agent_stream" || event.event.type !== "timeline") return;
          const item = event.event.item;
          if (item.type !== "user_message") return;
          listener({
            agentId: event.agentId,
            clientMessageId: item.clientMessageId,
            text: item.text,
          });
        },
        { replayState: false },
      );
    },

    async prepare(injection) {
      return (await isRequesterAvailable(injection.requesterAgentId))
        ? "ready"
        : "requester_unavailable";
    },

    async deliver(injection) {
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId: injection.requesterAgentId,
        prompt: injection.prompt,
        messageId: injection.messageId,
        activeTurnBehavior: "steer",
        unarchive: false,
        logger,
      });
    },

    async hasDelivered(injection) {
      if (!(await isRequesterAvailable(injection.requesterAgentId))) return false;
      return timelineContains(injection);
    },
  };
}
