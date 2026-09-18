import type { ProductionAuthorizationRuntime } from "./production-authorization-runtime.js";
import { isCurrentProductionAuthorizationRuntime } from "./production-authorization-runtime.js";

const branded = new WeakSet<object>();
const preauthorizationBrand = Symbol("enterprise-agent-event-preauthorization");

export interface EnterpriseAgentEventPreauthorization {
  readonly [preauthorizationBrand]: never;
  allowsAgentEvent(agentId: string): boolean;
}

export function createEnterpriseAgentEventPreauthorization(input: {
  readonly authorizationRuntime: ProductionAuthorizationRuntime;
}): EnterpriseAgentEventPreauthorization | null {
  let runtime: ProductionAuthorizationRuntime;
  try {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 1 || keys[0] !== "authorizationRuntime") return null;
    const descriptor = Object.getOwnPropertyDescriptor(input, "authorizationRuntime");
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    runtime = descriptor.value;
  } catch {
    return null;
  }
  if (!isCurrentProductionAuthorizationRuntime(runtime)) return null;
  const port = Object.freeze(
    Object.assign(
      {
        allowsAgentEvent(agentId: string): boolean {
          try {
            return (
              typeof agentId === "string" &&
              isCurrentProductionAuthorizationRuntime(runtime) &&
              runtime.resourceAuthorization.preauthorizeAgentEvent(runtime.principal, agentId) &&
              isCurrentProductionAuthorizationRuntime(runtime)
            );
          } catch {
            return false;
          }
        },
      },
      { [preauthorizationBrand]: undefined as never },
    ),
  );
  branded.add(port);
  return port;
}

export function isEnterpriseAgentEventPreauthorization(
  value: unknown,
): value is EnterpriseAgentEventPreauthorization {
  return typeof value === "object" && value !== null && branded.has(value);
}
