import { describe, expect, test } from "vitest";

import { wrapSessionMessage } from "@getpaseo/protocol/messages";
import { getWebSocketRpcDiagnosticResponseIdentity } from "./websocket-server.js";

describe("websocket rpc diagnostic response identity", () => {
  test("extracts correlated responses only from wrapped session messages", () => {
    expect(
      getWebSocketRpcDiagnosticResponseIdentity(
        wrapSessionMessage({
          type: "fetch_agents_response",
          payload: { requestId: "req-1", agents: [] },
        }),
      ),
    ).toEqual({ requestId: "req-1", responseType: "fetch_agents_response" });
    expect(
      getWebSocketRpcDiagnosticResponseIdentity(
        wrapSessionMessage({
          type: "rpc_error",
          payload: {
            requestId: "req-2",
            requestType: "fetch_agent_request",
            error: "denied",
            code: "forbidden",
          },
        }),
      ),
    ).toEqual({ requestId: "req-2", responseType: "rpc_error" });
    expect(
      getWebSocketRpcDiagnosticResponseIdentity({
        type: "fetch_agents_response",
        payload: { requestId: "top-level", agents: [] },
      }),
    ).toBeNull();
  });
});
