import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  createEnterpriseResidueResetAdapter,
  type EnterpriseResidueResetAdapter,
  type EnterpriseResidueScope,
} from "./enterprise-residue-reset";

interface Keys {
  readonly layout: Set<string>;
  readonly drafts: Set<string>;
  readonly submissions: Set<string>;
  readonly attachments: Set<string>;
}

function emptyKeys(): Keys {
  return {
    layout: new Set(),
    drafts: new Set(),
    submissions: new Set(),
    attachments: new Set(),
  };
}

/**
 * Production adapter for the app stores. Store keys remain legacy-shaped; this
 * index is the only owner of their lifecycle-generation association.
 */
export type ProductionEnterpriseResidueResetAdapter = EnterpriseResidueResetAdapter;

export function createProductionEnterpriseResidueResetAdapter(): ProductionEnterpriseResidueResetAdapter {
  const byGeneration = new Map<string, Keys>();
  let activeScope: EnterpriseResidueScope | null = null;
  let suppressTracking = false;
  let unsubscribeStores: Array<() => void> = [];
  const scopeKey = (scope: EnterpriseResidueScope) =>
    `${scope.serverId}\0${scope.lifecycleGeneration}`;
  const track = (kind: keyof Keys, values: Iterable<string>) => {
    if (!activeScope || suppressTracking) return;
    const keys = byGeneration.get(scopeKey(activeScope)) ?? emptyKeys();
    for (const value of values) {
      if (kind === "layout" && !value.startsWith(`${activeScope.serverId}:`)) continue;
      if (
        kind === "attachments" &&
        !value.includes(`server=${encodeURIComponent(activeScope.serverId)}`) &&
        !(
          value.startsWith("workspace-attachments:draft=") &&
          byGeneration
            .get(scopeKey(activeScope))
            ?.submissions.has(
              decodeURIComponent(value.slice("workspace-attachments:draft=".length)),
            )
        )
      )
        continue;
      if (
        kind === "drafts" &&
        !value.startsWith(`draft:${activeScope.serverId}:`) &&
        !value.startsWith(`agent:${activeScope.serverId}:`)
      )
        continue;
      if (
        kind === "submissions" &&
        useWorkspaceDraftSubmissionStore.getState().pendingByDraftId[value]?.serverId !==
          activeScope.serverId
      )
        continue;
      keys[kind].add(value);
    }
    byGeneration.set(scopeKey(activeScope), keys);
  };
  const adapter = createEnterpriseResidueResetAdapter({
    reset: (scope) => {
      const keys = byGeneration.get(scopeKey(scope));
      if (!keys) return;
      useWorkspaceLayoutStore.setState((state) => {
        const layoutByWorkspace = { ...state.layoutByWorkspace };
        for (const key of keys.layout) delete layoutByWorkspace[key];
        return { layoutByWorkspace };
      });
      useDraftStore.setState((state) => {
        const drafts = { ...state.drafts };
        for (const key of keys.drafts) delete drafts[key];
        return { drafts };
      });
      useWorkspaceDraftSubmissionStore.setState((state) => {
        const pendingByDraftId = { ...state.pendingByDraftId };
        const setupByDraftId = { ...state.setupByDraftId };
        for (const key of keys.submissions) {
          delete pendingByDraftId[key];
          delete setupByDraftId[key];
        }
        return { pendingByDraftId, setupByDraftId };
      });
      for (const key of keys.attachments) {
        useWorkspaceAttachmentsStore.getState().clearWorkspaceAttachments({ scopeKey: key });
      }
      byGeneration.delete(scopeKey(scope));
    },
  });
  const attachStoreTracking = () => {
    if (unsubscribeStores.length > 0) return;
    unsubscribeStores = [
      useWorkspaceLayoutStore.subscribe((next, previous) => {
        track(
          "layout",
          Object.keys(next.layoutByWorkspace).filter(
            (key) => next.layoutByWorkspace[key] !== previous.layoutByWorkspace[key],
          ),
        );
      }),
      useDraftStore.subscribe((next, previous) => {
        track(
          "drafts",
          Object.keys(next.drafts).filter((key) => next.drafts[key] !== previous.drafts[key]),
        );
      }),
      useWorkspaceDraftSubmissionStore.subscribe((next, previous) => {
        const pendingKeys = Object.keys(next.pendingByDraftId).filter(
          (key) => next.pendingByDraftId[key] !== previous.pendingByDraftId[key],
        );
        track("submissions", pendingKeys);
        // Draft records and draft-scoped attachments may be written before the
        // pending submission arrives. Reconcile those stores when the
        // server-bound submission becomes visible instead of relying on write
        // ordering.
        track(
          "drafts",
          Object.keys(useDraftStore.getState().drafts).filter((key) =>
            pendingKeys.some((draftId) => key.endsWith(`:${draftId}`)),
          ),
        );
        track(
          "attachments",
          pendingKeys
            .map((key) => `workspace-attachments:draft=${encodeURIComponent(key)}`)
            .filter(
              (key) =>
                useWorkspaceAttachmentsStore.getState().attachmentsByScope[key] !== undefined,
            ),
        );
        const setupKeys = Object.keys(next.setupByDraftId).filter(
          (key) => next.setupByDraftId[key] !== previous.setupByDraftId[key],
        );
        const current = byGeneration.get(activeScope ? scopeKey(activeScope) : "");
        track(
          "submissions",
          setupKeys.filter((key) => current?.submissions.has(key) === true),
        );
      }),
      useWorkspaceAttachmentsStore.subscribe((next, previous) => {
        track(
          "attachments",
          Object.keys(next.attachmentsByScope).filter(
            (key) => next.attachmentsByScope[key] !== previous.attachmentsByScope[key],
          ),
        );
      }),
    ];
  };
  const detachStoreTracking = () => {
    for (const unsubscribe of unsubscribeStores) unsubscribe();
    unsubscribeStores = [];
  };
  const activate = (scope: EnterpriseResidueScope) => {
    const snapshot = Object.freeze({
      serverId: scope.serverId,
      lifecycleGeneration: scope.lifecycleGeneration,
    });
    detachStoreTracking();
    activeScope = null;
    adapter.activate(snapshot);
    activeScope = adapter.getActiveScope();
    attachStoreTracking();
  };
  const reset = (scope: EnterpriseResidueScope) => {
    const snapshot = Object.freeze({
      serverId: scope.serverId,
      lifecycleGeneration: scope.lifecycleGeneration,
    });
    if (
      activeScope?.serverId === snapshot.serverId &&
      activeScope.lifecycleGeneration === snapshot.lifecycleGeneration
    ) {
      activeScope = null;
      detachStoreTracking();
    }
    suppressTracking = true;
    try {
      adapter.reset(snapshot);
    } finally {
      suppressTracking = false;
    }
  };
  return Object.freeze({ ...adapter, activate, reset });
}
