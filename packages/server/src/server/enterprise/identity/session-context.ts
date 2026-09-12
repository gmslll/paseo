import type { NodeContext, PrincipalContext } from "@getpaseo/protocol/messages";

export interface EnterpriseSessionContext {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly sessionBindingGeneration: string;
}
