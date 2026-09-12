import {
  NodeContextSchema,
  PrincipalContextSchema,
  type NodeContext,
  type PrincipalContext,
} from "@getpaseo/protocol/messages";
export interface EnterpriseSessionContext {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly sessionBindingGeneration: string;
}
const handleBrand = Symbol("EnterpriseAgentContextHandle");
export interface EnterpriseAgentContextHandle {
  readonly [handleBrand]: "EnterpriseAgentContextHandle";
  readonly agentId: string;
  readonly context: EnterpriseSessionContext;
  isCurrent(): boolean;
}
export interface EnterpriseAgentSessionContextRegistry {
  bind(input: { agentId: string; context: EnterpriseSessionContext }): EnterpriseAgentContextHandle;
  resolve(agentId: string): EnterpriseAgentContextHandle | null;
  isCurrentHandle(handle: EnterpriseAgentContextHandle): boolean;
  release(input: { agentId: string; sessionBindingGeneration: string }): void;
  releaseSession(generation: string): void;
}
interface Entry {
  agentId: string;
  context: EnterpriseSessionContext;
  released: boolean;
  handle: EnterpriseAgentContextHandle;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export function normalizeEnterpriseSessionContext(
  input: EnterpriseSessionContext,
): EnterpriseSessionContext {
  if (!input.sessionBindingGeneration) throw new Error("Invalid generation");
  const principal = PrincipalContextSchema.parse(input.principal);
  const node = NodeContextSchema.parse(input.node);
  return deepFreeze(
    Object.freeze({
      principal: Object.freeze({
        ...principal,
        // oxlint-disable-next-line no-map-spread -- copy before recursive freeze
        grants: principal.grants.map((g) => ({ ...g })),
      }),
      node: Object.freeze({ ...node }),
      sessionBindingGeneration: input.sessionBindingGeneration,
    }),
  ) as unknown as EnterpriseSessionContext;
}
export function createEnterpriseAgentSessionContextRegistry(): EnterpriseAgentSessionContextRegistry {
  const agents = new Map<string, Entry>();
  const handles = new WeakMap<object, Entry>();
  const make = (entry: Entry): EnterpriseAgentContextHandle =>
    Object.freeze({
      [handleBrand]: "EnterpriseAgentContextHandle" as const,
      agentId: entry.agentId,
      context: entry.context,
      isCurrent: () => !entry.released && agents.get(entry.agentId) === entry,
    });
  return {
    bind(input) {
      if (!input.agentId) throw new Error("Invalid agent id");
      const prior = agents.get(input.agentId);
      if (prior) prior.released = true;
      const entry = {
        agentId: input.agentId,
        context: normalizeEnterpriseSessionContext(input.context),
        released: false,
        handle: undefined as unknown as EnterpriseAgentContextHandle,
      };
      entry.handle = make(entry);
      agents.set(entry.agentId, entry);
      handles.set(entry.handle, entry);
      return entry.handle;
    },
    resolve(agentId) {
      const entry = agents.get(agentId);
      return entry && !entry.released ? entry.handle : null;
    },
    isCurrentHandle(handle) {
      const entry = handles.get(handle as object);
      return !!entry && !entry.released && agents.get(entry.agentId) === entry;
    },
    release(input) {
      const entry = agents.get(input.agentId);
      if (entry?.context.sessionBindingGeneration === input.sessionBindingGeneration) {
        entry.released = true;
        agents.delete(input.agentId);
      }
    },
    releaseSession(generation) {
      for (const [agentId, entry] of agents)
        if (entry.context.sessionBindingGeneration === generation) {
          entry.released = true;
          agents.delete(agentId);
        }
    },
  };
}
export function isEnterpriseAgentContextCurrentForSession(
  handle: EnterpriseAgentContextHandle | null,
  context: EnterpriseSessionContext | undefined,
): boolean {
  return (
    !!handle &&
    !!context &&
    handle.isCurrent() &&
    handle.context.sessionBindingGeneration === context.sessionBindingGeneration &&
    handle.context.principal.organizationId === context.principal.organizationId &&
    handle.context.principal.principalId === context.principal.principalId &&
    handle.context.principal.principalType === context.principal.principalType &&
    handle.context.principal.credentialId === context.principal.credentialId &&
    handle.context.principal.grantVersion === context.principal.grantVersion &&
    handle.context.node.nodeId === context.node.nodeId &&
    handle.context.node.paseoServerId === context.node.paseoServerId &&
    handle.context.node.mode === context.node.mode
  );
}
