import { z } from "zod";
import { PrincipalContextSchema } from "@getpaseo/protocol/messages";

// Delegation authority (ADR-0043). The authority is resolved from the requester Agent when an
// operation is accepted and stored with it, so a delivery after a restart rechecks the same
// Principal instead of whatever Session happens to be connected.
export const FrozenOrchestrationAuthoritySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("standalone") }).strict(),
  z.object({ mode: z.literal("enterprise"), principal: PrincipalContextSchema }).strict(),
]);

export type FrozenOrchestrationAuthority = z.infer<typeof FrozenOrchestrationAuthoritySchema>;

export type OrchestrationTarget =
  | { kind: "create"; workspaceId: string }
  | { kind: "prompt"; agentId: string };

export interface OrchestrationAuthority {
  /** Throws `OrchestrationError` with `AUTHORIZATION_DENIED` when any target is out of reach. */
  authorizeAccept(input: {
    requesterAgentId: string;
    targets: readonly OrchestrationTarget[];
  }): Promise<FrozenOrchestrationAuthority>;
  isCurrent(authority: FrozenOrchestrationAuthority): boolean;
}

export const standaloneOrchestrationAuthority: OrchestrationAuthority = {
  async authorizeAccept() {
    return { mode: "standalone" };
  },
  isCurrent(authority) {
    return authority.mode === "standalone";
  },
};
