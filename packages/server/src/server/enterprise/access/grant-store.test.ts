import { describe, expect, test } from "vitest";

import type { AuditEventInput, PrincipalContext, ResourceGrant } from "@getpaseo/protocol/messages";
import {
  GrantInvalidationError,
  GrantOrganizationMismatchError,
  GrantRevisionConflictError,
  GrantStore,
  GrantVersionSourceError,
} from "./grant-store.js";
import type { GrantRecord, GrantStorage, GrantVersionSource } from "./grant-store.js";

const actor = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  credentialId: "cred_test",
  grantVersion: "grv_0",
  grants: [],
} as const;
const audit = { append: async () => ({}) as never };

function update(store: GrantStore, input: Omit<Parameters<GrantStore["update"]>[0], "actor">) {
  return store.update({ ...input, actor });
}

class MemoryGrantStorage implements GrantStorage {
  private readonly records = new Map<string, GrantRecord>();

  async get(principalId: string): Promise<GrantRecord | null> {
    return this.records.get(principalId) ?? null;
  }

  async put(record: GrantRecord): Promise<void> {
    this.records.set(record.principalId, record);
  }
}

class TestGrantVersionSource implements GrantVersionSource {
  private version = 0;

  next(): string {
    this.version += 1;
    return `grv_${this.version}`;
  }
}

const workspaceRead: ResourceGrant = {
  action: "workspace.metadata.read",
  selector: { kind: "workspace", workspaceIds: ["wks_b", "wks_a", "wks_a"] },
};

