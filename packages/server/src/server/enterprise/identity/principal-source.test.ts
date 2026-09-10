import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { IdentityRegistryFsPort } from "./fs-port.js";
import {
  createFilePrincipalGrantSource,
  createProductionPrincipalGrantSource,
} from "./principal-source.js";
import type { PrincipalGrantSource } from "./registry.js";
import { FileBackedGrantStorage } from "../access/grant-store.js";
import { createProductionAuthorizationRuntimeProvider } from "../access/production-authorization-runtime-provider.js";
import {
  createProductionAuditRuntime,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";

const principalId = "usr_aaaaaaaaaaaaaaaa";
const organizationId = "org_aaaaaaaaaaaaaaaa";
const execFileAsync = promisify(execFile);
let addonDirectory: string | undefined;
let addonPath: string | undefined;

beforeAll(async () => {
  if (process.platform !== "darwin") return;
  addonDirectory = await mkdtemp(path.join(os.tmpdir(), "paseo-principal-source-addon-"));
  addonPath = path.join(addonDirectory, "darwin-audit-fs.node");
  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../audit/native/build-darwin-audit-fs.mjs", import.meta.url)),
    "--output",
    addonPath,
  ]);
});

afterAll(async () => {
  if (addonDirectory) await rm(addonDirectory, { recursive: true, force: true });
});

function fixture(document: string): {
  fs: IdentityRegistryFsPort;
  open: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const open = vi.fn(() => 7);
  const read = vi.fn(() => document);
  const close = vi.fn();
  return {
    open,
    read,
    close,
    fs: {
      noFollowFlag: 256,
      mkdir: vi.fn(),
      open,
      close,
      read,
      write: vi.fn(),
      fstat: vi.fn(() => ({ isFile: () => true, isDirectory: () => false, mode: 0o600 })),
      fchmod: vi.fn(),
      fsync: vi.fn(),
      rename: vi.fn(),
      unlink: vi.fn(),
    },
  };
}

function documentFor(value: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    principals: {
      [principalId]: {
        principalId,
        organizationId,
        principalType: "human",
        ...value,
      },
    },
  });
}

function grants(result: Awaited<ReturnType<PrincipalGrantSource["resolvePrincipal"]>>) {
  return { resolvePrincipal: vi.fn(async () => result) } satisfies PrincipalGrantSource;
}

