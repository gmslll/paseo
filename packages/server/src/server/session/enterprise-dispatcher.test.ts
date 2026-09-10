import { describe, expect, test, vi } from "vitest";
import type { SessionInboundMessage } from "../messages.js";
import type { EnterpriseSessionContext } from "../enterprise/identity/session-context.js";
import {
  dispatchEnterpriseRequest,
  ENTERPRISE_IDENTITY_SELF_POLICY,
  registerEnterpriseIdentitySelfPolicy,
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
    expect(registerEnterpriseIdentitySelfPolicy(dispatcher)).toBe(dispatcher);
  });
  test("passes the server-bound context to the registered dispatcher", async () => {
    const handle = vi.fn(() => message);
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
});
