import { describe, expect, test, vi } from "vitest";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { EnterpriseSessionContext } from "../enterprise/identity/session-context.js";
import {
  dispatchEnterpriseRequest,
  ENTERPRISE_CONTENT_READ_MANIFEST,
  ENTERPRISE_IDENTITY_SELF_POLICY,
  isEnterpriseResponsePair,
  registerEnterpriseIdentitySelfPolicy,
  resolveEnterpriseContentReadPolicy,
  resolveEnterpriseReceiptPolicy,
  type EnterpriseSessionDispatcher,
} from "./enterprise-dispatcher.js";

const context = {
  sessionId: "session-test",
  clientId: "client-test",
  credentialId: "credential-test",
  sessionBindingGeneration: "generation-test",
  enterpriseContext: {} as EnterpriseSessionContext,
};
const message = {
  type: "enterprise.identity.get_current.request",
  requestId: "request-test",
} as SessionInboundMessage;

describe("enterprise session dispatcher seam", () => {
  test("exports the identity-self request/response policy contract", () => {
    expect(ENTERPRISE_IDENTITY_SELF_POLICY.requiresCurrentSessionBinding).toBe(true);
    expect(ENTERPRISE_IDENTITY_SELF_POLICY.requestTypes).toEqual([
      "enterprise.identity.get_current.request",
      "enterprise.identity.logout_all.request",
    ]);
    expect(ENTERPRISE_IDENTITY_SELF_POLICY.responseTypes).toEqual([
      "enterprise.identity.get_current.response",
      "enterprise.identity.logout_all.response",
    ]);
    const dispatcher: EnterpriseSessionDispatcher = { handle: vi.fn(() => false) };
    const registered = registerEnterpriseIdentitySelfPolicy(dispatcher);
    expect(registered).not.toBe(dispatcher);
  });

  test("resolves identity requests to a receipt policy without bypassing inbound authorization", () => {
    expect(resolveEnterpriseReceiptPolicy("enterprise.identity.get_current.request")).toEqual({
      event: "enterprise.identity.get_current.response",
      requestType: "enterprise.identity.get_current.request",
      daemonPermission: null,
      enterpriseActions: ["identity.manage"],
      emission: "terminal",
    });
    expect(resolveEnterpriseReceiptPolicy("enterprise.identity.logout_all.request")).toEqual(
      expect.objectContaining({
        event: "enterprise.identity.logout_all.response",
        requestType: "enterprise.identity.logout_all.request",
      }),
    );
    expect(resolveEnterpriseReceiptPolicy("enterprise.unknown.request")).toBeNull();
    expect(
      resolveEnterpriseReceiptPolicy("enterprise.organization.list_resources.request"),
    ).toEqual(
      expect.objectContaining({
        event: "enterprise.organization.list_resources.response",
        enterpriseActions: ["workspace.metadata.read"],
      }),
    );
    expect(
      resolveEnterpriseReceiptPolicy("enterprise.placement.resolve_workspace.request"),
    ).toEqual(
      expect.objectContaining({
        event: "enterprise.placement.resolve_workspace.response",
        enterpriseActions: ["workspace.metadata.read"],
      }),
    );
  });
  test("passes the server-bound context to the registered dispatcher", async () => {
    const handle = vi.fn(() => message as unknown as SessionOutboundMessage);
    const dispatcher: EnterpriseSessionDispatcher = { handle };
    await expect(dispatchEnterpriseRequest(dispatcher, context, message)).resolves.toBe(message);
    expect(handle).toHaveBeenCalledWith({ sessionContext: context, message });
  });

  test("missing dispatcher is unavailable without invoking a handler", async () => {
    const handle = vi.fn(() => true);
    await expect(dispatchEnterpriseRequest(null, context, message)).resolves.toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });

  test("an unregistered operation returns unavailable", async () => {
    const dispatcher: EnterpriseSessionDispatcher = { handle: vi.fn(() => false) };
    await expect(dispatchEnterpriseRequest(dispatcher, context, message)).resolves.toBe(false);
  });

  test("consumer supplies the explicit authorization classification for delivery", () => {
    const contextual = {
      response: message as unknown as SessionOutboundMessage,
      receiptClassification: "resources" as const,
    };
    const consume = vi.fn(() => contextual);
    const dispatcher: EnterpriseSessionDispatcher = {
      handle: vi.fn(() => message as unknown as SessionOutboundMessage),
      consumeResponse: consume,
    };
    const result = dispatcher.consumeResponse?.({
      sessionContext: context,
      message,
      response: message as unknown as SessionOutboundMessage,
    });
    expect(result).toBe(contextual);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(result?.receiptClassification).toBe("resources");
  });

  test("exposes four independently flaggable content-read policies", () => {
    expect(ENTERPRISE_CONTENT_READ_MANIFEST).toEqual([
      expect.objectContaining({
        requestType: "enterprise.workspace.content.read.request",
        responseType: "enterprise.workspace.content.read.response",
        action: "workspace.content.read",
        featureFlag: "enterpriseWorkspaceContentReadV1",
      }),
      expect.objectContaining({
        requestType: "enterprise.agent.content.read.request",
        responseType: "enterprise.agent.content.read.response",
        action: "workspace.content.read",
        featureFlag: "enterpriseAgentContentReadV1",
      }),
      expect.objectContaining({
        requestType: "enterprise.browser_profile.content.read.request",
        responseType: "enterprise.browser_profile.content.read.response",
        action: "browser.use",
        featureFlag: "enterpriseBrowserProfileContentReadV1",
      }),
      expect.objectContaining({
        requestType: "enterprise.app_slot.content.read.request",
        responseType: "enterprise.app_slot.content.read.response",
        action: "app.use",
        featureFlag: "enterpriseAppSlotContentReadV1",
      }),
    ]);
    expect(resolveEnterpriseContentReadPolicy("enterprise.agent.content.read.request")).toEqual(
      expect.objectContaining({ action: "workspace.content.read" }),
    );
    expect(resolveEnterpriseContentReadPolicy("enterprise.unknown.request")).toBeNull();
  });

  test("accepts only the exact content request/response pairing", () => {
    const request = {
      type: "enterprise.workspace.content.read.request",
      requestId: "request-content",
      resource: {
        resourceKind: "workspace",
        organizationId: "org_aaaaaaaaaaaaaaaa",
        nodeId: "nod_aaaaaaaaaaaaaaaa",
        localResourceId: "wks_aaaaaaaaaaaaaaaa",
      },
      selector: { kind: "workspace", view: "timeline" },
    } as SessionInboundMessage;
    const response = {
      type: "enterprise.workspace.content.read.response",
      payload: {
        requestId: "request-content",
        resource: request.resource,
        selector: request.selector,
      },
    } as SessionOutboundMessage;
    expect(isEnterpriseResponsePair(request, response)).toBe(true);
    expect(
      isEnterpriseResponsePair(request, {
        ...response,
        type: "enterprise.agent.content.read.response",
      } as SessionOutboundMessage),
    ).toBe(false);
    expect(
      isEnterpriseResponsePair(request, {
        ...response,
        payload: { requestId: "other" },
      } as SessionOutboundMessage),
    ).toBe(false);
    expect(
      isEnterpriseResponsePair(request, {
        ...response,
        payload: {
          ...response.payload,
          resource: { ...request.resource, localResourceId: "wks_bbbbbbbbbbbbbbbb" },
        },
      } as SessionOutboundMessage),
    ).toBe(false);
    expect(
      isEnterpriseResponsePair(request, {
        ...response,
        payload: {
          ...response.payload,
          selector: { kind: "workspace", view: "files" },
        },
      } as SessionOutboundMessage),
    ).toBe(false);
  });
});
