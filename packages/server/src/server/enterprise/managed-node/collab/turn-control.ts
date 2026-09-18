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

export interface CollabTurnCancelInput {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly credentialId: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly requestId: string;
}

export interface CollabTurnControl {
  send(input: CollabTurnSendInput): Promise<{ accepted: boolean; error?: string }>;
  cancel(input: CollabTurnCancelInput): Promise<{ accepted: boolean; error?: string }>;
}

export interface CollabTurnMutator {
  submitRpc(input: {
    actorPrincipalId: string;
    credentialId: string;
    clientId: string;
    method: "agent.send" | "agent.cancel";
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
  function requireActive(workspaceId: string) {
    const catalog = input.catalog.current();
    const entry = catalog?.workspaces.find(
      (workspace) => workspace.localWorkspaceId === workspaceId,
    );
    if (!entry || entry.state !== "active" || !input.mutator) {
      throw new Error(COLLAB_TURN_UNAVAILABLE);
    }
    return { entry, mutator: input.mutator };
  }

  return {
    async send(request) {
      const { entry, mutator } = requireActive(request.workspaceId);
      const rpcId = MachineRpcIdSchema.parse(`rpc_${globalThis.crypto.randomUUID()}`);
      const envelope = await mutator.submitRpc({
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
      const result = await mutator.dispatch(entry.workspaceUid, envelope, rpcId);
      if (result.kind === "error") return { accepted: false, error: result.message };
      return { accepted: true };
    },
    async cancel(request) {
      const { entry, mutator } = requireActive(request.workspaceId);
      const rpcId = MachineRpcIdSchema.parse(`rpc_${globalThis.crypto.randomUUID()}`);
      const envelope = await mutator.submitRpc({
        actorPrincipalId: request.actorPrincipalId,
        credentialId: request.credentialId,
        clientId: request.clientId,
        method: "agent.cancel",
        localWorkspaceId: request.workspaceId,
        rpcId,
        payload: {
          type: "cancel_agent_request",
          requestId: request.requestId,
          agentId: request.agentId,
        },
      });
      const result = await mutator.dispatch(entry.workspaceUid, envelope, rpcId);
      if (result.kind === "error") return { accepted: false, error: result.message };
      return { accepted: true };
    },
  };
}
