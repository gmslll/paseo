import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { MemoryEnterpriseIdentityLifecycle } from "@getpaseo/client/internal/enterprise-identity-lifecycle";
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

describe("production enterprise app residue lifecycle", () => {
  it("clears A stores before browser and network teardown, then isolates B from late A events", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        },
      },
    });
    resetResidueStores();
    const serverId = "server-case8";
    const connection: HostConnection = {
      id: "direct:127.0.0.1:1",
      type: "directTcp",
      endpoint: "127.0.0.1:1",
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
    const keysA = residueKeys(serverId, "a");
    const keysB = residueKeys(serverId, "b");
    let lifecycle!: MemoryEnterpriseIdentityLifecycle;
    let generationA: ReturnType<MemoryEnterpriseIdentityLifecycle["readSnapshot"]>["generation"];
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
        createEnterpriseIdentityLifecycle: ({ vault, ports }) => {
          lifecycle = new MemoryEnterpriseIdentityLifecycle(
            vault,
            ports.authenticate,
            ports.teardown,
            ports.remoteLogout,
          );
          return lifecycle;
        },
        createEnterpriseIdentityLifecyclePorts: () => ({
          authenticate: async ({ token }) => ({
            projection: {
              principalType: "human",
              principalId:
                token === "local-token-a" ? "usr_aaaaaaaaaaaaaaaa" : "usr_bbbbbbbbbbbbbbbb",
              organizationId: "org_aaaaaaaaaaaaaaaa",
              nodeId: "nod_aaaaaaaaaaaaaaaa",
              paseoServerId: serverId,
              displayName: token === "local-token-a" ? "Employee A" : "Employee B",
              grantVersion: token === "local-token-a" ? "grant-a" : "grant-b",
              navigation: [],
              allowedOperations: [],
            },
            sessionBindingKey: token === "local-token-a" ? "binding-a" : "binding-b",
            teardownAttempt: async () => {},
          }),
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
    const fileTransport = vi.fn(async () => new Response("ok", { status: 200 }));
    const enterpriseFileRequest = createEnterpriseFileRequestFactory({
      lifecycle,
      fetch: fileTransport,
    })({ host, connection, clientId: "cid_case8", runtimeGeneration: 1 });
    expect(enterpriseFileRequest).toBeTypeOf("function");

    try {
      await lifecycle.authenticateEnterpriseHost({ serverId, token: "local-token-a" });
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

      await lifecycle.logoutCurrent(serverId);
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

      await lifecycle.authenticateEnterpriseHost({ serverId, token: "local-token-b" });
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
      expect(fileTransport).toHaveBeenCalledTimes(2);
    } finally {
      if (lifecycle.readSnapshot().state === "signed_in") {
        await lifecycle.logoutCurrent(serverId);
      }
    }
  });
});
