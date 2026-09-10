import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createEnterpriseIdentityLifecycle,
  type EnterpriseIdentityLifecycle,
  type ProcessCredentialVault,
} from "@getpaseo/client/internal/enterprise-identity-lifecycle";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { defaultHostAppearance } from "@/hosts/appearance";
import { flushDraftPersistStorage, useDraftStore } from "@/stores/draft-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import {
  createEnterpriseFileRequestFactory,
  HostRuntimeController,
  type BrowserProfileRuntimeBridge,
} from "./host-runtime";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalIndexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
const originalIdbKeyRangeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");

beforeEach(() => {
  Object.defineProperties(globalThis, {
    indexedDB: { configurable: true, value: new IDBFactory() },
    IDBKeyRange: { configurable: true, value: IDBKeyRange },
  });
});

function resetResidueStores(): void {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    splitSizesByWorkspace: {},
    explorerSidebarWidthByWorkspace: {},
    pinnedAgentIdsByWorkspace: {},
    pendingAgentIdsByWorkspace: {},
    hiddenAgentIdsByWorkspace: {},
    focusRestorationByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
  });
  useDraftStore.setState({ drafts: {}, createModalDraft: null });
  useWorkspaceDraftSubmissionStore.setState({ pendingByDraftId: {}, setupByDraftId: {} });
  useWorkspaceAttachmentsStore.setState({ attachmentsByScope: {} });
}

afterEach(async () => {
  resetResidueStores();
  await flushDraftPersistStorage();
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
  if (originalIndexedDbDescriptor) {
    Object.defineProperty(globalThis, "indexedDB", originalIndexedDbDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "indexedDB");
  }
  if (originalIdbKeyRangeDescriptor) {
    Object.defineProperty(globalThis, "IDBKeyRange", originalIdbKeyRangeDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "IDBKeyRange");
  }
});

function browserAttachment(label: string): WorkspaceComposerAttachment {
  return {
    kind: "browser_element",
    attachment: {
      url: "https://example.test",
      selector: `button[data-owner=${label}]`,
      tag: "button",
      text: label,
      outerHTML: `<button data-owner="${label}">${label}</button>`,
      computedStyles: {},
      boundingRect: { x: 0, y: 0, width: 100, height: 40 },
      reactSource: null,
      parentChain: [],
      children: [],
      formatted: label,
    },
  };
}

function residueKeys(serverId: string, owner: "a" | "b") {
  const workspaceId = `wks_${owner.repeat(16)}`;
  const draftId = `draft-${owner}`;
  return {
    workspaceId,
    workspaceKey: `${serverId}:${workspaceId}`,
    draftId,
    draftKey: `draft:${serverId}:${draftId}`,
    workspaceAttachmentKey: buildWorkspaceAttachmentScopeKey({
      serverId,
      workspaceId,
      cwd: `/tmp/${owner}`,
    }),
    draftAttachmentKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
  };
}

function writeResidue(
  serverId: string,
  owner: "a" | "b",
  keys: ReturnType<typeof residueKeys>,
): void {
  const text = `private-${owner}`;
  const tabId = useWorkspaceLayoutStore.getState().openTab({
    workspaceKey: keys.workspaceKey,
    target: { kind: "draft", draftId: keys.draftId },
    intent: "new",
  });
  expect(tabId).toEqual(expect.any(String));
  useDraftStore.getState().saveDraftInput({
    draftKey: keys.draftKey,
    draft: { text, attachments: [] },
  });
  useWorkspaceDraftSubmissionStore.getState().setPending({
    serverId,
    workspaceId: keys.workspaceId,
    draftId: keys.draftId,
    text,
    attachments: [],
    cwd: `/tmp/${owner}`,
    provider: "codex",
    clientMessageId: `message-${owner}`,
    timestamp: owner === "a" ? 1 : 2,
  });
  useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
    draftId: keys.draftId,
    setup: {
      provider: "codex",
      cwd: `/tmp/${owner}`,
      modeId: null,
      model: null,
      thinkingOptionId: null,
      featureValues: {},
    },
  });
  useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
    scopeKey: keys.workspaceAttachmentKey,
    attachments: [browserAttachment(`workspace-${owner}`)],
  });
  useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
    scopeKey: keys.draftAttachmentKey,
    attachments: [browserAttachment(`draft-${owner}`)],
  });
}

