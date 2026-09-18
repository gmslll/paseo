import { describe, expect, test } from "vitest";

import { createAgentMcpCallerTokens, resolveAgentMcpCaller } from "./mcp-caller-token.js";

describe("Agent MCP caller tokens", () => {
  test("a minted token verifies to exactly its Agent", () => {
    const tokens = createAgentMcpCallerTokens();

    expect(tokens.verify(tokens.mint("agent-1"))).toBe("agent-1");
    expect(tokens.verify(tokens.mint("工作区-agent"))).toBe("工作区-agent");
  });

  test("an Agent cannot edit its token to name another Agent", () => {
    const tokens = createAgentMcpCallerTokens();
    const [prefix, , signature] = tokens.mint("agent-1").split(".");
    const [, otherAgent] = tokens.mint("agent-2").split(".");

    expect(tokens.verify(`${prefix}.${otherAgent}.${signature}`)).toBeNull();
  });

  test("a token from an earlier daemon run does not verify", () => {
    const earlierRun = createAgentMcpCallerTokens();
    const currentRun = createAgentMcpCallerTokens();

    expect(currentRun.verify(earlierRun.mint("agent-1"))).toBeNull();
  });

  test("rejects an alternate encoding of the same Agent ID", () => {
    const tokens = createAgentMcpCallerTokens();
    const [prefix, agentId, signature] = tokens.mint("agent-1").split(".");

    expect(tokens.verify(`${prefix}.${agentId}==.${signature}`)).toBeNull();
  });

  test.each(["", "agent-1", "pmc1.YWdlbnQtMQ", "pmc2.YWdlbnQtMQ.c2ln", "pmc1..c2ln", "pmc1.a.b.c"])(
    "rejects malformed token %j",
    (token) => {
      expect(createAgentMcpCallerTokens().verify(token)).toBeNull();
    },
  );
});

describe("resolveAgentMcpCaller", () => {
  const tokens = createAgentMcpCallerTokens();

  test("a request with no caller information is a top-level caller", () => {
    expect(
      resolveAgentMcpCaller({ tokens, callerHeader: undefined, legacyCallerAgentId: undefined }),
    ).toEqual({ kind: "top_level" });
  });

  test("a verified caller header names the Agent", () => {
    expect(
      resolveAgentMcpCaller({
        tokens,
        callerHeader: tokens.mint("agent-1"),
        legacyCallerAgentId: undefined,
      }),
    ).toEqual({ kind: "agent", agentId: "agent-1" });
  });

  test("a forged caller header is rejected", () => {
    expect(
      resolveAgentMcpCaller({ tokens, callerHeader: "agent-1", legacyCallerAgentId: undefined }),
    ).toEqual({ kind: "rejected" });
  });

  test("a caller ID in the query is rejected even with a valid header", () => {
    expect(
      resolveAgentMcpCaller({ tokens, callerHeader: undefined, legacyCallerAgentId: "agent-2" }),
    ).toEqual({ kind: "rejected" });
    expect(
      resolveAgentMcpCaller({
        tokens,
        callerHeader: tokens.mint("agent-1"),
        legacyCallerAgentId: ["agent-2"],
      }),
    ).toEqual({ kind: "rejected" });
  });
});
