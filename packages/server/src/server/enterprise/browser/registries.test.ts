import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type {
  AuthorizedAgent,
  AuthorizedBrowserProfile,
  AuthorizedWorkspace,
  BrowserProfileBinding,
  BrowserProfileRecord,
  PrincipalContext,
} from "@getpaseo/protocol/messages";
import {
  BrowserProfileBindingRegistry,
  JsonFileBrowserProfileBindingStorage,
  type BrowserProfileBindingRegistrySnapshot,
  type BrowserProfileBindingProfileResolver,
  type BrowserProfileBindingQuarantineNotice,
  type BrowserProfileBindingStorage,
} from "./binding-registry.js";
import {
  BrowserProfileRegistry,
  BrowserProfileRegistryCorruptError,
  JsonFileBrowserProfileStorage,
  type BrowserProfileCanonicalResolver,
  type BrowserProfileRegistrySnapshot,
  type BrowserProfileStorage,
} from "./profile-registry.js";

const ORGANIZATION_ID = "org_1111111111111111";
const NODE_ID = "nod_1111111111111111";
const OWNER_ID = "usr_1111111111111111";
const CREATOR_ID = "usr_2222222222222222";
const BINDER_ID = "usr_3333333333333333";
const PROFILE_ID = "brp_1111111111111111";
const SECOND_PROFILE_ID = "brp_2222222222222222";
const WORKSPACE_ID = "workspace-1";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

class MemoryProfileStorage implements BrowserProfileStorage {
  public failWrites = false;

  public constructor(public value: unknown | null = null) {}

  public async read(): Promise<unknown | null> {
    return structuredClone(this.value);
  }

  public async write(snapshot: BrowserProfileRegistrySnapshot): Promise<void> {
    if (this.failWrites) {
      throw new Error("profile storage unavailable");
    }
    this.value = structuredClone(snapshot);
  }
}

class MemoryBindingStorage implements BrowserProfileBindingStorage {
  public failWrites = false;

  public constructor(public value: unknown | null = null) {}

  public async read(): Promise<unknown | null> {
    return structuredClone(this.value);
  }

  public async write(snapshot: BrowserProfileBindingRegistrySnapshot): Promise<void> {
    if (this.failWrites) {
      throw new Error("binding storage unavailable");
    }
    this.value = structuredClone(snapshot);
  }
}

class MemoryProfileResolver implements BrowserProfileBindingProfileResolver {
  public error: Error | null = null;

  public constructor(public profile: BrowserProfileRecord | null = profileRecord()) {}

  public async get(browserProfileId: string): Promise<BrowserProfileRecord | null> {
    if (this.error) {
      throw this.error;
    }
    return this.profile?.browserProfileId === browserProfileId
      ? structuredClone(this.profile)
      : null;
  }
}

function canonicalResolver(): BrowserProfileCanonicalResolver {
  return {
    resolve(input) {
      if (input.homeNodeId !== NODE_ID) {
        throw new Error("Profile is not homed on this node");
      }
      return {
        partitionKey: `persist:paseo-enterprise-${input.browserProfileId}`,
        downloadRoot: `/paseo/browser-profiles/${input.browserProfileId}/downloads`,
      };
    },
  };
}

function profileRecord(overrides: Partial<BrowserProfileRecord> = {}): AuthorizedBrowserProfile {
  return {
    browserProfileId: PROFILE_ID,
    organizationId: ORGANIZATION_ID,
    homeNodeId: NODE_ID,
    businessIdentityId: "bid_1111111111111111",
    ownerPrincipalId: OWNER_ID,
    platform: "generic",
    businessAccountKey: "merchant-opaque-key",
    label: "Merchant account",
    partitionKey: `persist:paseo-enterprise-${PROFILE_ID}`,
    downloadRoot: `/paseo/browser-profiles/${PROFILE_ID}/downloads`,
    status: "ready",
    createdAt: "2026-09-09T10:00:00.000Z",
    updatedAt: "2026-09-09T10:00:00.000Z",
    ...overrides,
  };
}

function authorizedWorkspace(overrides: Partial<AuthorizedWorkspace> = {}): AuthorizedWorkspace {
  return {
    workspaceId: WORKSPACE_ID,
    organizationId: ORGANIZATION_ID,
    nodeId: NODE_ID,
    ownerPrincipalId: OWNER_ID,
    createdByPrincipalId: CREATOR_ID,
    ...overrides,
  };
}

function authorizedAgent(overrides: Partial<AuthorizedAgent> = {}): AuthorizedAgent {
  return {
    agentId: "agent-1",
    workspaceId: WORKSPACE_ID,
    organizationId: ORGANIZATION_ID,
    nodeId: NODE_ID,
    ownerPrincipalId: OWNER_ID,
    createdByPrincipalId: CREATOR_ID,
    ...overrides,
  };
}