function expectResiduePresent(keys: ReturnType<typeof residueKeys>, text: string): void {
  expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toHaveProperty(keys.workspaceKey);
  expect(useWorkspaceLayoutStore.getState().getWorkspaceTabs(keys.workspaceKey)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: { kind: "draft", draftId: keys.draftId } }),
    ]),
  );
  expect(useDraftStore.getState().getDraftInput(keys.draftKey)).toEqual({
    text,
    attachments: [],
  });
  expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).toHaveProperty(keys.draftId);
  expect(useWorkspaceDraftSubmissionStore.getState().setupByDraftId).toHaveProperty(keys.draftId);
  expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).toHaveProperty(
    keys.workspaceAttachmentKey,
  );
  expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).toHaveProperty(
    keys.draftAttachmentKey,
  );
}

function expectResidueAbsent(keys: ReturnType<typeof residueKeys>): void {
  expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).not.toHaveProperty(
    keys.workspaceKey,
  );
  expect(useDraftStore.getState().getDraftInput(keys.draftKey)).toBeUndefined();
  expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).not.toHaveProperty(
    keys.draftId,
  );
  expect(useWorkspaceDraftSubmissionStore.getState().setupByDraftId).not.toHaveProperty(
    keys.draftId,
  );
  expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).not.toHaveProperty(
    keys.workspaceAttachmentKey,
  );
  expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).not.toHaveProperty(
    keys.draftAttachmentKey,
  );
}

function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function containsSecretOrFingerprint(value: string, secrets: readonly string[]): boolean {
  for (const secret of secrets) {
    if (value.includes(secret) || value.includes(fingerprint(secret))) return true;
  }
  return false;
}

async function expectClientSurfacesExcludeSecrets(
  input: {
    readonly controller: HostRuntimeController;
    readonly lifecycle: EnterpriseIdentityLifecycle;
    readonly vault: ProcessCredentialVault;
    readonly logs: readonly unknown[];
    readonly localStorageValues: ReadonlyMap<string, string>;
  },
  secrets: readonly string[],
): Promise<void> {
  await flushDraftPersistStorage();
  const storageKeys = await AsyncStorage.getAllKeys();
  const persistedStorage = await AsyncStorage.multiGet(storageKeys);
  const serialized = JSON.stringify({
    hostSnapshot: input.controller.getSnapshot(),
    identitySnapshot: input.lifecycle.readSnapshot(),
    vault: input.vault,
    vaultKeys: Reflect.ownKeys(input.vault),
    layout: useWorkspaceLayoutStore.getState(),
    drafts: useDraftStore.getState(),
    submissions: useWorkspaceDraftSubmissionStore.getState(),
    attachments: useWorkspaceAttachmentsStore.getState(),
    persistedStorage,
    localStorage: [...input.localStorageValues.entries()],
    logs: input.logs,
  });
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(fingerprint(secret));
  }
}

