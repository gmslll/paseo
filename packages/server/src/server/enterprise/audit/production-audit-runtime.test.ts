import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  AuditAppendOptions,
  AuditClock,
  AuditEvent,
  AuditEventInput,
  AuditHash,
  AuditIdSource,
  AuditSequence,
  NodeContext,
} from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DARWIN_AUDIT_STORAGE_UNAVAILABLE_REASON } from "./darwin-audit-file-system.js";
import { LocalAuditSink, Sha256AuditHash } from "./local-audit-sink.js";
import {
  AUDIT_RUNTIME_CLOSE_FAILED_REASON,
  AUDIT_RUNTIME_CLOSED_REASON,
  AUDIT_RUNTIME_RESTORE_FAILED_REASON,
  createProductionAuditRuntime,
  isCurrentProductionAuditCapability,
  productionAuditCapabilityIssuer,
  requireCurrentProductionAuditCapability,
  type ProductionAuditRuntimeOptions,
} from "./production-audit-runtime.js";

const executeFile = promisify(execFile);
const node: NodeContext = {
  nodeId: "nod_0000000000000001",
  paseoServerId: "srv_runtime",
  mode: "standalone",
};
const input: AuditEventInput = {
  organizationId: "org_0000000000000001",
  actorPrincipalId: "usr_0000000000000001",
  action: "workspace.read",
  resource: { kind: "workspace", id: "ws_runtime" },
  outcome: "allowed",
};

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function deterministicPorts(
  id: string,
  occurredAt: string,
): {
  readonly clock: AuditClock;
  readonly idSource: AuditIdSource;
} {
  return {
    clock: { now: () => occurredAt },
    idSource: { next: () => id },
  };
}

