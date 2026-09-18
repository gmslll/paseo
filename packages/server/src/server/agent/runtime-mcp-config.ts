import type { AgentSessionConfig, McpServerConfig } from "./agent-sdk-types.js";
import { AGENT_MCP_CALLER_HEADER } from "./mcp-caller-token.js";

const PASEO_MCP_SERVER_NAME = "paseo";
const PASEO_MCP_PATHNAME = "/mcp/agents";

export function stripInternalPaseoMcpServer(config: AgentSessionConfig): AgentSessionConfig {
  const mcpServers = config.mcpServers;
  if (!mcpServers) {
    return config;
  }

  const paseoServer = mcpServers[PASEO_MCP_SERVER_NAME];
  if (!paseoServer || !isInternalPaseoMcpServer(paseoServer)) {
    return config;
  }

  const nextMcpServers = { ...mcpServers };
  delete nextMcpServers[PASEO_MCP_SERVER_NAME];

  const next = { ...config };
  if (Object.keys(nextMcpServers).length > 0) {
    next.mcpServers = nextMcpServers;
  } else {
    delete next.mcpServers;
  }
  return next;
}

export function withRuntimePaseoMcpServer(params: {
  config: AgentSessionConfig;
  mcpBaseUrl: string | null;
  /**
   * Capability token authenticating the injected connection to the daemon's
   * Agent MCP endpoint. The daemon password is gated off this route, so without
   * this header the agent's MCP requests are rejected when a password is set.
   */
  mcpAuthToken: string | null;
  /**
   * Per-Agent caller capability (ADR-0043). The route identifies the calling Agent only from this
   * header, never from the URL.
   */
  mcpCallerToken: string | null;
}): AgentSessionConfig {
  const storedConfig = stripInternalPaseoMcpServer(params.config);
  if (!params.mcpBaseUrl || storedConfig.mcpServers?.[PASEO_MCP_SERVER_NAME]) {
    return storedConfig;
  }

  return {
    ...storedConfig,
    mcpServers: {
      [PASEO_MCP_SERVER_NAME]: {
        type: "http",
        url: params.mcpBaseUrl,
        ...runtimePaseoMcpHeaders(params),
      },
      ...storedConfig.mcpServers,
    },
  };
}

function runtimePaseoMcpHeaders(params: {
  mcpAuthToken: string | null;
  mcpCallerToken: string | null;
}): { headers?: Record<string, string> } {
  const headers: Record<string, string> = {};
  if (params.mcpAuthToken) {
    headers.Authorization = `Bearer ${params.mcpAuthToken}`;
  }
  if (params.mcpCallerToken) {
    headers[AGENT_MCP_CALLER_HEADER] = params.mcpCallerToken;
  }
  return Object.keys(headers).length > 0 ? { headers } : {};
}

function isInternalPaseoMcpServer(config: McpServerConfig): boolean {
  if (config.type !== "http" && config.type !== "sse") {
    return false;
  }

  try {
    return new URL(config.url).pathname === PASEO_MCP_PATHNAME;
  } catch {
    return false;
  }
}