function principalContext(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return {
    organizationId: ORGANIZATION_ID,
    principalType: "human",
    principalId: BINDER_ID,
    grants: [],
    credentialId: "credential-1",
    grantVersion: "grant-version-1",
    ...overrides,
  };
}

function createBindingRegistry(
  options: {
    storage?: BrowserProfileBindingStorage;
    profiles?: BrowserProfileBindingProfileResolver;
    quarantine?: BrowserProfileBindingQuarantineNotice[];
  } = {},
): BrowserProfileBindingRegistry {
  return new BrowserProfileBindingRegistry({
    storage: options.storage ?? new MemoryBindingStorage(),
    profiles: options.profiles ?? new MemoryProfileResolver(),
    quarantine: options.quarantine
      ? {
          quarantine: (notice) => {
            options.quarantine?.push(notice);
          },
        }
      : undefined,
    now: () => "2026-09-09T11:00:00.000Z",
  });
}

describe("BrowserProfileRegistry", () => {
  test("generates immutable canonical runtime paths and persists records", async () => {
    const storage = new MemoryProfileStorage();
    const registry = new BrowserProfileRegistry({
      storage,
      canonicalResolver: canonicalResolver(),
      createProfileId: () => PROFILE_ID,
      now: () => "2026-09-09T10:00:00.000Z",
    });

    await expect(
      registry.create({
        organizationId: ORGANIZATION_ID,
        homeNodeId: NODE_ID,
        businessIdentityId: "bid_1111111111111111",
        ownerPrincipalId: OWNER_ID,
        platform: "generic",
        businessAccountKey: "merchant-opaque-key",
        label: "Merchant account",
        status: "ready",
        partitionKey: "persist:caller-selected",
        downloadRoot: "/caller/selected",
      } as never),
    ).rejects.toThrow(/invalid Browser Profile create input/i);

    const created = await registry.create({
      organizationId: ORGANIZATION_ID,
      homeNodeId: NODE_ID,
      businessIdentityId: "bid_1111111111111111",
      ownerPrincipalId: OWNER_ID,
      platform: "generic",
      businessAccountKey: "merchant-opaque-key",
      label: "Merchant account",
      status: "ready",
    });

    expect(created).toEqual(profileRecord());
    const restarted = new BrowserProfileRegistry({
      storage,
      canonicalResolver: canonicalResolver(),
    });
    await restarted.initialize();
    await expect(restarted.get(PROFILE_ID)).resolves.toEqual(created);

    await expect(
      registry.update(PROFILE_ID, {
        partitionKey: "persist:attacker-selected",
      } as never),
    ).rejects.toThrow(/invalid Browser Profile update/i);
    await expect(registry.get(PROFILE_ID)).resolves.toEqual(created);
  });

  test("enforces the organization, platform, account, and owner uniqueness key", async () => {
    const registry = new BrowserProfileRegistry({
      storage: new MemoryProfileStorage(),
      canonicalResolver: canonicalResolver(),
      createProfileId: (() => {
        const ids = [PROFILE_ID, SECOND_PROFILE_ID];
        return () => ids.shift() ?? SECOND_PROFILE_ID;
      })(),
      now: () => "2026-09-09T10:00:00.000Z",
    });
    const input = {
      organizationId: ORGANIZATION_ID,
      homeNodeId: NODE_ID,
      businessIdentityId: "bid_1111111111111111",
      ownerPrincipalId: OWNER_ID,
      platform: "generic" as const,
      businessAccountKey: "merchant-opaque-key",
      label: "Merchant account",
      status: "ready" as const,
    };

    await registry.create(input);
    await expect(
      registry.create({
        ...input,
        businessIdentityId: "bid_2222222222222222",
        label: "Same identity under another label",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  test.each([
    {
      name: "half-filled record",
      snapshot: {
        version: 1,
        records: [{ ...profileRecord(), downloadRoot: undefined }],
      },
    },
    {
      name: "non-canonical runtime paths",
      snapshot: {
        version: 1,
        records: [profileRecord({ partitionKey: "persist:wrong" })],
      },
    },
    {
      name: "duplicate uniqueness keys",
      snapshot: {
        version: 1,
        records: [
          profileRecord(),
          profileRecord({
            browserProfileId: SECOND_PROFILE_ID,
            businessIdentityId: "bid_2222222222222222",
            partitionKey: `persist:paseo-enterprise-${SECOND_PROFILE_ID}`,
            downloadRoot: `/paseo/browser-profiles/${SECOND_PROFILE_ID}/downloads`,
          }),
        ],
      },
    },
  ])("fails closed when persisted storage contains a $name", async ({ snapshot }) => {
    const registry = new BrowserProfileRegistry({
      storage: new MemoryProfileStorage(snapshot),
      canonicalResolver: canonicalResolver(),
    });

    await expect(registry.initialize()).rejects.toBeInstanceOf(BrowserProfileRegistryCorruptError);
    await expect(registry.list()).rejects.toBeInstanceOf(BrowserProfileRegistryCorruptError);
  });

  test("does not publish a record when durable storage fails", async () => {
    const storage = new MemoryProfileStorage();
    storage.failWrites = true;
    const registry = new BrowserProfileRegistry({
      storage,
      canonicalResolver: canonicalResolver(),
      createProfileId: () => PROFILE_ID,
      now: () => "2026-09-09T10:00:00.000Z",
    });

    await expect(
      registry.create({
        organizationId: ORGANIZATION_ID,
        homeNodeId: NODE_ID,
        businessIdentityId: "bid_1111111111111111",
        ownerPrincipalId: OWNER_ID,
        platform: "generic",
        businessAccountKey: "merchant-opaque-key",
        label: "Merchant account",
        status: "ready",
      }),
    ).rejects.toThrow("profile storage unavailable");
    storage.failWrites = false;
    await expect(registry.list()).resolves.toEqual([]);
  });
});

describe("BrowserProfileBindingRegistry", () => {
  test("persists bindings independently and resolves only through canonical authorized context", async () => {
    const storage = new MemoryBindingStorage();
    const registry = createBindingRegistry({ storage });

    const binding = await registry.bind({
      workspace: authorizedWorkspace(),
      profile: profileRecord(),
      actor: principalContext(),
    });
    expect(binding).toEqual({
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      workspaceId: WORKSPACE_ID,
      browserProfileId: PROFILE_ID,
      boundByPrincipalId: BINDER_ID,
      boundAt: "2026-09-09T11:00:00.000Z",
    });

    const restarted = createBindingRegistry({ storage });
    await expect(
      restarted.resolveForAgent({
        workspace: authorizedWorkspace(),
        agent: authorizedAgent(),
      }),
    ).resolves.toEqual(binding);
    await expect(
      restarted.resolveForAgent({
        workspace: authorizedWorkspace(),
        agent: authorizedAgent({ ownerPrincipalId: "usr_4444444444444444" }),
      }),
    ).rejects.toThrow(/AuthorizedAgent.*canonical/i);
  });

  test("rejects cross-organization, cross-node, and cross-owner Profile binding", async () => {
    const registry = createBindingRegistry();

    await expect(
      registry.bind({
        workspace: authorizedWorkspace(),
        profile: profileRecord({ organizationId: "org_2222222222222222" }),
        actor: principalContext(),
      }),
    ).rejects.toThrow(/organization/i);
    await expect(
      registry.bind({
        workspace: authorizedWorkspace(),
        profile: profileRecord({ homeNodeId: "nod_2222222222222222" }),
        actor: principalContext(),
      }),
    ).rejects.toThrow(/node/i);
    await expect(
      registry.bind({
        workspace: authorizedWorkspace(),
        profile: profileRecord({ ownerPrincipalId: "usr_4444444444444444" }),
        actor: principalContext(),
      }),
    ).rejects.toThrow(/owner/i);
    await expect(
      registry.bind({
        workspace: authorizedWorkspace(),
        profile: profileRecord(),
        actor: principalContext({ organizationId: "org_2222222222222222" }),
      }),
    ).rejects.toThrow(/actor organization/i);
  });

  test.each([
    {
      name: "deleted",
      prepare(resolver: MemoryProfileResolver) {
        resolver.profile = null;
      },
      reason: "profile_missing",
    },
    {
      name: "corrupt",
      prepare(resolver: MemoryProfileResolver) {
        resolver.error = new BrowserProfileRegistryCorruptError("corrupt Profile registry");
      },
      reason: "profile_registry_unavailable",
    },
    {
      name: "cross-organization",
      prepare(resolver: MemoryProfileResolver) {
        resolver.profile = profileRecord({ organizationId: "org_2222222222222222" });
      },
      reason: "profile_mismatch",
    },
  ])("quarantines a binding whose Profile is $name instead of returning it", async (scenario) => {
    const profiles = new MemoryProfileResolver();
    const quarantine: BrowserProfileBindingQuarantineNotice[] = [];
    const registry = createBindingRegistry({ profiles, quarantine });
    await registry.bind({
      workspace: authorizedWorkspace(),
      profile: profileRecord(),
      actor: principalContext(),
    });
    scenario.prepare(profiles);

    await expect(
      registry.resolveForAgent({
        workspace: authorizedWorkspace(),
        agent: authorizedAgent(),
      }),
    ).rejects.toThrow(/binding.*Profile/i);
    expect(quarantine).toMatchObject([{ reason: scenario.reason }]);
  });

  test("fails closed on half-filled or duplicate persisted bindings", async () => {
    const binding: BrowserProfileBinding = {
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      workspaceId: WORKSPACE_ID,
      browserProfileId: PROFILE_ID,
      boundByPrincipalId: BINDER_ID,
      boundAt: "2026-09-09T11:00:00.000Z",
    };
    const halfFilled = createBindingRegistry({
      storage: new MemoryBindingStorage({
        version: 1,
        bindings: [{ ...binding, boundAt: undefined }],
      }),
    });
    await expect(halfFilled.initialize()).rejects.toThrow(/corrupt/i);

    const duplicate = createBindingRegistry({
      storage: new MemoryBindingStorage({
        version: 1,
        bindings: [binding, { ...binding, browserProfileId: SECOND_PROFILE_ID }],
      }),
    });
    await expect(duplicate.initialize()).rejects.toThrow(/corrupt/i);
    await expect(
      duplicate.resolveForAgent({
        workspace: authorizedWorkspace(),
        agent: authorizedAgent(),
      }),
    ).rejects.toThrow(/corrupt/i);
  });

  test("does not publish a binding when durable storage fails", async () => {
    const storage = new MemoryBindingStorage();
    storage.failWrites = true;
    const registry = createBindingRegistry({ storage });

    await expect(
      registry.bind({
        workspace: authorizedWorkspace(),
        profile: profileRecord(),
        actor: principalContext(),
      }),
    ).rejects.toThrow("binding storage unavailable");
    storage.failWrites = false;
    await expect(
      registry.resolveForAgent({
        workspace: authorizedWorkspace(),
        agent: authorizedAgent(),
      }),
    ).resolves.toBeNull();
  });
});

describe("secure Browser Profile registry files", () => {
  test("use 0700 directories and 0600 files, tighten startup modes, and survive restart", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-browser-registry-"));
    temporaryDirectories.push(temporaryDirectory);
    const profileDirectory = path.join(temporaryDirectory, "profiles");
    const bindingDirectory = path.join(temporaryDirectory, "bindings");
    const profilePath = path.join(profileDirectory, "registry.json");
    const bindingPath = path.join(bindingDirectory, "registry.json");
    const profiles = new BrowserProfileRegistry({
      storage: new JsonFileBrowserProfileStorage(profilePath),
      canonicalResolver: canonicalResolver(),
      createProfileId: () => PROFILE_ID,
      now: () => "2026-09-09T10:00:00.000Z",
    });
    await profiles.create({
      organizationId: ORGANIZATION_ID,
      homeNodeId: NODE_ID,
      businessIdentityId: "bid_1111111111111111",
      ownerPrincipalId: OWNER_ID,
      platform: "generic",
      businessAccountKey: "merchant-opaque-key",
      label: "Merchant account",
      credentialRef: "secret-reference",
      status: "ready",
    });
    const bindings = new BrowserProfileBindingRegistry({
      storage: new JsonFileBrowserProfileBindingStorage(bindingPath),
      profiles,
      now: () => "2026-09-09T11:00:00.000Z",
    });
    await bindings.bind({
      workspace: authorizedWorkspace(),
      profile: profileRecord({ credentialRef: "secret-reference" }),
      actor: principalContext(),
    });

    expect((await fs.stat(profileDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(bindingDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(profilePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(bindingPath)).mode & 0o777).toBe(0o600);

    await Promise.all([
      fs.chmod(profileDirectory, 0o777),
      fs.chmod(bindingDirectory, 0o777),
      fs.chmod(profilePath, 0o666),
      fs.chmod(bindingPath, 0o666),
    ]);
    const restartedProfiles = new BrowserProfileRegistry({
      storage: new JsonFileBrowserProfileStorage(profilePath),
      canonicalResolver: canonicalResolver(),
    });
    const restartedBindings = new BrowserProfileBindingRegistry({
      storage: new JsonFileBrowserProfileBindingStorage(bindingPath),
      profiles: restartedProfiles,
    });

    await expect(
      restartedBindings.resolveForAgent({
        workspace: authorizedWorkspace(),
        agent: authorizedAgent(),
      }),
    ).resolves.toMatchObject({ browserProfileId: PROFILE_ID });
    expect((await fs.stat(profileDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(bindingDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(profilePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(bindingPath)).mode & 0o777).toBe(0o600);
  });
});
