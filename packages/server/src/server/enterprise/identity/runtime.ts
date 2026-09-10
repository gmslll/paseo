import type {
  ConnectionContext,
  NodeContext,
  ResourceAuthorization,
} from "@getpaseo/protocol/messages";
import type { EnterpriseAgentSessionContextRegistry } from "../../session/enterprise-agent-session-context-registry.js";
import type { AuthoritySessionBindingLifecycle } from "../../session/enterprise-authority-receipt-state.js";
import type { AuthorityReceiptStatePort } from "../access/authority-receipt-verifier.js";
import type { OutboundAuthorityEmissionStatePort } from "../access/outbound-authority-emission-authorizer.js";
import type { PrincipalGrantVersionGuard } from "../access/resource-authorization.js";
import type { PrincipalContext } from "@getpaseo/protocol/messages";
import type { ProductionAuditCapability } from "../audit/production-audit-runtime.js";
import type { ProductionAuthorizationRuntimeProvider } from "../access/production-authorization-runtime-provider.js";
import type { PrincipalGrantSource } from "./registry.js";
import type { AdmissionInvalidationSink } from "../../session/enterprise-admission-invalidation.js";
import type {
  EnterpriseAdmissionAuthenticationEvidence,
  EnterpriseAdmissionAuthorizationHandle,
  EnterpriseAdmissionAuthorizationIssuer,
} from "./admission-authorization.js";

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
  readonly principalSource?: PrincipalGrantSource;
  nextSessionBindingGeneration(): string;
  close?(): Promise<void>;
}
