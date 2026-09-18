import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";

import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import type { AgentClient, AgentSessionConfig } from "./agent-sdk-types.js";

type StructuredContent = Record<string, unknown>;

interface McpToolResult {
  structuredContent?: StructuredContent;
  isError?: boolean;
  content?: Array<{ text?: string }>;
}

interface McpClient {
  callTool: (input: { name: string; args?: StructuredContent }) => Promise<McpToolResult>;
  close: () => Promise<void>;
}

const OPERATION_ID = "fan-out-e2e";
const PROVIDER = "claude/claude-test-model";

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function createMcpClient(
  url: string,
  headers: Record<string, string> = {},
): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  const rawClient = await experimental_createMCPClient({ transport });
  const callTool: McpClient["callTool"] = Reflect.get(rawClient, "callTool").bind(rawClient);
  return { callTool, close: () => rawClient.close() };
}

async function callStructured(
  client: McpClient,
  name: string,
  args: StructuredContent,
): Promise<StructuredContent> {
  const result = await client.callTool({ name, args });
  if (result.isError || !result.structuredContent) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content ?? result)}`);
  }
  return result.structuredContent;
}

async function waitFor<T>(label: string, read: () => T | null | undefined): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Records each created session so the test can read the caller token injected into the parent.
function createLaunchRecordingClients(launches: AgentSessionConfig[]) {
  const clients = createTestAgentClients();
  const claude = clients.claude;
  if (!claude) throw new Error("Fake Claude client is not configured");
  const recording: AgentClient = {
    provider: claude.provider,
    capabilities: {
      ...claude.capabilities,
      supportsMcpServers: true,
      supportsNativePaseoTools: false,
    },
    createSession: async (...args) => {
      launches.push(args[0]);
      return claude.createSession(...args);
    },
    resumeSession: (...args) => claude.resumeSession(...args),
    fetchCatalog: (...args) => claude.fetchCatalog(...args),
    isAvailable: () => claude.isAvailable(),
  };
  return { ...clients, claude: recording };
}

function deliveredMessages(agentManager: AgentManager, agentId: string) {
  if (!agentManager.getAgent(agentId)) return [];
  return agentManager
    .fetchTimeline(agentId, { direction: "tail", limit: 0 })
    .rows.flatMap((row) =>
      row.item.type === "user_message" &&
      row.item.clientMessageId?.startsWith(`op:${OPERATION_ID}:d:`)
        ? [{ messageId: row.item.clientMessageId, text: row.item.text }]
        : [],
    );
}

function findDelivery(agentManager: AgentManager, agentId: string, text: string) {
  return deliveredMessages(agentManager, agentId).find((message) => message.text.includes(text));
}

function countDeliveries(agentManager: AgentManager, agentId: string, text: string): number {
  return deliveredMessages(agentManager, agentId).filter((message) => message.text.includes(text))
    .length;
}

// Persisted delegated Agents. A duplicate creation shows up as a repeated title.
async function delegatedTitles(agentStorage: AgentStorage): Promise<string[]> {
  const records = await agentStorage.list();
  return records
    .flatMap((record) =>
      record.title === "Finisher" || record.title === "Waiter" ? [record.title] : [],
    )
    .toSorted();
}

function daemonConfig(input: {
  paseoHome: string;
  staticDir: string;
  port: number;
  launches: AgentSessionConfig[];
}): PaseoDaemonConfig {
  return {
    listen: `127.0.0.1:${input.port}`,
    paseoHome: input.paseoHome,
    corsAllowedOrigins: [],
    hostnames: true,
    mcpEnabled: true,
    staticDir: input.staticDir,
    mcpDebug: false,
    agentClients: createLaunchRecordingClients(input.launches),
    agentStoragePath: path.join(input.paseoHome, "agents"),
  };
}

describe("delegation outbox end-to-end (offline)", () => {
  test("delivers exactly one fan-out completion to the parent across a daemon restart", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const launches: AgentSessionConfig[] = [];
    const logger = pino({ level: "silent" });
    const firstPort = await getAvailablePort();
    const firstDaemon = await createPaseoDaemon(
      daemonConfig({ paseoHome, staticDir, port: firstPort, launches }),
      logger,
    );
    await firstDaemon.start();
    const firstUrl = `http://127.0.0.1:${firstPort}/mcp/agents`;
    const clients: McpClient[] = [];
    let secondDaemon: Awaited<ReturnType<typeof createPaseoDaemon>> | null = null;

    try {
      const topLevel = await createMcpClient(firstUrl);
      clients.push(topLevel);
      const parent = await callStructured(topLevel, "create_agent", {
        cwd: agentCwd,
        title: "Delegating parent",
        provider: PROVIDER,
        mode: "bypassPermissions",
        initialPrompt: "reply with done and stop",
        background: true,
      });
      const parentId = String(parent.agentId);
      const injected = launches[0]?.mcpServers?.paseo;
      const callerToken =
        injected?.type === "http" ? injected.headers?.["x-paseo-agent-caller"] : undefined;
      expect(typeof callerToken).toBe("string");

      const parentClient = await createMcpClient(firstUrl, {
        "x-paseo-agent-caller": callerToken!,
      });
      clients.push(parentClient);
      const delegation = {
        operationId: OPERATION_ID,
        agents: [
          {
            provider: PROVIDER,
            title: "Finisher",
            initialPrompt: "reply with done and stop",
            settings: { modeId: "bypassPermissions" },
          },
          {
            provider: PROVIDER,
            title: "Waiter",
            initialPrompt: "run echo hello",
            settings: { modeId: "default" },
          },
        ],
      };
      const accepted = await callStructured(parentClient, "create_agents", delegation);
      expect(accepted).toMatchObject({ operationId: OPERATION_ID, status: "running" });

      // The finisher settles and the waiter pauses on a permission request the parent hears about.
      await waitFor("the waiter permission checkpoint", () =>
        findDelivery(firstDaemon.agentManager, parentId, "(Waiter) needs permission."),
      );
      const beforeRestart = await callStructured(parentClient, "get_operation", {
        operationId: OPERATION_ID,
      });
      expect(beforeRestart.items).toEqual([
        expect.objectContaining({ state: "settled", outcome: "finished" }),
        expect.objectContaining({ state: "running", outcome: null }),
      ]);
      // Retrying the same delegation returns the recorded operation without new Agents.
      const replay = await callStructured(parentClient, "create_agents", delegation);
      expect(replay.items).toEqual(beforeRestart.items);
      expect(await delegatedTitles(firstDaemon.agentStorage)).toEqual(["Finisher", "Waiter"]);

      for (const client of clients.splice(0)) await client.close();
      await firstDaemon.stop();

      const secondPort = await getAvailablePort();
      secondDaemon = await createPaseoDaemon(
        daemonConfig({ paseoHome, staticDir, port: secondPort, launches }),
        logger,
      );
      await secondDaemon.start();
      const restarted = secondDaemon;

      const completion = await waitFor("the completion after restart", () =>
        findDelivery(
          restarted.agentManager,
          parentId,
          `Operation ${OPERATION_ID} finished for 2 Agents.`,
        ),
      );
      expect(completion.text).toContain("(Finisher) finished.");
      expect(completion.text).toContain("(Waiter) was interrupted by a daemon restart.");

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(
        countDeliveries(restarted.agentManager, parentId, `Operation ${OPERATION_ID} finished`),
      ).toBe(1);
      expect(await delegatedTitles(restarted.agentStorage)).toEqual(["Finisher", "Waiter"]);
    } finally {
      for (const client of clients) await client.close();
      await secondDaemon?.stop();
      await firstDaemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 60_000);
});
