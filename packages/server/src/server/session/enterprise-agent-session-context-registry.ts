import type { NodeContext, PrincipalContext } from "@getpaseo/protocol/messages";

/**
 * The authenticated context attached to one logical Session. The identity
 * package owns the admission object; this structural port keeps the Session
 * package independent from the admission wiring.
 */
export interface EnterpriseSessionContext {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly sessionBindingGeneration: string;
}

export interface EnterpriseAgentContextHandle {
  readonly agentId: string;
  readonly context: EnterpriseSessionContext;
  isCurrent(): boolean;
}

export interface EnterpriseAgentSessionContextRegistry {
  bind(input: { agentId: string; context: EnterpriseSessionContext }): EnterpriseAgentContextHandle;
  resolve(agentId: string): EnterpriseAgentContextHandle | null;
  release(input: { agentId: string; sessionBindingGeneration: string }): void;
  releaseSession(sessionBindingGeneration: string): void;
}

interface BindingRecord {
  readonly agentId: string;
  readonly context: EnterpriseSessionContext;
  released: boolean;
}

/**
 * In-memory registry shared by Session admission and agent tool hosts.
 *
 * A binding is replaced atomically when an agent is claimed by a newer logical
 * Session. Releases are conditional on the binding generation, so cleanup of
 * an old Session cannot remove the newer claim. Handles intentionally expose
 * only an equality-style liveness check; callers must not persist or infer
 * ordering from sessionBindingGeneration.
 */
export function createEnterpriseAgentSessionContextRegistry(): EnterpriseAgentSessionContextRegistry {
  const bindings = new Map<string, BindingRecord>();

  function isCurrent(record: BindingRecord): boolean {
    return !record.released && bindings.get(record.agentId) === record;
  }

  function makeHandle(record: BindingRecord): EnterpriseAgentContextHandle {
    return Object.freeze({
      agentId: record.agentId,
      context: record.context,
      isCurrent: () => isCurrent(record),
    });
  }

  return {
    bind(input) {
      const previous = bindings.get(input.agentId);
      if (previous) previous.released = true;
      const record: BindingRecord = {
        agentId: input.agentId,
        context: input.context,
        released: false,
      };
      bindings.set(input.agentId, record);
      return makeHandle(record);
    },

    resolve(agentId) {
      const record = bindings.get(agentId);
      return record && isCurrent(record) ? makeHandle(record) : null;
    },

    release(input) {
      const record = bindings.get(input.agentId);
      if (!record || record.context.sessionBindingGeneration !== input.sessionBindingGeneration) {
        return;
      }
      record.released = true;
      bindings.delete(input.agentId);
    },

    releaseSession(sessionBindingGeneration) {
      for (const [agentId, record] of bindings) {
        if (record.context.sessionBindingGeneration !== sessionBindingGeneration) continue;
        record.released = true;
        bindings.delete(agentId);
      }
    },
  };
}
