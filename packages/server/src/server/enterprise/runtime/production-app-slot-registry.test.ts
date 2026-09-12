import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppSlotRecord, NodeContext } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import {
  ProductionAppSlotRegistryCorruptError,
  createProductionAppSlotRegistry,
  isCurrentProductionAppSlotRegistry,
} from "./production-app-slot-registry.js";

const organizationId = "org_0123456789abcdef";
const node: NodeContext = Object.freeze({
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "srv_app_slots",
  mode: "standalone",
});
const slot: AppSlotRecord = Object.freeze({
  appSlotId: "aps_0123456789abcdef",
  organizationId,
  nodeId: node.nodeId,
  businessIdentityId: "bid_0123456789abcdef",
  appBundleId: "com.example.enterprise",
  accountBindingKey: "account-a",
  ownerPrincipalId: "usr_0123456789abcdef",
  concurrency: 1,
  credentialRef: "keychain://app-slot-a",
  status: "ready",
});

describe("production App Slot registry", () => {
  test("persists a strict v1 empty snapshot on first start instead of using an empty fallback", async () => {
    await withTemporaryHome("missing", async (paseoHome) => {
      const registry = createProductionAppSlotRegistry({ paseoHome, organizationId, node });
      expect(registry).not.toBeNull();
      expect(isCurrentProductionAppSlotRegistry(registry)).toBe(false);
      await registry!.initialize();
      expect(isCurrentProductionAppSlotRegistry(registry)).toBe(true);
      await expect(registry!.list()).resolves.toEqual([]);

      const filePath = path.join(paseoHome, "enterprise", "app-slots.json");
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ version: 1, records: [] });
      if (process.platform !== "win32") {
        expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      }
      await registry!.close();
      expect(isCurrentProductionAppSlotRegistry(registry)).toBe(false);
    });
  });

  test("treats malformed JSON and strict-schema additions as sticky corruption", async () => {
    await withTemporaryHome("corrupt-json", async (paseoHome) => {
      const filePath = await seedRaw(paseoHome, "{not-json");
      const registry = createProductionAppSlotRegistry({ paseoHome, organizationId, node });
      const first = registry!.initialize();
      await expect(first).rejects.toBeInstanceOf(ProductionAppSlotRegistryCorruptError);
      expect(isCurrentProductionAppSlotRegistry(registry)).toBe(false);
      await expect(registry!.get(slot.appSlotId)).rejects.toBeInstanceOf(
        ProductionAppSlotRegistryCorruptError,
      );
      expect(await readFile(filePath, "utf8")).toBe("{not-json");
      await registry!.close();
    });

    await withTemporaryHome("corrupt-schema", async (paseoHome) => {
      await seedSnapshot(paseoHome, { version: 1, records: [{ ...slot, extra: true }] });
      const registry = createProductionAppSlotRegistry({ paseoHome, organizationId, node });
      await expect(registry!.initialize()).rejects.toBeInstanceOf(
        ProductionAppSlotRegistryCorruptError,
      );
      expect(registry!.current()).toBe(false);
      await registry!.close();
    });
  });

  test("returns detached strict records, null for unknown ids, and survives restart", async () => {
    await withTemporaryHome("restart", async (paseoHome) => {
      await seedSnapshot(paseoHome, { version: 1, records: [slot] });
      const first = createProductionAppSlotRegistry({ paseoHome, organizationId, node });
      await first!.initialize();
      const firstRead = await first!.get(slot.appSlotId);
      expect(firstRead).toEqual(slot);
      expect(Object.isFrozen(firstRead)).toBe(true);
      await expect(first!.get("aps_ffffffffffffffff")).resolves.toBeNull();
      const firstClose = first!.close();
      const secondClose = first!.close();
      expect(firstClose).toBe(secondClose);
      await firstClose;
      await expect(first!.list()).rejects.toThrow("closed");

      const restarted = createProductionAppSlotRegistry({ paseoHome, organizationId, node });
      await restarted!.initialize();
      await expect(restarted!.list()).resolves.toEqual([slot]);
      expect(isCurrentProductionAppSlotRegistry(restarted)).toBe(true);
      await restarted!.close();
      expect(isCurrentProductionAppSlotRegistry(restarted)).toBe(false);
    });
  });

  test("rejects foreign organizations, foreign nodes, duplicate ids, and duplicate bindings", async () => {
    for (const [name, records] of [
      ["foreign-org", [{ ...slot, organizationId: "org_ffffffffffffffff" }]],
      ["foreign-node", [{ ...slot, nodeId: "nod_ffffffffffffffff" }]],
      ["duplicate-id", [slot, { ...slot }]],
      ["duplicate-binding", [slot, { ...slot, appSlotId: "aps_fedcba9876543210" }]],
    ] as const) {
      await withTemporaryHome(name, async (paseoHome) => {
        await seedSnapshot(paseoHome, { version: 1, records });
        const registry = createProductionAppSlotRegistry({ paseoHome, organizationId, node });
        await expect(registry!.initialize()).rejects.toBeInstanceOf(
          ProductionAppSlotRegistryCorruptError,
        );
        expect(isCurrentProductionAppSlotRegistry(registry)).toBe(false);
        await registry!.close();
      });
    }
  });

  test("rejects unsafe or accessor-backed construction before touching paseoHome", async () => {
    await withTemporaryHome("options", async (paseoHome) => {
      let getterCalls = 0;
      const hostile = Object.defineProperties(
        {},
        {
          paseoHome: { enumerable: true, value: paseoHome },
          organizationId: { enumerable: true, value: organizationId },
          node: {
            enumerable: true,
            get() {
              getterCalls += 1;
              return node;
            },
          },
        },
      );
      expect(createProductionAppSlotRegistry(hostile)).toBeNull();
      expect(createProductionAppSlotRegistry({ paseoHome: "/", organizationId, node })).toBeNull();
      expect(getterCalls).toBe(0);
      await expect(stat(path.join(paseoHome, "enterprise"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(isCurrentProductionAppSlotRegistry({ current: () => true })).toBe(false);
    });
  });

  test("accepts a managed node without weakening node ownership", async () => {
    await withTemporaryHome("managed", async (paseoHome) => {
      const registry = createProductionAppSlotRegistry({
        paseoHome,
        organizationId,
        node: { ...node, mode: "managed" },
      });
      expect(registry).not.toBeNull();
      await registry!.initialize();
      expect(registry!.current()).toBe(true);
      await registry!.close();
    });
  });
});

async function withTemporaryHome(
  name: string,
  operation: (paseoHome: string) => Promise<void>,
): Promise<void> {
  const paseoHome = await mkdtemp(path.join(os.tmpdir(), `paseo-app-slots-${name}-`));
  try {
    await operation(paseoHome);
  } finally {
    await rm(paseoHome, { recursive: true, force: true });
  }
}

async function seedRaw(paseoHome: string, contents: string): Promise<string> {
  const filePath = path.join(paseoHome, "enterprise", "app-slots.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, { mode: 0o600 });
  return filePath;
}

async function seedSnapshot(paseoHome: string, snapshot: unknown): Promise<string> {
  return seedRaw(paseoHome, JSON.stringify(snapshot));
}
