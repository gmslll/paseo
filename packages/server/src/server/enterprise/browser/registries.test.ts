import { describe, expect, test } from "vitest";
import type {
  AuthorizedAgent,
  AuthorizedBrowserProfile,
  AuthorizedWorkspace,
  BrowserProfileBinding,
  BrowserProfileRecord,
} from "@getpaseo/protocol/messages";
import {
  BrowserProfileBindingRegistry,
  type BrowserProfileBindingRegistrySnapshot,
  type BrowserProfileBindingStorage,
} from "./binding-registry.js";
import {
  BrowserProfileRegistry,
  BrowserProfileRegistryCorruptError,
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
    const registry = new BrowserProfileBindingRegistry({ storage });

    const binding = await registry.bind({
      workspace: authorizedWorkspace(),
      profile: profileRecord(),
      boundByPrincipalId: BINDER_ID,
      boundAt: "2026-09-09T11:00:00.000Z",
    });
    expect(binding).toEqual({
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      workspaceId: WORKSPACE_ID,
      browserProfileId: PROFILE_ID,
      boundByPrincipalId: BINDER_ID,
      boundAt: "2026-09-09T11:00:00.000Z",
    });

    const restarted = new BrowserProfileBindingRegistry({ storage });
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
    const registry = new BrowserProfileBindingRegistry({ storage: new MemoryBindingStorage() });

    await expect(
      registry.bind({
        workspace: authorizedWorkspace(),
        profile: profileRecord({ organizationId: "org_2222222222222222" }),
        boundByPrincipalId: BINDER_ID,
        boundAt: "2026-09-09T11:00:00.000Z",
      }),
    ).rejects.toThrow(/organization/i);
    await expect(
      registry.bind({
        workspace: authorizedWorkspace(),
        profile: profileRecord({ homeNodeId: "nod_2222222222222222" }),
        boundByPrincipalId: BINDER_ID,
        boundAt: "2026-09-09T11:00:00.000Z",
      }),
    ).rejects.toThrow(/node/i);
    await expect(
      registry.bind({
        workspace: authorizedWorkspace(),
        profile: profileRecord({ ownerPrincipalId: "usr_4444444444444444" }),
        boundByPrincipalId: BINDER_ID,
        boundAt: "2026-09-09T11:00:00.000Z",
      }),
    ).rejects.toThrow(/owner/i);
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
    const halfFilled = new BrowserProfileBindingRegistry({
      storage: new MemoryBindingStorage({
        version: 1,
        bindings: [{ ...binding, boundAt: undefined }],
      }),
    });
    await expect(halfFilled.initialize()).rejects.toThrow(/corrupt/i);

    const duplicate = new BrowserProfileBindingRegistry({
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
    const registry = new BrowserProfileBindingRegistry({ storage });

    await expect(
      registry.bind({
        workspace: authorizedWorkspace(),
        profile: profileRecord(),
        boundByPrincipalId: BINDER_ID,
        boundAt: "2026-09-09T11:00:00.000Z",
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
