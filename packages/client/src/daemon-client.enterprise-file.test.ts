import { describe, expect, test, vi } from "vitest";
import { DaemonClient } from "./daemon-client.js";

describe("DaemonClient enterprise file request seam", () => {
  test("forwards only the validated scope snapshot to the injected transport", async () => {
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    const client = new DaemonClient({
      url: "ws://test",
      clientId: "enterprise-file-test",
      enterpriseFileRequest: request,
    });
    const input = {
      serverId: "server-a",
      workspaceId: "wks_aaaaaaaaaaaaaaaa",
      relativePath: "src/main.ts",
      scopeGeneration: "generation-a",
    };

    await client.enterpriseFileDownload(input);
    input.workspaceId = "wks_mutated";
    input.relativePath = "mutated.ts";

    expect(request).toHaveBeenCalledWith({
      serverId: "server-a",
      workspaceId: "wks_aaaaaaaaaaaaaaaa",
      relativePath: "src/main.ts",
      scopeGeneration: "generation-a",
      signal: undefined,
    });
  });

  test.each([
    { serverId: "", workspaceId: "wks_aaaaaaaaaaaaaaaa", relativePath: "a", scopeGeneration: "g" },
    { serverId: "server-a", workspaceId: "", relativePath: "a", scopeGeneration: "g" },
    {
      serverId: "server-a",
      workspaceId: "wks_aaaaaaaaaaaaaaaa",
      relativePath: "",
      scopeGeneration: "g",
    },
    {
      serverId: "server-a",
      workspaceId: "wks_aaaaaaaaaaaaaaaa",
      relativePath: "a",
      scopeGeneration: "",
    },
  ])("rejects an invalid enterprise scope before transport", async (input) => {
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    const client = new DaemonClient({
      url: "ws://test",
      clientId: "enterprise-file-invalid-test",
      enterpriseFileRequest: request,
    });

    await expect(client.enterpriseFileDownload(input)).rejects.toThrow(
      "Invalid enterprise file download scope",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
