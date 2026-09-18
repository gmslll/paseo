import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDownloadStore } from "@/stores/download-store";

describe("enterprise downloads", () => {
  beforeEach(() => {
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:enterprise"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ click: vi.fn(), remove: vi.fn() })),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    });
  });

  it("uses the W3 request seam without invoking the legacy token path", async () => {
    const request = vi.fn(async () => new Response(new Blob(["bytes"]), { status: 200 }));
    const legacy = vi.fn(async () => ({
      token: "must-not-be-read",
      fileName: null,
      mimeType: null,
      error: null,
    }));

    await useDownloadStore.getState().startDownload({
      serverId: "server-a",
      scopeId: "workspace-a",
      fileName: "report.txt",
      path: "docs/report.txt",
      daemonProfile: undefined,
      enterpriseScopeGeneration: "scope-1",
      enterpriseFileDownload: request,
      requestFileDownloadToken: legacy,
    });

    expect(request).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      relativePath: "docs/report.txt",
      scopeGeneration: "scope-1",
    });
    expect(legacy).not.toHaveBeenCalled();
    expect([...useDownloadStore.getState().downloads.values()][0]?.status).toBe("complete");
  });

  it("fails closed when enterprise scope generation is unavailable", async () => {
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    const legacy = vi.fn(async () => ({
      token: "must-not-be-read",
      fileName: null,
      mimeType: null,
      error: null,
    }));

    await useDownloadStore.getState().startDownload({
      serverId: "server-a",
      scopeId: "workspace-a",
      fileName: "report.txt",
      path: "docs/report.txt",
      daemonProfile: undefined,
      enterpriseFileDownload: request,
      requestFileDownloadToken: legacy,
    });

    expect(request).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect([...useDownloadStore.getState().downloads.values()][0]?.status).toBe("error");
  });
});
