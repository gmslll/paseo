import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentPermissionRequest, AgentStreamEvent } from "./agent-sdk-types.js";

export type AgentCompletionReason = "finished" | "errored" | "was closed";

export interface WatchAgentCompletionParams {
  agentManager: Pick<AgentManager, "subscribe" | "getAgent">;
  agentId: string;
  /** Called once per permission request. The watch continues after it. */
  onPermissionRequested: (request: AgentPermissionRequest) => void;
  /** Called at most once, after the watch has stopped. */
  onCompletion: (reason: AgentCompletionReason) => void;
}

export interface AgentCompletionWatch {
  /** False when the Agent was missing or already closed, so nothing is being watched. */
  readonly attached: boolean;
  stop(): void;
}

/**
 * Watches an Agent whose work was just dispatched until that work finishes, errors, or the Agent
 * closes. Attach it after the dispatch: an idle Agent seen before its run starts is not finished.
 */
export function watchAgentCompletion(params: WatchAgentCompletionParams): AgentCompletionWatch {
  const { agentManager, agentId } = params;
  const notifiedPermissionRequestIds = new Set<string>();
  let hasSeenRunning = false;
  let stopped = false;
  let unsubscribe: (() => void) | null = null;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
  }

  function complete(reason: AgentCompletionReason): void {
    if (stopped) return;
    stop();
    params.onCompletion(reason);
  }

  function handleAgentState(agent: ManagedAgent): void {
    for (const requestId of notifiedPermissionRequestIds) {
      if (!agent.pendingPermissions.has(requestId)) {
        notifiedPermissionRequestIds.delete(requestId);
      }
    }
    if (agent.lifecycle === "running") {
      if (agent.pendingPermissions.size === 0) {
        hasSeenRunning = true;
      }
      return;
    }
    if (agent.lifecycle === "error") {
      complete("errored");
    } else if (agent.lifecycle === "idle" && hasSeenRunning) {
      complete("finished");
    } else if (agent.lifecycle === "closed") {
      complete("was closed");
    }
  }

  function handleStreamEvent(event: AgentStreamEvent): void {
    if (event.type === "permission_requested") {
      // A permission pause is an intermediate checkpoint. Forget the run observed before it so an
      // idle state during follow-up startup cannot masquerade as the final completion.
      hasSeenRunning = false;
      if (!notifiedPermissionRequestIds.has(event.request.id)) {
        notifiedPermissionRequestIds.add(event.request.id);
        params.onPermissionRequested(event.request);
      }
      return;
    }
    if (event.type === "permission_resolved") {
      notifiedPermissionRequestIds.delete(event.requestId);
      const agent = agentManager.getAgent(agentId);
      if (agent?.pendingPermissions.size === 0) {
        hasSeenRunning = agent.lifecycle === "running";
      }
    }
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (stopped) return;
      if (event.type === "agent_state") {
        handleAgentState(event.agent);
      } else if (event.type === "agent_stream") {
        handleStreamEvent(event.event);
      }
    },
    { agentId, replayState: false },
  );

  // The lifecycle may have flipped before the subscription existed.
  const snapshot = agentManager.getAgent(agentId);
  if (!snapshot || snapshot.lifecycle === "closed") {
    stop();
    return { attached: false, stop };
  }
  if (snapshot.lifecycle === "running") {
    hasSeenRunning = true;
  } else if (snapshot.lifecycle === "error") {
    complete("errored");
  }
  return { attached: true, stop };
}
