import {
  EnterpriseBrowserPageIdentityInvalidationRequestSchema,
  EnterpriseBrowserPageIdentityInvalidationResponseSchema,
  EnterpriseBrowserPageIdentityObservationRequestSchema,
  EnterpriseBrowserPageIdentityObservationResponseSchema,
} from "@getpaseo/protocol/messages";
import type { SessionInboundMessage } from "../../messages.js";
import {
  createAuthenticatedBrowserHostSession,
  isBrowserPageIdentityRegistry,
  type BrowserPageIdentityRegistry,
} from "../../browser-tools/page-identity-registry.js";
import type {
  EnterpriseDispatchContext,
  EnterpriseDispatchResult,
  EnterpriseSessionDispatcher,
  EnterpriseSessionDispatcherFactoryRegistration,
} from "../../session/enterprise-dispatcher.js";

const OBSERVATION_OPERATION = "enterprise.browser.page_identity.observe.request" as const;
const INVALIDATION_OPERATION = "enterprise.browser.page_identity.invalidate.request" as const;
const OBSERVATION_MANIFEST = Object.freeze({
  operations: Object.freeze([OBSERVATION_OPERATION]),
});
const INVALIDATION_MANIFEST = Object.freeze({
  operations: Object.freeze([INVALIDATION_OPERATION]),
});

export function createBrowserPageIdentityObservationDispatcherRegistration(input: {
  readonly registry: BrowserPageIdentityRegistry;
}): EnterpriseSessionDispatcherFactoryRegistration | null {
  return createRegistration(input, OBSERVATION_MANIFEST, OBSERVATION_OPERATION, observe);
}

export function createBrowserPageIdentityInvalidationDispatcherRegistration(input: {
  readonly registry: BrowserPageIdentityRegistry;
}): EnterpriseSessionDispatcherFactoryRegistration | null {
  return createRegistration(input, INVALIDATION_MANIFEST, INVALIDATION_OPERATION, invalidate);
}

function createRegistration(
  input: { readonly registry: BrowserPageIdentityRegistry },
  manifest: EnterpriseSessionDispatcherFactoryRegistration["manifest"],
  operation: string,
  handleMessage: (
    registry: BrowserPageIdentityRegistry,
    host: ReturnType<typeof createAuthenticatedBrowserHostSession>,
    message: SessionInboundMessage,
  ) => Promise<EnterpriseDispatchResult>,
): EnterpriseSessionDispatcherFactoryRegistration | null {
  if (!input || !isBrowserPageIdentityRegistry(input.registry)) return null;
  const registry = input.registry;
  return Object.freeze({
    manifest,
    open(openInput: Parameters<EnterpriseSessionDispatcherFactoryRegistration["open"]>[0]) {
      const session = snapshotOpenSession(openInput);
      const host = createAuthenticatedBrowserHostSession({
        clientId: session.clientId,
        homeNodeId: session.context.node.nodeId,
        sessionBindingGeneration: session.context.sessionBindingGeneration,
      });
      let closed = false;
      const dispatcher: EnterpriseSessionDispatcher = Object.freeze({
        requestPolicyForType: (type: string) => (type === operation ? "transport_control" : null),
        handle: async ({
          sessionContext,
          message,
        }: Parameters<EnterpriseSessionDispatcher["handle"]>[0]) => {
          if (closed || !isCurrentDispatchSession(session, sessionContext)) return false;
          return handleMessage(registry, host, message);
        },
      });
      return Object.freeze({
        dispatcher,
        close: () => {
          if (closed) return;
          closed = true;
          registry.invalidateSession(session.context.sessionBindingGeneration);
        },
      });
    },
  });
}

async function observe(
  registry: BrowserPageIdentityRegistry,
  host: ReturnType<typeof createAuthenticatedBrowserHostSession>,
  message: SessionInboundMessage,
): Promise<EnterpriseDispatchResult> {
  if (message.type !== OBSERVATION_OPERATION) return false;
  try {
    const request = EnterpriseBrowserPageIdentityObservationRequestSchema.parse(
      structuredClone(message),
    );
    const acceptedRevision = await registry.observe(host, request);
    return EnterpriseBrowserPageIdentityObservationResponseSchema.parse({
      type: "enterprise.browser.page_identity.observe.response",
      payload: { requestId: request.requestId, acceptedRevision },
    });
  } catch {
    return false;
  }
}

async function invalidate(
  registry: BrowserPageIdentityRegistry,
  host: ReturnType<typeof createAuthenticatedBrowserHostSession>,
  message: SessionInboundMessage,
): Promise<EnterpriseDispatchResult> {
  if (message.type !== INVALIDATION_OPERATION) return false;
  try {
    const request = EnterpriseBrowserPageIdentityInvalidationRequestSchema.parse(
      structuredClone(message),
    );
    const acceptedRevision = await registry.invalidateObservation(host, request);
    return EnterpriseBrowserPageIdentityInvalidationResponseSchema.parse({
      type: "enterprise.browser.page_identity.invalidate.response",
      payload: { requestId: request.requestId, acceptedRevision },
    });
  } catch {
    return false;
  }
}

function snapshotOpenSession(
  input: Parameters<EnterpriseSessionDispatcherFactoryRegistration["open"]>[0],
) {
  if (
    !input ||
    typeof input.sessionId !== "string" ||
    input.sessionId.length === 0 ||
    typeof input.clientId !== "string" ||
    input.clientId.length === 0 ||
    !input.context ||
    typeof input.context !== "object" ||
    typeof input.context.sessionBindingGeneration !== "string" ||
    input.context.sessionBindingGeneration.length === 0
  ) {
    throw new Error("Browser page identity Session is invalid.");
  }
  return Object.freeze({
    sessionId: input.sessionId,
    clientId: input.clientId,
    context: input.context,
  });
}

function isCurrentDispatchSession(
  open: ReturnType<typeof snapshotOpenSession>,
  current: EnterpriseDispatchContext,
): boolean {
  return (
    current.sessionId === open.sessionId &&
    current.clientId === open.clientId &&
    current.credentialId === open.context.principal.credentialId &&
    current.sessionBindingGeneration === open.context.sessionBindingGeneration &&
    current.enterpriseContext === open.context
  );
}
