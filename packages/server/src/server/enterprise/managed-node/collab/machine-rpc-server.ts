import {
  MACHINE_RPC_LIFECYCLE_RECEIPT_MS,
  MachineRpcAttestedRequestSchema,
  formatCollabSegment,
  machineRpcMethodPolicy,
  roleAllowsMachineRpcMethod,
  type MachineRpcAttestedRequest,
  type MachineRpcResult,
  type WorkspaceMemberRole,
} from "@getpaseo/protocol/enterprise-collaboration";
import {
  decodeMachineRpcAttestationClaims,
  parseMachineRpcAttestation,
} from "@getpaseo/protocol/machine-rpc-attestation";
import type {
  PrincipalContext,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

import type { CollabRepoStore } from "./loro-repo-store.js";
import { MachineRpcAttestationError, verifyMachineRpcAttestation } from "./rpc-attestation.js";

/**
 * Runs the machine RPCs a collaborator addressed to this node (ADR-0035).
 *
 * Everything a caller is allowed to do is decided twice: the plane checked membership and the
 * method before it signed, and this checks the signature, the method again, and the requester's
 * Grant version against the policy this node currently holds. The second check is not ceremony — an
 * attestation lives 60 seconds, and a revocation that landed in between reaches the node as a policy
 * refresh, not as a message from the plane.
 *
 * The payload is dispatched through an ordinary enterprise Session, so authorization, outbound
 * filtering and audit are the same code a direct connection runs. This module never decides what a
 * request may do; it decides only whether the request is genuinely from who it says.
 */

export interface HeadlessSession {
  handleMessage(message: SessionInboundMessage): Promise<void>;
  close(): void;
}

/**
 * Supplied by the daemon, which is where the Session collaborators live. A Session needs an agent
 * manager, registries and stores that this module has no business assembling, and the enterprise
 * context needs the node's own identity, so the factory is handed in rather than built here.
 */
export interface HeadlessSessionFactory {
  open(input: {
    readonly principal: PrincipalContext;
    readonly clientId: string;
    readonly onMessage: (message: SessionOutboundMessage) => void;
  }): HeadlessSession;
}

export interface MachineRpcPrincipalSource {
  resolvePrincipal(
    principalId: string,
    organizationId: string,
  ): Promise<Omit<PrincipalContext, "credentialId"> | null>;
}

export interface MachineRpcServerOptions {
  readonly store: CollabRepoStore;
  readonly containerId: string;
  readonly nodeId: string;
  readonly organizationId: string;
  readonly ticketPublicKeyPem: string;
  readonly principals: MachineRpcPrincipalSource;
  readonly sessions: HeadlessSessionFactory;
  /** The caller's role in this container, for the second per-method check. */
  readonly roleOf: (principalId: string) => WorkspaceMemberRole | null;
  readonly now?: () => number;
}

/** What handling one request produced, or null when it was a duplicate worth no answer. */
export interface HandledMachineRpc {
  readonly rpcId: string;
  readonly results: readonly MachineRpcResult[];
}

function requestIdOf(message: SessionOutboundMessage): string | null {
  const payload = (message as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return null;
  const requestId = (payload as { requestId?: unknown }).requestId;
  return typeof requestId === "string" ? requestId : null;
}

function inboundRequestId(message: SessionInboundMessage): string | null {
  if ("requestId" in message && typeof message.requestId === "string") return message.requestId;
  const payload = (message as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return null;
  const requestId = (payload as { requestId?: unknown }).requestId;
  return typeof requestId === "string" ? requestId : null;
}

export class MachineRpcServer {
  private readonly now: () => number;
  private readonly responseSegmentFor: (rpcId: string) => string;
  private readonly completed = new Map<string, readonly MachineRpcResult[]>();
  private readonly inflight = new Map<string, Promise<HandledMachineRpc | null>>();

  constructor(private readonly options: MachineRpcServerOptions) {
    this.now = options.now ?? Date.now;
    this.responseSegmentFor = (rpcId) => formatCollabSegment({ kind: "rpc_response", rpcId });
  }

  /** Results already produced for this id, including a concurrent pump that won the inbox. */
  completedResults(rpcId: string): readonly MachineRpcResult[] | null {
    return this.completed.get(rpcId) ?? null;
  }

  /**
   * Handles one appended request. Returns null when the id has been seen: a stream is replayed on
   * every reconnect, and acting twice on one RPC is the thing the inbox exists to prevent.
   */
  async handle(update: Uint8Array): Promise<HandledMachineRpc | null> {
    let request: MachineRpcAttestedRequest;
    try {
      request = MachineRpcAttestedRequestSchema.parse(
        JSON.parse(Buffer.from(update).toString("utf8")),
      );
    } catch {
      // Not an envelope this node can act on, and no rpcId to answer on either.
      return null;
    }

    const pending = this.inflight.get(request.rpcId);
    if (pending) return pending;
    const work = this.execute(request);
    this.inflight.set(request.rpcId, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(request.rpcId);
    }
  }

  private async execute(request: MachineRpcAttestedRequest): Promise<HandledMachineRpc | null> {
    const expiresAtMs = Date.parse(request.expiresAt);
    if (!this.options.store.rememberRpc(request.rpcId, request.method, expiresAtMs)) return null;

    const results: MachineRpcResult[] = [];
    const fail = (code: string, message: string): HandledMachineRpc => {
      results.push({
        kind: "error",
        rpcVersion: 1,
        rpcId: request.rpcId,
        nodeId: request.nodeId,
        code,
        message,
      });
      this.publish(request.rpcId, results);
      this.completed.set(request.rpcId, results);
      return { rpcId: request.rpcId, results };
    };

    // The envelope does not name its requester — that lives only inside the signed claims, which is
    // what stops a member naming someone else. So decode the claims to learn whom to look up, and
    // treat nothing in them as true until the signature is checked below: a forged payload fails
    // that check, and looking a principal up is a read with no effect.
    const unverified = parseMachineRpcAttestation(request.attestation);
    if (!unverified) return fail("malformed", "attestation is not a token of this kind");
    let requestedPrincipalId: string;
    try {
      requestedPrincipalId = decodeMachineRpcAttestationClaims(unverified.payload).requester
        .principalId;
    } catch {
      return fail("bad_claims", "attestation claims are not well formed");
    }

    const resolved = await this.options.principals.resolvePrincipal(
      requestedPrincipalId,
      this.options.organizationId,
    );
    if (!resolved) return fail("principal_unavailable", "requester is not current on this node");

    let principal: PrincipalContext;
    try {
      const claims = verifyMachineRpcAttestation(
        request.attestation,
        this.options.ticketPublicKeyPem,
        {
          nowMs: this.now(),
          nodeId: this.options.nodeId,
          containerId: this.options.containerId,
          rpcId: request.rpcId,
          currentGrantVersion: resolved.grantVersion,
        },
      );
      principal = { ...resolved, credentialId: claims.requester.credentialId } as PrincipalContext;
    } catch (error) {
      const code = error instanceof MachineRpcAttestationError ? error.code : "attestation";
      return fail(code, "attestation rejected");
    }

    const policy = machineRpcMethodPolicy(request.method);
    const role = this.options.roleOf(principal.principalId);
    // Checked here as well as at the plane: the plane signed against the membership it held sixty
    // seconds ago, and this node may have learned of a change since.
    if (!policy || !role || !roleAllowsMachineRpcMethod(role, policy)) {
      return fail("method_denied", "method is not allowed for this requester");
    }

    results.push({
      kind: "receipt",
      rpcVersion: 1,
      rpcId: request.rpcId,
      nodeId: request.nodeId,
      receivedAt: new Date(this.now()).toISOString(),
    });
    this.publish(request.rpcId, results);

    const answer = await this.dispatch(principal, request);
    results.push(answer);
    this.publish(request.rpcId, [answer]);
    this.completed.set(request.rpcId, results);
    return { rpcId: request.rpcId, results };
  }

  /** How long a caller may wait for the receipt before the request counts as unacknowledged. */
  get receiptDeadlineMs(): number {
    return MACHINE_RPC_LIFECYCLE_RECEIPT_MS;
  }

  private async dispatch(
    principal: PrincipalContext,
    request: MachineRpcAttestedRequest,
  ): Promise<MachineRpcResult> {
    const payload = request.payload as SessionInboundMessage;
    const wanted = inboundRequestId(payload);
    let answer: SessionOutboundMessage | null = null;
    const session = this.options.sessions.open({
      principal,
      clientId: request.clientId,
      onMessage: (message) => {
        // The Session emits its own traffic too; only what answers this request is the reply.
        if (answer === null && wanted !== null && requestIdOf(message) === wanted) answer = message;
      },
    });
    try {
      await session.handleMessage(payload);
    } catch (error) {
      return {
        kind: "error",
        rpcVersion: 1,
        rpcId: request.rpcId,
        nodeId: request.nodeId,
        code: "dispatch_failed",
        message: String(error),
      };
    } finally {
      session.close();
    }
    return {
      kind: "response",
      rpcVersion: 1,
      rpcId: request.rpcId,
      nodeId: request.nodeId,
      completedAt: new Date(this.now()).toISOString(),
      payload: answer,
    };
  }

  /**
   * Appends to `rpc:res:<rpcId>`, which is a JSON log rather than a document: each result is its own
   * entry, and compacting them into a snapshot would lose the receipt that came before the answer.
   */
  private publish(rpcId: string, results: readonly MachineRpcResult[]): void {
    const segment = this.responseSegmentFor(rpcId);
    for (const result of results) {
      this.options.store.enqueueLocalUpdate(
        segment,
        new TextEncoder().encode(JSON.stringify(result)),
      );
    }
  }
}