const workspaceWrite: ResourceGrant = {
  action: "workspace.write",
  selector: { kind: "self" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("GrantStore", () => {
  test("normalizes grants and advances version only for semantic changes", async () => {
    const store = new GrantStore(new MemoryGrantStorage(), new TestGrantVersionSource(), audit);

    const first = await update(store, {
      principalId: "usr_0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      grants: [workspaceRead, workspaceWrite, workspaceRead],
      expectedVersion: null,
    });
    expect(first.changed).toBe(true);
    expect(first.current).toEqual({
      principalId: "usr_0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      grants: [
        {
          action: "workspace.metadata.read",
          selector: { kind: "workspace", workspaceIds: ["wks_a", "wks_b"] },
        },
        workspaceWrite,
      ],
      grantVersion: "grv_1",
    });

    const same = await update(store, {
      principalId: first.current.principalId,
      organizationId: first.current.organizationId,
      grants: [workspaceWrite, workspaceRead],
      expectedVersion: first.current.grantVersion,
    });
    expect(same).toEqual({ changed: false, previous: first.current, current: first.current });

    const changed = await update(store, {
      principalId: first.current.principalId,
      organizationId: first.current.organizationId,
      grants: [workspaceWrite],
      expectedVersion: first.current.grantVersion,
    });
    expect(changed.changed).toBe(true);
    expect(changed.current.grantVersion).toBe("grv_2");
  });

  test("rejects a stale expected version without writing", async () => {
    const storage = new MemoryGrantStorage();
    const store = new GrantStore(storage, new TestGrantVersionSource(), audit);
    const initial = await update(store, {
      principalId: "usr_0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      grants: [],
      expectedVersion: null,
    });

    await expect(
      update(store, {
        principalId: initial.current.principalId,
        organizationId: initial.current.organizationId,
        grants: [workspaceWrite],
        expectedVersion: "grv_stale",
      }),
    ).rejects.toBeInstanceOf(GrantRevisionConflictError);
    await expect(storage.get(initial.current.principalId)).resolves.toEqual(initial.current);
  });

  test("publishes one typed invalidation only after a changed grant is stored", async () => {
    const store = new GrantStore(new MemoryGrantStorage(), new TestGrantVersionSource(), audit);
    const invalidations: string[] = [];
    store.subscribe((change) => invalidations.push(change.grantVersion));
    const first = await update(store, {
      principalId: "usr_0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      grants: [],
      expectedVersion: null,
    });
    await update(store, {
      principalId: first.current.principalId,
      organizationId: first.current.organizationId,
      grants: [],
      expectedVersion: first.current.grantVersion,
    });
    expect(invalidations).toEqual(["grv_1"]);
  });

  test("rejects with typed error when a consumer fails after persistence", async () => {
    const store = new GrantStore(new MemoryGrantStorage(), new TestGrantVersionSource(), audit);
    const order: string[] = [];
    store.subscribe(async () => {
      order.push("first");
      throw new Error("session closed");
    });
    store.subscribe(() => {
      order.push("second");
    });
    const operation = update(store, {
      principalId: "usr_0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      grants: [],
      expectedVersion: null,
    });
    await expect(operation).rejects.toBeInstanceOf(GrantInvalidationError);
    expect(order).toEqual(["first", "second"]);
  });

  test("gives every listener an independent frozen canonical invalidation", async () => {
    const store = new GrantStore(new MemoryGrantStorage(), new TestGrantVersionSource(), audit);
    const firstFailure = new Error("first listener failed");
    let firstInvalidation: { principalId: string } | undefined;
    let secondInvalidation:
      | { principalId: string; organizationId: string; grantVersion: string }
      | undefined;
    store.subscribe((change) => {
      firstInvalidation = change;
      let mutationError: unknown = null;
      try {
        (change as { principalId: string }).principalId = "usr_fedcba9876543210";
      } catch (error) {
        mutationError = error;
      }
      expect(mutationError).toBeInstanceOf(TypeError);
      throw firstFailure;
    });
    store.subscribe((change) => {
      secondInvalidation = change;
    });

    const error = await update(store, {
      principalId: actor.principalId,
      organizationId: actor.organizationId,
      grants: [],
      expectedVersion: null,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(GrantInvalidationError);
    if (!(error instanceof GrantInvalidationError)) throw error;
    expect(error.failures).toEqual([firstFailure]);
    expect(firstInvalidation).not.toBe(secondInvalidation);
    expect(Object.isFrozen(firstInvalidation)).toBe(true);
    expect(Object.isFrozen(secondInvalidation)).toBe(true);
    expect(secondInvalidation).toEqual({
      principalId: actor.principalId,
      organizationId: actor.organizationId,
      grantVersion: "grv_1",
    });
  });

  test("snapshots the actor synchronously before a queued mutation can observe caller changes", async () => {
    const firstAuditStarted = deferred<void>();
    const releaseFirstAudit = deferred<void>();
    const events: AuditEventInput[] = [];
    const auditSink = {
      append: async (input: AuditEventInput) => {
        events.push(input);
        if (events.length === 1) {
          firstAuditStarted.resolve();
          await releaseFirstAudit.promise;
        }
        return {} as never;
      },
    };
    const store = new GrantStore(new MemoryGrantStorage(), new TestGrantVersionSource(), auditSink);
    const first = update(store, {
      principalId: actor.principalId,
      organizationId: actor.organizationId,
      grants: [],
      expectedVersion: null,
    });
    await firstAuditStarted.promise;

    const mutableActor: PrincipalContext = {
      ...actor,
      grants: [workspaceRead],
    };
    const second = store.update({
      actor: mutableActor,
      principalId: actor.principalId,
      organizationId: actor.organizationId,
      grants: [workspaceWrite],
      expectedVersion: "grv_1",
    });
    mutableActor.principalId = "usr_fedcba9876543210";
    mutableActor.organizationId = "org_fedcba9876543210";
    mutableActor.credentialId = "cred_mutated";
    mutableActor.grants[0] = workspaceWrite;
    releaseFirstAudit.resolve();

    await expect(first).resolves.toMatchObject({ current: { grantVersion: "grv_1" } });
    await expect(second).resolves.toMatchObject({ current: { grantVersion: "grv_2" } });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      organizationId: actor.organizationId,
      actorPrincipalId: actor.principalId,
      actorCredentialId: actor.credentialId,
      outcome: "allowed",
    });
  });

  test("rejects an empty initial version before audit, persistence, invalidation, or cache mutation", async () => {
    let puts = 0;
    let audits = 0;
    let invalidations = 0;
    const store = new GrantStore(
      {
        get: async () => null,
        put: async () => {
          puts += 1;
        },
      },
      { next: () => "" },
      {
        append: async () => {
          audits += 1;
          return {} as never;
        },
      },
    );
    store.subscribe(() => {
      invalidations += 1;
    });

    await expect(
      update(store, {
        principalId: actor.principalId,
        organizationId: actor.organizationId,
        grants: [],
        expectedVersion: null,
      }),
    ).rejects.toBeInstanceOf(GrantVersionSourceError);
    expect({ puts, audits, invalidations }).toEqual({ puts: 0, audits: 0, invalidations: 0 });
    expect(store.currentVersion(actor.organizationId, actor.principalId)).toBeNull();
  });

  test("rejects an unchanged update version without new side effects or cache mutation", async () => {
    const records = new Map<string, GrantRecord>();
    let puts = 0;
    let audits = 0;
    let invalidations = 0;
    const versions = ["grv_1", "grv_1"];
    const store = new GrantStore(
      {
        get: async (principalId) => records.get(principalId) ?? null,
        put: async (record) => {
          puts += 1;
          records.set(record.principalId, record);
        },
      },
      { next: () => versions.shift() as string },
      {
        append: async () => {
          audits += 1;
          return {} as never;
        },
      },
    );
    store.subscribe(() => {
      invalidations += 1;
    });
    const initial = await update(store, {
      principalId: actor.principalId,
      organizationId: actor.organizationId,
      grants: [],
      expectedVersion: null,
    });
    puts = 0;
    audits = 0;
    invalidations = 0;

    await expect(
      update(store, {
        principalId: actor.principalId,
        organizationId: actor.organizationId,
        grants: [workspaceWrite],
        expectedVersion: initial.current.grantVersion,
      }),
    ).rejects.toBeInstanceOf(GrantVersionSourceError);
    expect({ puts, audits, invalidations }).toEqual({ puts: 0, audits: 0, invalidations: 0 });
    expect(store.currentVersion(actor.organizationId, actor.principalId)).toBe("grv_1");
    expect(records.get(actor.principalId)).toEqual(initial.current);
  });

  test("rejects organization selectors that point outside the record organization", async () => {
    const store = new GrantStore(new MemoryGrantStorage(), new TestGrantVersionSource(), audit);
    await expect(
      update(store, {
        principalId: "usr_0123456789abcdef",
        organizationId: "org_0123456789abcdef",
        grants: [
          {
            action: "workspace.metadata.read",
            selector: { kind: "organization", organizationId: "org_ffffffffffffffff" },
          },
        ],
        expectedVersion: null,
      }),
    ).rejects.toBeInstanceOf(GrantOrganizationMismatchError);
  });

  test("blocks persistence and listeners when intent audit rejects", async () => {
    let puts = 0;
    let listeners = 0;
    const storage: GrantStorage = {
      get: async () => null,
      put: async () => {
        puts += 1;
      },
    };
    const blockedAudit = {
      append: async () => {
        throw new Error("audit blocked");
      },
    };
    const store = new GrantStore(storage, new TestGrantVersionSource(), blockedAudit);
    store.subscribe(() => {
      listeners += 1;
    });
    await expect(
      update(store, {
        principalId: actor.principalId,
        organizationId: actor.organizationId,
        grants: [],
        expectedVersion: null,
      }),
    ).rejects.toThrow("audit blocked");
    expect({ puts, listeners }).toEqual({ puts: 0, listeners: 0 });
  });

  test("listener failure leaves committed version and emits failed audit", async () => {
    const events: Array<{ outcome?: string; reasonCode?: string }> = [];
    const auditSink = {
      append: async (input: { outcome?: string; reasonCode?: string }) => {
        events.push(input);
      },
    };
    const store = new GrantStore(new MemoryGrantStorage(), new TestGrantVersionSource(), auditSink);
    store.subscribe(() => {
      throw new Error("listener failed");
    });
    const operation = update(store, {
      principalId: actor.principalId,
      organizationId: actor.organizationId,
      grants: [],
      expectedVersion: null,
    });
    await expect(operation).rejects.toThrow("Grant invalidation failed");
    expect(events.map((event) => event.outcome)).toEqual(["allowed", "failed"]);
    expect(store.currentVersion(actor.organizationId, actor.principalId)).toBe("grv_1");
  });

  test("storage failure preserves pre-commit state and records failed audit", async () => {
    const events: string[] = [];
    const auditSink = {
      append: async (input: { outcome?: string }) => {
        events.push(input.outcome ?? "");
      },
    };
    const storage: GrantStorage = {
      get: async () => null,
      put: async () => {
        throw new Error("disk failed");
      },
    };
    const store = new GrantStore(storage, new TestGrantVersionSource(), auditSink);
    await expect(
      update(store, {
        principalId: actor.principalId,
        organizationId: actor.organizationId,
        grants: [],
        expectedVersion: null,
      }),
    ).rejects.toThrow("before commit");
    expect(events).toEqual(["allowed", "failed"]);
    expect(store.currentVersion(actor.organizationId, actor.principalId)).toBeNull();
  });

  test("retains committed change and both listener/audit failures", async () => {
    const auditSink = {
      append: async (input: { outcome?: string }) => {
        if (input.outcome === "failed") throw new Error("audit failed");
      },
    };
    const store = new GrantStore(new MemoryGrantStorage(), new TestGrantVersionSource(), auditSink);
    store.subscribe(() => {
      throw new Error("listener failed");
    });
    const error = await update(store, {
      principalId: actor.principalId,
      organizationId: actor.organizationId,
      grants: [],
      expectedVersion: null,
    }).catch((value) => value);
    expect(error.name).toBe("GrantInvalidationError");
    expect(error.change.current.grantVersion).toBe("grv_1");
    expect(error.failures).toHaveLength(2);
  });

  test("serializes concurrent updates and rejects stale expected version", async () => {
    const store = new GrantStore(new MemoryGrantStorage(), new TestGrantVersionSource(), audit);
    const first = update(store, {
      principalId: actor.principalId,
      organizationId: actor.organizationId,
      grants: [],
      expectedVersion: null,
    });
    const second = update(store, {
      principalId: actor.principalId,
      organizationId: actor.organizationId,
      grants: [workspaceWrite],
      expectedVersion: null,
    });
    await first;
    await expect(second).rejects.toThrow("revision conflict");
    expect(store.currentVersion(actor.organizationId, actor.principalId)).toBe("grv_1");
  });

  test("serializes reads behind updates and returns the committed cache version", async () => {
    const store = new GrantStore(new MemoryGrantStorage(), new TestGrantVersionSource(), audit);
    const initial = await update(store, {
      principalId: actor.principalId,
      organizationId: actor.organizationId,
      grants: [],
      expectedVersion: null,
    });

    const mutation = update(store, {
      principalId: actor.principalId,
      organizationId: actor.organizationId,
      grants: [workspaceWrite],
      expectedVersion: initial.current.grantVersion,
    });
    const concurrentRead = store.get(actor.principalId);

    const change = await mutation;
    await expect(concurrentRead).resolves.toEqual(change.current);
    expect(store.currentVersion(actor.organizationId, actor.principalId)).toBe(
      change.current.grantVersion,
    );
  });
});