describe("file principal grant source", () => {
  test("reads strict identity metadata and combines matching grant", async () => {
    const fs = fixture(documentFor());
    const grant = { principalId, organizationId, grants: [], grantVersion: "g1" };
    const grantSource = grants(grant);
    const source = createFilePrincipalGrantSource({
      filePath: "/identities.json",
      fs: fs.fs,
      grants: grantSource,
    });
    await expect(source.resolvePrincipal(principalId, organizationId)).resolves.toEqual({
      ...grant,
      principalType: "human",
    });
    expect(fs.open).toHaveBeenCalledWith("/identities.json", 256);
    expect(grantSource.resolvePrincipal).toHaveBeenCalledOnce();
  });

  test.each([
    ["corrupt JSON", "{"],
    ["key mismatch", documentFor({ principalId: "usr_bbbbbbbbbbbbbbbb" })],
    ["break-glass owner", documentFor({ principalId: "owner" })],
  ])("rejects %s without consulting grants", async (_name, content) => {
    const fs = fixture(content);
    const grantSource = grants(null);
    const source = createFilePrincipalGrantSource({
      filePath: "/identities.json",
      fs: fs.fs,
      grants: grantSource,
    });
    await expect(source.resolvePrincipal(principalId, organizationId)).resolves.toBeNull();
    expect(grantSource.resolvePrincipal).not.toHaveBeenCalled();
  });

  test("rejects foreign organization and mismatched grant", async () => {
    const fs = fixture(documentFor());
    const grantSource = grants({
      principalId,
      organizationId: "org_bbbbbbbbbbbbbbbb",
      permissions: [],
      grantVersion: "g1",
    });
    const source = createFilePrincipalGrantSource({
      filePath: "/identities.json",
      fs: fs.fs,
      grants: grantSource,
    });
    await expect(source.resolvePrincipal(principalId, organizationId)).resolves.toBeNull();
    expect(grantSource.resolvePrincipal).toHaveBeenCalledOnce();
    await expect(source.resolvePrincipal(principalId, "org_bbbbbbbbbbbbbbbb")).resolves.toBeNull();
    expect(grantSource.resolvePrincipal).toHaveBeenCalledOnce();
  });

  test.each(["open", "read", "close"] as const)("returns null on fs %s failure", async (method) => {
    const fs = fixture(documentFor());
    fs[method].mockImplementationOnce(() => {
      throw new Error(method);
    });
    const grantSource = grants(null);
    const source = createFilePrincipalGrantSource({
      filePath: "/identities.json",
      fs: fs.fs,
      grants: grantSource,
    });
    await expect(source.resolvePrincipal(principalId, organizationId)).resolves.toBeNull();
    expect(grantSource.resolvePrincipal).not.toHaveBeenCalled();
  });

  test("rejects non-private or non-regular identity files before consulting grants", async () => {
    const fs = fixture(documentFor());
    fs.fs.fstat = vi.fn(() => ({ isFile: () => false, isDirectory: () => true, mode: 0o600 }));
    const grantSource = grants(null);
    const source = createFilePrincipalGrantSource({
      filePath: "/identities.json",
      fs: fs.fs,
      grants: grantSource,
    });
    await expect(source.resolvePrincipal(principalId, organizationId)).resolves.toBeNull();
    expect(grantSource.resolvePrincipal).not.toHaveBeenCalled();
  });

  test.runIf(process.platform === "darwin")(
    "uses only the current audit-bound production GrantStore",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-principal-source-"));
      const auditRoot = path.join(root, "audit");
      const foreignAuditRoot = path.join(root, "foreign-audit");
      let audit: ProductionAuditCapability | undefined;
      let foreignAudit: ProductionAuditCapability | undefined;
      try {
        await writeFile(path.join(root, "principals.json"), documentFor(), { mode: 0o600 });
        await chmod(root, 0o700);
        const grantFilePath = path.join(root, "grants.json");
        await new FileBackedGrantStorage(grantFilePath).put({
          principalId,
          organizationId,
          grants: [],
          grantVersion: "grv_current",
        });
        audit = await createProductionAuditRuntime({
          node: {
            nodeId: "nod_aaaaaaaaaaaaaaaa",
            paseoServerId: "srv_principal_source",
            mode: "standalone",
          },
          auditRoot,
          nativeAddonPath: addonPath,
        });
        foreignAudit = await createProductionAuditRuntime({
          node: {
            nodeId: "nod_bbbbbbbbbbbbbbbb",
            paseoServerId: "srv_foreign_principal_source",
            mode: "standalone",
          },
          auditRoot: foreignAuditRoot,
          nativeAddonPath: addonPath,
        });
        const provider = createProductionAuthorizationRuntimeProvider({ audit, grantFilePath });
        expect(provider).not.toBeNull();
        const source = createProductionPrincipalGrantSource({
          filePath: path.join(root, "principals.json"),
          grantStore: provider!.grantStore,
          audit,
        });
        await expect(source.ready()).resolves.toBeUndefined();
        await expect(source.validateCurrent()).resolves.toBe(true);
        await expect(source.resolvePrincipal(principalId, organizationId)).resolves.toEqual({
          principalId,
          organizationId,
          principalType: "human",
          grants: [],
          grantVersion: "grv_current",
        });
        expect(() =>
          createProductionPrincipalGrantSource({
            filePath: path.join(root, "principals.json"),
            grantStore: provider!.grantStore,
            audit: foreignAudit!,
          }),
        ).toThrow("audit-bound GrantStore");
        const missing = createProductionPrincipalGrantSource({
          filePath: path.join(root, "missing-principals.json"),
          grantStore: provider!.grantStore,
          audit,
        });
        await expect(missing.ready()).rejects.toThrow();
        await expect(missing.validateCurrent()).resolves.toBe(false);
        const corruptPath = path.join(root, "corrupt-principals.json");
        await writeFile(corruptPath, "{", { mode: 0o600 });
        const corrupt = createProductionPrincipalGrantSource({
          filePath: corruptPath,
          grantStore: provider!.grantStore,
          audit,
        });
        await expect(corrupt.ready()).rejects.toThrow();
        await audit.close();
        await expect(source.validateCurrent()).resolves.toBe(false);
        await expect(source.resolvePrincipal(principalId, organizationId)).rejects.toThrow(
          "current runtime-issued production audit capability required",
        );
      } finally {
        await audit?.close().catch(() => undefined);
        await foreignAudit?.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
