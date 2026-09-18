import type {
  ConnectionContext,
  NodeContext,
  ResourceAuthorization,
  LeaseCoordinator,
} from "@getpaseo/protocol/messages";
import type { ManagedNodeRuntimeDistribution } from "../managed-node/runtime-policy-source.js";
import type { EnterpriseAgentSessionContextRegistry } from "../../session/enterprise-agent-session-context-registry.js";
import type { AuthoritySessionBindingLifecycle } from "../../session/enterprise-authority-receipt-state.js";
import type { AuthorityReceiptStatePort } from "../access/authority-receipt-verifier.js";
import type { OutboundAuthorityEmissionStatePort } from "../access/outbound-authority-emission-authorizer.js";
import type { PrincipalGrantVersionGuard } from "../access/resource-authorization.js";
import type { PrincipalContext } from "@getpaseo/protocol/messages";
import type { ProductionAuditCapability } from "../audit/production-audit-runtime.js";
import type { ProductionAuthorizationRuntimeProvider } from "../access/production-authorization-runtime-provider.js";
import type { ProductionPrincipalGrantSource } from "./principal-source.js";
import type { AdmissionInvalidationSink } from "../../session/enterprise-admission-invalidation.js";
import type {
  EnterpriseAdmissionAuthenticationEvidence,
  EnterpriseAdmissionAuthorizationHandle,
  EnterpriseAdmissionAuthorizationIssuer,
} from "./admission-authorization.js";
import type { BrowserProfileRegistry } from "../browser/profile-registry.js";
import type { EnterpriseSessionDispatcherFactoryRegistration } from "../../session/enterprise-dispatcher.js";
import type { ManagedPlacementSnapshotSource } from "../managed-node/lifecycle.js";
import type { CollabRuntimeDependencies } from "../managed-node/collab/collab-runtime.js";
import type { CollabMembersControl } from "../managed-node/collab/members-control.js";
import type { CollabPresenceControl } from "../managed-node/collab/presence-roster.js";
import type { CollabTurnControl } from "../managed-node/collab/turn-control.js";
import type { CollabTimelineControl } from "../managed-node/collab/timeline-control.js";
import type { CollabStreamTokenControl } from "../managed-node/collab/stream-token-control.js";
import type { CollabSubscriptionControl } from "../managed-node/collab/subscription-control.js";
import type { HeadlessSessionFactory } from "../managed-node/collab/machine-rpc-server.js";

export interface EnterpriseAdmissionPort {
  readonly audit: ProductionAuditCapability;
  readonly authorizationIssuer: EnterpriseAdmissionAuthorizationIssuer;
  readonly authenticator: {
    readonly node: Readonly<NodeContext>;
    readonly configuredOrganizationId: string;
    isCurrentPrincipalContext(principal: PrincipalContext): Promise<boolean>;
  };
  authenticate(token: string, connection: ConnectionContext): Promise<PrincipalContext | null>;
  authenticateEvidence(
    token: string,
    connection: ConnectionContext,
  ): Promise<EnterpriseAdmissionAuthenticationEvidence | null>;
  bindSession(
    evidence: EnterpriseAdmissionAuthenticationEvidence,
    clientId: unknown,
  ): EnterpriseAdmissionAuthorizationHandle | null;
  replaceSession(
    oldHandle: EnterpriseAdmissionAuthorizationHandle,
    evidence: EnterpriseAdmissionAuthenticationEvidence,
    clientId: unknown,
  ): EnterpriseAdmissionAuthorizationHandle | null;
  releaseSession(handle: EnterpriseAdmissionAuthorizationHandle): boolean;
  isCurrentPrincipalContext(principal: PrincipalContext): Promise<boolean>;
}
export type EnterpriseAuthorityReceiptState = AuthoritySessionBindingLifecycle &
  AuthorityReceiptStatePort &
  OutboundAuthorityEmissionStatePort;

export interface EnterpriseAdmissionRuntime {
  readonly audit: ProductionAuditCapability;
  readonly admission: EnterpriseAdmissionPort;
  readonly node: Readonly<NodeContext>;
  readonly agentContextRegistry: EnterpriseAgentSessionContextRegistry;
  readonly authorityReceiptState: EnterpriseAuthorityReceiptState;
  readonly grantVersionGuard: PrincipalGrantVersionGuard;
  readonly resourceAuthorization: ResourceAuthorization;
  readonly authorizationRuntimeProvider?: ProductionAuthorizationRuntimeProvider;
  readonly admissionInvalidationSink?: AdmissionInvalidationSink;
  readonly principalSource?: ProductionPrincipalGrantSource;
  readonly browserProfiles?: BrowserProfileRegistry;
  readonly identityDispatcherRegistration?: EnterpriseSessionDispatcherFactoryRegistration;
  readonly leaseCoordinator?: LeaseCoordinator;
  readonly managedPlacementSource?: Readonly<{
    install(source: ManagedPlacementSnapshotSource): Promise<void>;
  }>;
  /**
   * Present only when the node collaborates (ADR-0031). The replicas need the Workspace registry
   * and the Agent manager, which bootstrap builds after this runtime, so they arrive here rather
   * than through the factory.
   */
  readonly collaboration?: Readonly<{
    install(dependencies: CollabRuntimeDependencies): Promise<void>;
    /**
     * Separate from `install` because the factory belongs to the WebSocket server, which bootstrap
     * builds long after the replicas (ADR-0053).
     */
    attachSessions(sessions: HeadlessSessionFactory): void;
    members?: CollabMembersControl;
    presence?: CollabPresenceControl;
    turns?: CollabTurnControl;
    timeline?: CollabTimelineControl;
    streamTokens?: CollabStreamTokenControl;
    subscriptions?: CollabSubscriptionControl;
  }>;
  readonly managedRuntimeDistribution?: ManagedNodeRuntimeDistribution;
  nextSessionBindingGeneration(): string;
  close?(): Promise<void>;
}
