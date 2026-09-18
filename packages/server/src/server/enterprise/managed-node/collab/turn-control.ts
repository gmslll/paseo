import {
  MachineRpcIdSchema,
  type MachineRpcAttestedRequest,
  type MachineRpcResult,
} from "@getpaseo/protocol/enterprise-collaboration";
import type { ManagedWorkspaceCatalog } from "./workspace-catalog.js";

export const COLLAB_TURN_UNAVAILABLE = "Collaborative turns are unavailable on this daemon";

export interface CollabTurnSendInput {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly credentialId: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly text: string;
  readonly requestId: string;
  readonly messageId?: string;
  readonly sharedTurnPolicy?: "queue" | "interrupt";
}

export interface CollabTurnControl {
  send(input: CollabTurnSendInput): Promise<{ accepted: boolean; error?: string }>;
}

export interface CollabTurnMutator {
  submitSend(input: {
    actorPrincipalId: string;
    credentialId: string;
    clientId: string;
    method: "agent.send";
    localWorkspaceId: string;
    rpcId: string;
    payload: unknown;
  }): Promise<MachineRpcAttestedRequest>;
  dispatch(
    workspaceUid: string,
    envelope: MachineRpcAttestedRequest,
    rpcId: string,
  ): Promise<MachineRpcResult>;
}

export function createCollabTurnControl(input: {
  catalog: Pick<ManagedWorkspaceCatalog, "current">;
  mutator?: CollabTurnMutator;
}): CollabTurnControl {
  return {
    async send(request) {
      const catalog = input.catalog.current();
      const entry = catalog?.workspaces.find(
        (workspace) => workspace.localWorkspaceId === request.workspaceId,
      );
      if (!entry || entry.state !== "active") throw new Error(COLLAB_TURN_UNAVAILABLE);
      if (!input.mutator) throw new Error(COLLAB_TURN_UNAVAILABLE);
      const rpcId = MachineRpcIdSchema.parse(`rpc_${globalThis.crypto.randomUUID()}`);
      const envelope = await input.mutator.submitSend({
        actorPrincipalId: request.actorPrincipalId,
        credentialId: request.credentialId,
        clientId: request.clientId,
        method: "agent.send",
        localWorkspaceId: request.workspaceId,
        rpcId,
        payload: {
          type: "send_agent_message_request",
          requestId: request.requestId,
          agentId: request.agentId,
          text: request.text,
          ...(request.messageId ? { messageId: request.messageId } : {}),
          ...(request.sharedTurnPolicy ? { sharedTurnPolicy: request.sharedTurnPolicy } : {}),
        },
      });
      const result = await input.mutator.dispatch(entry.workspaceUid, envelope, rpcId);
      if (result.kind === "error") return { accepted: false, error: result.message };
      return { accepted: true };
    },
  };
}
