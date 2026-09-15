import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Per-Agent caller capability for the Agent MCP route (ADR-0043). The HMAC key exists only in
// daemon memory for one run, so a token names exactly one Agent and stops verifying after restart.

export const AGENT_MCP_CALLER_HEADER = "x-paseo-agent-caller";

const TOKEN_PREFIX = "pmc1";
const HMAC_CONTEXT = "paseo-agent-mcp-caller:v1:";

export interface AgentMcpCallerTokens {
  mint(agentId: string): string;
  verify(token: string): string | null;
}

export function createAgentMcpCallerTokens(options: { key?: Buffer } = {}): AgentMcpCallerTokens {
  const key = options.key ?? randomBytes(32);

  function sign(agentId: string): Buffer {
    return createHmac("sha256", key)
      .update(HMAC_CONTEXT + agentId)
      .digest();
  }

  return {
    mint(agentId) {
      const encodedAgentId = Buffer.from(agentId, "utf8").toString("base64url");
      return `${TOKEN_PREFIX}.${encodedAgentId}.${sign(agentId).toString("base64url")}`;
    },
    verify(token) {
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
        return null;
      }
      const agentId = Buffer.from(parts[1], "base64url").toString("utf8");
      // Reject alternate encodings of the same bytes so one Agent has one valid token.
      if (!agentId || Buffer.from(agentId, "utf8").toString("base64url") !== parts[1]) {
        return null;
      }
      const provided = Buffer.from(parts[2], "base64url");
      const expected = sign(agentId);
      return provided.length === expected.length && timingSafeEqual(provided, expected)
        ? agentId
        : null;
    },
  };
}

export type AgentMcpCaller =
  | { kind: "top_level" }
  | { kind: "agent"; agentId: string }
  | { kind: "rejected" };

export function resolveAgentMcpCaller(input: {
  tokens: AgentMcpCallerTokens;
  callerHeader: string | undefined;
  legacyCallerAgentId: unknown;
}): AgentMcpCaller {
  // A request that names its own caller is never trusted, even alongside a valid token.
  if (input.legacyCallerAgentId !== undefined) {
    return { kind: "rejected" };
  }
  if (input.callerHeader === undefined) {
    return { kind: "top_level" };
  }
  const agentId = input.tokens.verify(input.callerHeader);
  return agentId === null ? { kind: "rejected" } : { kind: "agent", agentId };
}
