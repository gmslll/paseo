import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import {
  createWorkspaceLayoutWithExplorerSidebar,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { DraftRecord } from "@/stores/draft-store/state";
import type { PendingWorkspaceDraftSubmission } from "@/stores/workspace-draft-submission-store";
import { createProductionEnterpriseResidueResetAdapter } from "./enterprise-production-residue";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeEach(() => {
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
});

afterEach(() => {
  useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
  useDraftStore.setState({ drafts: {} });
  useWorkspaceDraftSubmissionStore.setState({ pendingByDraftId: {}, setupByDraftId: {} });
  useWorkspaceAttachmentsStore.setState({ attachmentsByScope: {} });
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("production enterprise residue adapter", () => {
  it("clears real A store partitions while preserving B", () => {
    const adapter = createProductionEnterpriseResidueResetAdapter();
    const scopeA = { serverId: "server-a", lifecycleGeneration: "generation-a" };
    const scopeB = { serverId: "server-a", lifecycleGeneration: "generation-b" };
    const layoutA = "server-a:wks-a";
    const layoutB = "server-a:wks-b";
    const draftA = "draft-a";
    const draftB = "draft-b";
    const draftStoreKeyA = "draft:server-a:draft-a";
    const draftStoreKeyB = "draft:server-a:draft-b";
    const attachmentA = "workspace-attachments:server=server-a:workspace=wks-a";
    const attachmentB = "workspace-attachments:server=server-a:workspace=wks-b";
    const draftAttachmentA = "workspace-attachments:draft=draft-a";
    const draftAttachmentB = "workspace-attachments:draft=draft-b";
    const draftRecord: DraftRecord = {
      input: { text: "draft", attachments: [] },
      lifecycle: "active",
      updatedAt: 0,
      version: 1,
    };
    const submission: PendingWorkspaceDraftSubmission = {
      serverId: "server-a",
      workspaceId: "wks-a",
      draftId: draftA,
      text: "draft",
      attachments: [],
      cwd: "/tmp/a",
      provider: "codex",
      clientMessageId: "msg-a",
      timestamp: 0,
    };
    adapter.activate(scopeA);
    useWorkspaceLayoutStore.setState((state) => ({
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [layoutA]: createWorkspaceLayoutWithExplorerSidebar(),
      },
    }));
    useDraftStore.setState((state) => ({
      drafts: { ...state.drafts, [draftStoreKeyA]: draftRecord },
    }));
    useWorkspaceDraftSubmissionStore.setState((state) => ({
      pendingByDraftId: { ...state.pendingByDraftId, [draftA]: submission },
      setupByDraftId: {
        ...state.setupByDraftId,
        [draftA]: {
          setup: {
            provider: "codex",
            cwd: "/tmp/a",
            modeId: null,
            model: null,
            thinkingOptionId: null,
            featureValues: {},
          },
        },
      },
    }));
    useWorkspaceAttachmentsStore.setState((state) => ({
      attachmentsByScope: {
        ...state.attachmentsByScope,
        [attachmentA]: [],
        [draftAttachmentA]: [],
      },
    }));
    expect(useWorkspaceDraftSubmissionStore.getState().setupByDraftId).toHaveProperty(draftA);

    // Switch generations before clearing A. The old-generation reset is now late
    // and must not touch the active B partition.
    adapter.activate(scopeB);
    useWorkspaceLayoutStore.setState((state) => ({
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [layoutB]: createWorkspaceLayoutWithExplorerSidebar(),
      },
    }));
    useDraftStore.setState((state) => ({
      drafts: { ...state.drafts, [draftStoreKeyB]: draftRecord },
    }));
    useWorkspaceDraftSubmissionStore.setState((state) => ({
      pendingByDraftId: {
        ...state.pendingByDraftId,
        [draftB]: { ...submission, draftId: draftB },
      },
      setupByDraftId: {
        ...state.setupByDraftId,
        [draftB]: {
          setup: {
            provider: "codex",
            cwd: "/tmp/b",
            modeId: null,
            model: null,
            thinkingOptionId: null,
            featureValues: {},
          },
        },
      },
    }));
    useWorkspaceAttachmentsStore.setState((state) => ({
      attachmentsByScope: {
        ...state.attachmentsByScope,
        [attachmentB]: [],
        [draftAttachmentB]: [],
      },
    }));

    adapter.reset(scopeA);
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toHaveProperty(layoutB);
    expect(useDraftStore.getState().drafts).toHaveProperty(draftStoreKeyB);
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).toHaveProperty(draftB);
    expect(useWorkspaceDraftSubmissionStore.getState().setupByDraftId).toHaveProperty(draftB);
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).toHaveProperty(attachmentB);
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).toHaveProperty(
      draftAttachmentB,
    );

    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).not.toHaveProperty(layoutA);
    expect(useDraftStore.getState().drafts).not.toHaveProperty(draftStoreKeyA);
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).not.toHaveProperty(draftA);
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).not.toHaveProperty(
      attachmentA,
    );
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).not.toHaveProperty(
      draftAttachmentA,
    );

    adapter.reset(scopeB);
    // The active B reset is the only reset that clears B. (The adapter's store
    // subscriptions retain setup and attachment associations until this point.)
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).not.toHaveProperty(layoutB);
    expect(useDraftStore.getState().drafts).not.toHaveProperty(draftStoreKeyB);
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).not.toHaveProperty(draftB);
    expect(useWorkspaceDraftSubmissionStore.getState().setupByDraftId).not.toHaveProperty(draftB);
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).not.toHaveProperty(
      attachmentB,
    );
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).not.toHaveProperty(
      draftAttachmentB,
    );
  });

  it("does not register legacy or other-server writes under the active scope", () => {
    const adapter = createProductionEnterpriseResidueResetAdapter();
    const scope = { serverId: "server-a", lifecycleGeneration: "generation-filter" };
    const otherLayout = "server-b:wks-other";
    const otherDraft = "draft-other";
    const otherDraftStoreKey = "draft:server-b:draft-other";
    const otherAttachment = "workspace-attachments:server=server-b:workspace=wks-other";
    const legacyDraft = "draft-legacy";
    adapter.activate(scope);
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: { [otherLayout]: createWorkspaceLayoutWithExplorerSidebar() },
    });
    useWorkspaceDraftSubmissionStore.setState({
      pendingByDraftId: {
        [otherDraft]: {
          serverId: "server-b",
          workspaceId: "wks-other",
          draftId: otherDraft,
          text: "other",
          attachments: [],
          cwd: "/tmp/other",
          provider: "codex",
          clientMessageId: "other",
          timestamp: 0,
        },
      },
      setupByDraftId: {},
    });
    useDraftStore.setState({
      drafts: {
        [legacyDraft]: {
          input: { text: "legacy", attachments: [] },
          lifecycle: "active",
          updatedAt: 0,
          version: 1,
        },
        [otherDraftStoreKey]: {
          input: { text: "other", attachments: [] },
          lifecycle: "active",
          updatedAt: 0,
          version: 1,
        },
      },
    });
    useWorkspaceAttachmentsStore.setState({ attachmentsByScope: { [otherAttachment]: [] } });
    adapter.reset(scope);
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toHaveProperty(otherLayout);
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).toHaveProperty(otherDraft);
    expect(useDraftStore.getState().drafts).toHaveProperty(legacyDraft);
    expect(useDraftStore.getState().drafts).toHaveProperty(otherDraftStoreKey);
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).toHaveProperty(
      otherAttachment,
    );
  });

  it("captures scope values before caller mutation", () => {
    const adapter = createProductionEnterpriseResidueResetAdapter();
    const scope = { serverId: "server-a", lifecycleGeneration: "generation-captured" };
    const layoutKey = "server-a:wks-captured";
    adapter.activate(scope);
    scope.serverId = "server-b";
    scope.lifecycleGeneration = "generation-mutated";
    useWorkspaceLayoutStore.setState((state) => ({
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [layoutKey]: createWorkspaceLayoutWithExplorerSidebar(),
      },
    }));
    adapter.reset({ serverId: "server-a", lifecycleGeneration: "generation-captured" });
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).not.toHaveProperty(layoutKey);
  });
});
