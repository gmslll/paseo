import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  JsonFileBrowserProfileLeaseGenerationStorage,
  createProductionBrowserLeaseBundle,
} from "./production-bundle.js";

describe("production browser lease bundle", () => {
  test("persists lease generation JSON across storage restart", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-bundle-"));
    const file = path.join(home, "enterprise", "browser", "lease-generation.json");
    const first = new JsonFileBrowserProfileLeaseGenerationStorage(file);
    await first.write({ version: 1, generation: 4, nextFencingToken: 9 });
    const restarted = new JsonFileBrowserProfileLeaseGenerationStorage(file);
    await expect(restarted.read()).resolves.toEqual({
      version: 1,
      generation: 4,
      nextFencingToken: 9,
    });
  });

  test("fails closed for corrupt and unknown generation JSON", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-bundle-"));
    const file = path.join(home, "enterprise", "browser", "lease-generation.json");
    const storage = new JsonFileBrowserProfileLeaseGenerationStorage(file);
    await storage.write({ version: 1, generation: 1, nextFencingToken: 2, unexpected: true });
    await expect(storage.read()).rejects.toThrow();
    await writeFile(file, "{broken", "utf8");
    await expect(storage.read()).rejects.toThrow(SyntaxError);
  });

  test("bundle close and invalidation are idempotent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-bundle-"));
    const clock = { now: () => Date.now(), setTimeout, clearTimeout };
    const bundle = createProductionBrowserLeaseBundle({
      paseoHome: home,
      nodeId: "node-1",
      downloadBaseRoot: path.join(home, "downloads"),
      clock,
      auditSink: { append: vi.fn(async () => undefined) },
      createLeaseId: () => "lease-1",
      createRequestId: () => "request-1",
      maxLeaseTtlMs: 60_000,
      isCurrentHandle: () => false,
      resolveAuthorization: () => {
        throw new Error("not expected");
      },
    });
    await expect(bundle.invalidateHost("missing-host")).resolves.toBeUndefined();
    await expect(bundle.invalidateHost("missing-host")).resolves.toBeUndefined();
    await expect(bundle.close()).resolves.toBeUndefined();
    await expect(bundle.close()).resolves.toBeUndefined();
    await expect(
      readFile(path.join(home, "enterprise", "browser", "lease-generation.json"), "utf8"),
    ).resolves.toContain('"generation"');
  });
});