describe("production audit capability boundaries", () => {
  it("rejects wrong nodes and unsafe roots before opening the filesystem", () => {
    const options = (nodeValue: unknown, auditRoot: string): ProductionAuditRuntimeOptions =>
      ({
        node: nodeValue,
        auditRoot,
        nativeAddonPath: "/missing/darwin-audit-fs.node",
      }) as ProductionAuditRuntimeOptions;

    for (const invalidNode of [
      { ...node, nodeId: "wrong" },
      { ...node, mode: "managed" },
      { ...node, extra: true },
    ]) {
      expect(() =>
        createProductionAuditRuntime(options(invalidNode, "/private/tmp/audit")),
      ).toThrow();
    }
    for (const auditRoot of ["relative/audit", "/", "/private/tmp/../audit", "/tmp/audit\n"]) {
      expect(() => createProductionAuditRuntime(options(node, auditRoot))).toThrow(
        "invalid trusted audit root",
      );
    }
  });

  it("fails closed when a public option getter throws and performs zero filesystem work", async () => {
    const parent = await temporaryDirectory("paseo-audit-runtime-options-");
    const getterError = new Error("hostile native path getter");
    let getterCalls = 0;
    try {
      expect(() =>
        createProductionAuditRuntime({
          node,
          auditRoot: path.join(parent, "audit"),
          get nativeAddonPath() {
            getterCalls += 1;
            throw getterError;
          },
        }),
      ).toThrow(expect.objectContaining({ cause: getterError }));
      expect(getterCalls).toBe(1);
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("synchronously rejects an unavailable loader and performs zero filesystem work", async () => {
    const parent = await temporaryDirectory("paseo-audit-runtime-loader-");
    const auditRoot = path.join(parent, "audit");
    try {
      expect(() =>
        createProductionAuditRuntime({
          node,
          auditRoot,
          nativeAddonPath: path.join(parent, "missing.node"),
        }),
      ).toThrow(DARWIN_AUDIT_STORAGE_UNAVAILABLE_REASON);
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("does not accept caller releaseReady booleans or structural sink fakes", async () => {
    let appendCalls = 0;
    const fake = {
      adapterKind: "local" as const,
      node,
      releaseReady: true,
      append: async () => {
        appendCalls += 1;
        return {} as AuditEvent;
      },
      flush: async () => undefined,
      close: async () => undefined,
      ready: async () => undefined,
    };

    expect(isCurrentProductionAuditCapability(fake)).toBe(false);
    expect(productionAuditCapabilityIssuer.current(fake)).toBe(false);
    expect(() => requireCurrentProductionAuditCapability(fake)).toThrow(
      "current runtime-issued production audit capability required",
    );
    expect(() => productionAuditCapabilityIssuer.requireCurrent(fake)).toThrow(
      "current runtime-issued production audit capability required",
    );
    expect(appendCalls).toBe(0);
  });
});

describe.runIf(process.platform === "darwin")(
  "production audit runtime on real Darwin storage",
  () => {
    let buildDirectory = "";
    let addonPath = "";

    beforeAll(async () => {
      buildDirectory = await temporaryDirectory("paseo-audit-runtime-native-build-");
      addonPath = path.join(buildDirectory, "darwin-audit-fs.node");
      await executeFile(process.execPath, [
        fileURLToPath(new URL("./native/build-darwin-audit-fs.mjs", import.meta.url)),
        "--output",
        addonPath,
      ]);
    });

    afterAll(async () => {
      if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
    });

    it("issues only after restore and captures caller inputs and dependency ports", async () => {
      const parent = await temporaryDirectory("paseo-audit-runtime-capture-");
      const auditRoot = path.join(parent, "audit");
      const sha = new Sha256AuditHash();
      let addonGetterCalls = 0;
      let releaseHash: () => void = () => undefined;
      try {
        const seed = await createProductionAuditRuntime({
          node,
          auditRoot,
          nativeAddonPath: addonPath,
          ...deterministicPorts("evt_runtime_seed", "2026-01-01T00:00:00.000Z"),
        });
        await seed.append(input, { durability: "required" });
        await seed.close();

        let markHashStarted: () => void = () => undefined;
        const hashGate = new Promise<void>((resolve) => {
          releaseHash = resolve;
        });
        const hashStarted = new Promise<void>((resolve) => {
          markHashStarted = resolve;
        });
        let hashCalls = 0;
        let clockCalls = 0;
        let idCalls = 0;
        let sequenceCalls = 0;
        const clock: AuditClock = {
          now: () => {
            clockCalls += 1;
            return "2026-01-01T00:00:01.000Z";
          },
        };
        const idSource: AuditIdSource = {
          next: () => {
            idCalls += 1;
            return "evt_runtime_capture";
          },
        };
        const sequence: AuditSequence = {
          next: async (previous) => {
            sequenceCalls += 1;
            return (previous ?? 0) + 1;
          },
        };
        let firstHash = true;
        const hash: AuditHash = {
          hash: async (event) => {
            hashCalls += 1;
            if (firstHash) {
              firstHash = false;
              markHashStarted();
              await hashGate;
            }
            return sha.hash(event);
          },
        };
        const mutableNode = { ...node };
        const options = {
          node: mutableNode,
          auditRoot,
          get nativeAddonPath() {
            addonGetterCalls += 1;
            return addonGetterCalls === 1 ? addonPath : path.join(parent, "attacker.node");
          },
          clock,
          idSource,
          sequence,
          hash,
        } satisfies ProductionAuditRuntimeOptions;

        let issued = false;
        const pendingCapability = createProductionAuditRuntime(options).then((capability) => {
          issued = true;
          return capability;
        });
        await hashStarted;
        expect(issued).toBe(false);

        mutableNode.nodeId = "nod_aaaaaaaaaaaaaaaa";
        mutableNode.paseoServerId = "mutated";
        options.auditRoot = path.join(parent, "attacker");
        clock.now = () => "not-a-timestamp";
        idSource.next = () => "bad";
        sequence.next = async () => 99;
        hash.hash = async () => "bad";
        releaseHash();

        const capability = await pendingCapability;
        expect(capability.releaseReady).toBe(true);
        expect(capability.unsupportedReason).toBeUndefined();
        expect(capability.node).toEqual(node);
        expect(Object.isFrozen(capability)).toBe(true);
        expect(Object.isFrozen(capability.node)).toBe(true);
        expect(addonGetterCalls).toBe(1);
        expect(isCurrentProductionAuditCapability(capability)).toBe(true);
        expect(productionAuditCapabilityIssuer.requireCurrent(capability)).toBe(capability);

        const mutableInput = structuredClone(input);
        const appendOptions: { durability: "required" | "buffered" } = {
          durability: "required",
        };
        const append = capability.append(mutableInput, appendOptions as AuditAppendOptions);
        mutableInput.action = "workspace.delete";
        mutableInput.resource.id = "ws_attacker";
        appendOptions.durability = "buffered";
        const event = await append;

        expect(event).toMatchObject({
          eventId: "evt_runtime_capture",
          occurredAt: "2026-01-01T00:00:01.000Z",
          nodeId: node.nodeId,
          nodeEventSeq: 2,
          action: "workspace.read",
          resource: { kind: "workspace", id: "ws_runtime" },
        });
        expect({ clockCalls, idCalls, sequenceCalls, hashCalls }).toEqual({
          clockCalls: 1,
          idCalls: 1,
          sequenceCalls: 1,
          hashCalls: 2,
        });
        expect(await readdir(parent)).toEqual(["audit"]);
        await capability.close();
      } finally {
        releaseHash();
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("waits for exactly-once cleanup and aggregates restore then close failures", async () => {
      const parent = await temporaryDirectory("paseo-audit-runtime-cleanup-");
      const auditRoot = path.join(parent, "audit");
      const restoreError = new Error("deferred restore failure");
      const closeError = new Error("deferred cleanup failure");
      let releaseRestore: () => void = () => undefined;
      let rejectClose: (error: Error) => void = () => undefined;
      let markRestoreStarted: () => void = () => undefined;
      let markCloseStarted: () => void = () => undefined;
      const restoreGate = new Promise<void>((resolve) => {
        releaseRestore = resolve;
      });
      const closeGate = new Promise<void>((_resolve, reject) => {
        rejectClose = reject;
      });
      const restoreStarted = new Promise<void>((resolve) => {
        markRestoreStarted = resolve;
      });
      const closeStarted = new Promise<void>((resolve) => {
        markCloseStarted = resolve;
      });
      let closeCalls = 0;
      let settled = false;

      try {
        const seed = await createProductionAuditRuntime({
          node,
          auditRoot,
          nativeAddonPath: addonPath,
          ...deterministicPorts("evt_cleanup_seed", "2026-01-01T00:00:00.000Z"),
        });
        await seed.append(input, { durability: "required" });
        await seed.close();

        const closeSpy = vi.spyOn(LocalAuditSink.prototype, "close").mockImplementation(() => {
          closeCalls += 1;
          markCloseStarted();
          return closeGate;
        });
        try {
          const pending = createProductionAuditRuntime({
            node,
            auditRoot,
            nativeAddonPath: addonPath,
            hash: {
              hash: async () => {
                markRestoreStarted();
                await restoreGate;
                throw restoreError;
              },
            },
          });
          void pending.then(
            () => {
              settled = true;
              return undefined;
            },
            () => {
              settled = true;
              return undefined;
            },
          );

          await restoreStarted;
          expect(settled).toBe(false);
          expect(closeCalls).toBe(0);
          releaseRestore();
          await closeStarted;
          expect(closeCalls).toBe(1);
          await Promise.resolve();
          expect(settled).toBe(false);

          rejectClose(closeError);
          let failure: unknown;
          try {
            await pending;
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(AggregateError);
          expect(failure).toMatchObject({
            unsupportedReason: AUDIT_RUNTIME_RESTORE_FAILED_REASON,
            cause: restoreError,
          });
          expect((failure as AggregateError).errors).toEqual([restoreError, closeError]);
          expect(closeCalls).toBe(1);

          const structuralFake = {
            releaseReady: true,
            adapterKind: "local",
            node,
          };
          expect(isCurrentProductionAuditCapability(structuralFake)).toBe(false);
        } finally {
          closeSpy.mockRestore();
        }
      } finally {
        releaseRestore();
        rejectClose(closeError);
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("restores a real hash chain and returns no capability for tampered storage", async () => {
      const parent = await temporaryDirectory("paseo-audit-runtime-restart-");
      const auditRoot = path.join(parent, "audit");
      const auditFile = path.join(auditRoot, "audit-2026-01-01.jsonl");
      try {
        const first = await productionAuditCapabilityIssuer.issue({
          node,
          auditRoot,
          nativeAddonPath: addonPath,
          ...deterministicPorts("evt_runtime_1", "2026-01-01T00:00:00.000Z"),
        });
        const one = await first.append(input, { durability: "required" });
        await first.close();

        const second = await createProductionAuditRuntime({
          node,
          auditRoot,
          nativeAddonPath: addonPath,
          ...deterministicPorts("evt_runtime_2", "2026-01-01T00:00:01.000Z"),
        });
        const two = await second.append(input, { durability: "required" });
        expect(two).toMatchObject({ nodeEventSeq: 2, previousHash: one.eventHash });
        await second.close();

        const rows = (await readFile(auditFile, "utf8"))
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line) as AuditEvent);
        rows[0] = { ...rows[0]!, outcome: "denied" };
        await writeFile(auditFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        await chmod(auditFile, 0o600);

        await expect(
          createProductionAuditRuntime({ node, auditRoot, nativeAddonPath: addonPath }),
        ).rejects.toMatchObject({
          unsupportedReason: AUDIT_RUNTIME_RESTORE_FAILED_REASON,
          cause: expect.objectContaining({ message: "audit hash verification failure" }),
        });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("returns no capability when a persisted poison marker is found on restart", async () => {
      const parent = await temporaryDirectory("paseo-audit-runtime-poison-");
      const auditRoot = path.join(parent, "audit");
      await mkdir(auditRoot, { mode: 0o700 });
      await writeFile(path.join(auditRoot, ".audit-poisoned"), "paseo-audit-poisoned-v1\n", {
        mode: 0o600,
      });
      try {
        await expect(
          createProductionAuditRuntime({ node, auditRoot, nativeAddonPath: addonPath }),
        ).rejects.toMatchObject({
          unsupportedReason: AUDIT_RUNTIME_RESTORE_FAILED_REASON,
          cause: expect.objectContaining({ message: "audit storage poisoned" }),
        });
        expect(await readdir(auditRoot)).toEqual([".audit-poisoned"]);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("shares successful close and revokes the issued capability immediately", async () => {
      const parent = await temporaryDirectory("paseo-audit-runtime-close-");
      try {
        const capability = await createProductionAuditRuntime({
          node,
          auditRoot: path.join(parent, "audit"),
          nativeAddonPath: addonPath,
        });
        const firstClose = capability.close();
        expect(capability.close()).toBe(firstClose);
        expect(isCurrentProductionAuditCapability(capability)).toBe(false);
        expect(capability.releaseReady).toBe(false);
        expect(capability.unsupportedReason).toBe(AUDIT_RUNTIME_CLOSED_REASON);
        await expect(firstClose).resolves.toBeUndefined();
        await expect(capability.ready()).rejects.toThrow(AUDIT_RUNTIME_CLOSED_REASON);
        await expect(capability.append(input, { durability: "required" })).rejects.toThrow(
          AUDIT_RUNTIME_CLOSED_REASON,
        );
        await expect(capability.flush()).rejects.toThrow(AUDIT_RUNTIME_CLOSED_REASON);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("shares a failing close, stays revoked, and never writes through a replacement symlink", async () => {
      const parent = await temporaryDirectory("paseo-audit-runtime-close-fail-");
      const auditRoot = path.join(parent, "audit");
      const originalRoot = path.join(parent, "original-audit");
      const attackerRoot = path.join(parent, "attacker");
      try {
        const capability = await createProductionAuditRuntime({
          node,
          auditRoot,
          nativeAddonPath: addonPath,
          ...deterministicPorts("evt_runtime_close", "2026-01-01T00:00:00.000Z"),
        });
        await mkdir(auditRoot, { mode: 0o700 });
        await mkdir(attackerRoot, { mode: 0o700 });
        await rename(auditRoot, originalRoot);
        await symlink(attackerRoot, auditRoot, "dir");

        await expect(capability.append(input, { durability: "buffered" })).resolves.toMatchObject({
          eventId: "evt_runtime_close",
        });
        expect(await readdir(attackerRoot)).toEqual([]);
        const firstClose = capability.close();
        expect(capability.close()).toBe(firstClose);
        expect(isCurrentProductionAuditCapability(capability)).toBe(false);
        await expect(firstClose).rejects.toThrow();
        expect(capability.releaseReady).toBe(false);
        expect(capability.unsupportedReason).toBe(AUDIT_RUNTIME_CLOSE_FAILED_REASON);
        await expect(capability.ready()).rejects.toThrow(AUDIT_RUNTIME_CLOSE_FAILED_REASON);
        await expect(capability.append(input, { durability: "required" })).rejects.toThrow(
          AUDIT_RUNTIME_CLOSE_FAILED_REASON,
        );
        await expect(capability.flush()).rejects.toThrow(AUDIT_RUNTIME_CLOSE_FAILED_REASON);
        expect(await readdir(attackerRoot)).toEqual([]);
        expect(await readdir(originalRoot)).toEqual([]);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });
  },
);