describe("production enterprise app residue lifecycle", () => {
  it("keeps PATs out of snapshots and caches across A revoke and B login", async () => {
    const tokenA = "pso_u_credA.A1Wz4zvsvS5l1mbqLh9jR3F0dT8uY2xK6pN7cQeV9Mo";
    const tokenB = "pso_u_credB.B7Xm2qL8vC4sN9kH1rT6wP3dF5yJ0uGzE8aM4iQn2Rs";
    const wrongToken = "pso_u_wrong.C9Vn5xK2mD7qR1tF8wH4sL6jP0yB3uGzE5aM9iQn7Ro";
    const secrets = [tokenA, tokenB, wrongToken] as const;
    const localStorageValues = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          get length() {
            return localStorageValues.size;
          },
          clear: () => localStorageValues.clear(),
          getItem: (key: string) => localStorageValues.get(key) ?? null,
          key: (index: number) => [...localStorageValues.keys()][index] ?? null,
          removeItem: (key: string) => localStorageValues.delete(key),
          setItem: (key: string, value: string) => localStorageValues.set(key, value),
        },
      },
    });
    resetResidueStores();
    const serverId = "server-case8";
    let fileRequestCount = 0;
    let transportMetadataSafe = true;
    const fileServer = createServer((request, response) => {
      const requestMetadata = JSON.stringify({ method: request.method, url: request.url });
      transportMetadataSafe &&= !containsSecretOrFingerprint(requestMetadata, secrets);
      const authorization = request.headers.authorization;
      let principal: "a" | "b" | null = null;
      if (authorization === `Bearer ${tokenA}`) principal = "a";
      else if (authorization === `Bearer ${tokenB}`) principal = "b";
      if (!principal) {
        response.writeHead(401).end();
        return;
      }
      fileRequestCount += 1;
      response.writeHead(200, { "content-type": "text/plain" }).end(`ok-${principal}`);
    });
    fileServer.listen(0, "127.0.0.1");
    await once(fileServer, "listening");
    const fileAddress = fileServer.address() as AddressInfo;
    const connection: HostConnection = {
      id: `direct:127.0.0.1:${fileAddress.port}`,
      type: "directTcp",
      endpoint: `127.0.0.1:${fileAddress.port}`,
    };
    const host: HostProfile = {
      serverId,
      label: "case 8 host",
      appearance: defaultHostAppearance(),
      lifecycle: {},
      connections: [connection],
      preferredConnectionId: connection.id,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const events: string[] = [];
    const logs: unknown[] = [];
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation((...args) => logs.push({ level: "warn", args }));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => logs.push({ level: "error", args }));
    const keysA = residueKeys(serverId, "a");
    const keysB = residueKeys(serverId, "b");
    let lifecycle!: EnterpriseIdentityLifecycle;
    let vault!: ProcessCredentialVault;
    let generationA: ReturnType<EnterpriseIdentityLifecycle["readSnapshot"]>["generation"];
    const bridge: BrowserProfileRuntimeBridge = {
      hydrateBrowserProfileAuthorizations: async ({ lifecycleGeneration }) => {
        events.push(`hydrate:${lifecycleGeneration}`);
      },
      revokeBrowserProfileGeneration: async ({ lifecycleGeneration }) => {
        events.push(`revoke:${lifecycleGeneration}`);
        if (lifecycleGeneration === generationA) expectResidueAbsent(keysA);
      },
    };
    const controller = new HostRuntimeController({
      host,
      deps: {
        browserProfileRuntimeBridge: bridge,
        createEnterpriseIdentityLifecycle: ({ vault: inputVault, ports }) => {
          vault = inputVault;
          lifecycle = createEnterpriseIdentityLifecycle({ vault, ports });
          return lifecycle;
        },
        createEnterpriseIdentityLifecyclePorts: () => ({
          authenticate: async ({ token }) => {
            let owner: "a" | "b" | null = null;
            if (token === tokenA) owner = "a";
            else if (token === tokenB) owner = "b";
            if (!owner) throw new Error("Enterprise credential rejected");
            return {
              projection: {
                principalType: "human",
                principalId: owner === "a" ? "usr_aaaaaaaaaaaaaaaa" : "usr_bbbbbbbbbbbbbbbb",
                organizationId: "org_aaaaaaaaaaaaaaaa",
                nodeId: "nod_aaaaaaaaaaaaaaaa",
                paseoServerId: serverId,
                displayName: owner === "a" ? "Employee A" : "Employee B",
                grantVersion: owner === "a" ? "grant-a" : "grant-b",
                navigation: [],
                allowedOperations: [],
              },
              sessionBindingKey: owner === "a" ? "binding-a" : "binding-b",
              teardownAttempt: async () => {},
            };
          },
          teardown: {
            stopNetworkAndSubscriptions: async () => {
              events.push("stop-network");
              if (generationA) expectResidueAbsent(keysA);
            },
            disposeRuntimeAndCachePartition: async () => {
              events.push("dispose-runtime");
            },
            destroyDaemonClient: async () => {
              events.push("destroy-client");
            },
            startNewClient: async () => {
              events.push("start-client");
            },
            hydrateScope: async () => {
              events.push("hydrate-scope");
            },
          },
          remoteLogout: { logoutAll: async () => {} },
        }),
        createClient: () => {
          throw new Error("connection is outside this app-boundary test");
        },
        connectToDaemon: async () => {
          throw new Error("connection is outside this app-boundary test");
        },
        getClientId: async () => "cid_case8",
      },
    });
    const enterpriseFileRequest = createEnterpriseFileRequestFactory({
      lifecycle,
    })({ host, connection, clientId: "cid_case8", runtimeGeneration: 1 });
    expect(enterpriseFileRequest).toBeTypeOf("function");
    expect(Object.isFrozen(vault)).toBe(true);
    expect(Object.keys(vault)).toEqual([]);
    expect(JSON.stringify(vault)).toBe("{}");

    try {
      await expect(
        lifecycle.authenticateEnterpriseHost({ serverId, token: wrongToken }),
      ).rejects.toThrow("rejected");
      await expectClientSurfacesExcludeSecrets(
        { controller, lifecycle, vault, logs, localStorageValues },
        secrets,
      );

      await lifecycle.authenticateEnterpriseHost({ serverId, token: tokenA });
      generationA = lifecycle.readSnapshot().generation;
      expect(generationA).toEqual(expect.any(String));
      expect(controller.getEnterpriseScopeGeneration()).toBe(generationA);
      events.length = 0;
      writeResidue(serverId, "a", keysA);
      expectResiduePresent(keysA, "private-a");
      await controller.hydrateBrowserProfileAuthorizations({
        lifecycleGeneration: generationA!,
        authorizations: [
          {
            organizationId: "org_aaaaaaaaaaaaaaaa",
            homeNodeId: "nod_aaaaaaaaaaaaaaaa",
            workspaceId: keysA.workspaceId,
            browserProfileId: "brp_aaaaaaaaaaaaaaaa",
            bindingRevision: "binding-revision-a",
            lifecycleGeneration: generationA!,
          },
        ],
      });
      await expect(
        enterpriseFileRequest!({
          serverId,
          workspaceId: keysA.workspaceId,
          relativePath: "private-a.txt",
          scopeGeneration: generationA!,
        }),
      ).resolves.toMatchObject({ status: 200 });
      expect(fileRequestCount).toBe(1);
      expect(transportMetadataSafe).toBe(true);
      await expectClientSurfacesExcludeSecrets(
        { controller, lifecycle, vault, logs, localStorageValues },
        secrets,
      );

      await lifecycle.credentialRevoked({
        serverId,
        generation: generationA!,
        sessionBindingKey: "binding-a",
      });
      expectResidueAbsent(keysA);
      expect(events.indexOf(`revoke:${generationA}`)).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(`revoke:${generationA}`)).toBeLessThan(events.indexOf("stop-network"));
      await expect(
        enterpriseFileRequest!({
          serverId,
          workspaceId: keysA.workspaceId,
          relativePath: "late-a.txt",
          scopeGeneration: generationA!,
        }),
      ).rejects.toThrow("no longer current");

      await lifecycle.authenticateEnterpriseHost({ serverId, token: tokenB });
      const generationB = lifecycle.readSnapshot().generation;
      expect(generationB).toEqual(expect.any(String));
      expect(controller.getEnterpriseScopeGeneration()).toBe(generationB);
      expect(generationB).not.toBe(generationA);
      writeResidue(serverId, "b", keysB);
      expectResiduePresent(keysB, "private-b");
      await expect(
        enterpriseFileRequest!({
          serverId,
          workspaceId: keysB.workspaceId,
          relativePath: "private-b.txt",
          scopeGeneration: generationB!,
        }),
      ).resolves.toMatchObject({ status: 200 });
      expect(fileRequestCount).toBe(2);
      expect(transportMetadataSafe).toBe(true);

      await lifecycle.credentialRevoked({
        serverId,
        generation: generationA!,
        sessionBindingKey: "binding-a",
      });
      await expect(
        controller.hydrateBrowserProfileAuthorizations({
          lifecycleGeneration: generationA!,
          authorizations: [
            {
              organizationId: "org_aaaaaaaaaaaaaaaa",
              homeNodeId: "nod_aaaaaaaaaaaaaaaa",
              workspaceId: keysA.workspaceId,
              browserProfileId: "brp_aaaaaaaaaaaaaaaa",
              bindingRevision: "late-binding-a",
              lifecycleGeneration: generationA!,
            },
          ],
        }),
      ).rejects.toThrow("generation");
      expectResidueAbsent(keysA);
      expectResiduePresent(keysB, "private-b");
      expect(JSON.stringify(useDraftStore.getState().drafts)).not.toContain("private-a");
      expect(JSON.stringify(useDraftStore.getState().drafts)).toContain("private-b");
      await expectClientSurfacesExcludeSecrets(
        { controller, lifecycle, vault, logs, localStorageValues },
        secrets,
      );
      await lifecycle.logoutCurrent(serverId);
      await expect(
        enterpriseFileRequest!({
          serverId,
          workspaceId: keysB.workspaceId,
          relativePath: "late-b.txt",
          scopeGeneration: generationB!,
        }),
      ).rejects.toThrow("no longer current");
      expect(fileRequestCount).toBe(2);
      await expectClientSurfacesExcludeSecrets(
        { controller, lifecycle, vault, logs, localStorageValues },
        secrets,
      );
    } finally {
      if (lifecycle.readSnapshot().state === "signed_in") {
        await lifecycle.logoutCurrent(serverId);
      }
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        fileServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
