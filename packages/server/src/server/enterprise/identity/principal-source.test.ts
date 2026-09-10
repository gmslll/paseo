import { describe, expect, test, vi } from "vitest";
import type { IdentityRegistryFsPort } from "./fs-port.js";
import { createFilePrincipalGrantSource } from "./principal-source.js";
import type { PrincipalGrantSource } from "./registry.js";

const principalId = "usr_aaaaaaaaaaaaaaaa";
const organizationId = "org_aaaaaaaaaaaaaaaa";

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
    const grant = { principalId, organizationId, permissions: [], grantVersion: "g1" };
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
});
