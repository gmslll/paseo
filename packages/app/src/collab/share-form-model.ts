import { ManagedPrincipalIdSchema } from "@getpaseo/protocol/messages";
import type {
  WorkspaceMember,
  WorkspaceMemberRole,
} from "@getpaseo/protocol/enterprise-collaboration";

export type ShareableMemberRole = Exclude<WorkspaceMemberRole, "owner">;
export type SharePrincipalIssue = "invalid" | "self" | "owner";
export type ShareSubmitError = "revoked" | "failed" | "enable_failed";

export interface ShareWorkspaceFormSnapshot {
  readonly viewerPrincipalId: string;
  readonly viewerRole: WorkspaceMemberRole | null;
  readonly members: readonly WorkspaceMember[];
  readonly revoked: boolean;
  readonly collaborationEnabled: boolean;
  readonly canEnable: boolean;
}

export interface ShareWorkspaceMemberRow {
  readonly principalId: string;
  readonly role: WorkspaceMemberRole;
  readonly isSelf: boolean;
  readonly canRemove: boolean;
}

export interface ShareWorkspaceFormState {
  readonly principalId: string;
  readonly role: ShareableMemberRole;
  readonly members: readonly ShareWorkspaceMemberRow[];
  readonly principalIssue: SharePrincipalIssue | null;
  readonly canManage: boolean;
  readonly canEnable: boolean;
  readonly collaborationEnabled: boolean;
  readonly canSubmit: boolean;
  readonly isSubmitting: boolean;
  readonly submitError: ShareSubmitError | null;
  readonly revoked: boolean;
  readonly principalResetKey: number;
  readonly submitValue: { principalId: string; role: ShareableMemberRole } | null;
}

export interface ShareWorkspaceFormModel {
  getState: () => ShareWorkspaceFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setPrincipalId: (value: string) => void;
  resetPrincipal: () => void;
  setRole: (value: ShareableMemberRole) => void;
  setSubmitting: (value: boolean) => void;
  setSubmitError: (value: ShareSubmitError | null) => void;
  applyMembers: (members: readonly WorkspaceMember[]) => void;
  applyRevoked: (revoked: boolean) => void;
  applySnapshot: (snapshot: Omit<ShareWorkspaceFormSnapshot, "viewerPrincipalId">) => void;
}

function cloneMembers(members: readonly WorkspaceMember[]): WorkspaceMember[] {
  return members.map((member) => ({ ...member }));
}

function ownerPrincipalId(members: readonly WorkspaceMember[]): string | null {
  return members.find((member) => member.role === "owner")?.principalId ?? null;
}

export function openShareWorkspaceForm(
  snapshot: ShareWorkspaceFormSnapshot,
): ShareWorkspaceFormModel {
  const viewerPrincipalId = snapshot.viewerPrincipalId;
  let viewerRole = snapshot.viewerRole;
  let principalId = "";
  let role: ShareableMemberRole = "editor";
  let members = cloneMembers(snapshot.members);
  let revoked = snapshot.revoked;
  let collaborationEnabled = snapshot.collaborationEnabled;
  let canEnableFlag = snapshot.canEnable;
  let isSubmitting = false;
  let submitError: ShareSubmitError | null = null;
  let principalResetKey = 0;
  let listeners = new Set<() => void>();
  let closed = false;

  function publish(): void {
    if (closed) return;
    for (const listener of listeners) listener();
  }

  function derive(): ShareWorkspaceFormState {
    const canManage = collaborationEnabled && !revoked && viewerRole === "owner";
    const canEnable = canEnableFlag && !collaborationEnabled && !revoked && !isSubmitting;
    const trimmed = principalId.trim();
    const ownerId = ownerPrincipalId(members);
    let principalIssue: SharePrincipalIssue | null = null;
    if (trimmed.length > 0 && !ManagedPrincipalIdSchema.safeParse(trimmed).success) {
      principalIssue = "invalid";
    } else if (trimmed === viewerPrincipalId) {
      principalIssue = "self";
    } else if (ownerId !== null && trimmed === ownerId) {
      principalIssue = "owner";
    }
    const canSubmit = canManage && !isSubmitting && trimmed.length > 0 && principalIssue === null;
    return {
      principalId,
      role,
      members: members.map((member) => ({
        principalId: member.principalId,
        role: member.role,
        isSelf: member.principalId === viewerPrincipalId,
        canRemove: canManage && !isSubmitting && member.role !== "owner",
      })),
      principalIssue,
      canManage,
      canEnable,
      collaborationEnabled,
      canSubmit,
      isSubmitting,
      submitError: revoked ? "revoked" : submitError,
      revoked,
      principalResetKey,
      submitValue: canSubmit ? { principalId: trimmed, role } : null,
    };
  }

  return {
    getState: derive,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners = new Set();
    },
    setPrincipalId(value) {
      principalId = value;
      submitError = null;
      publish();
    },
    resetPrincipal() {
      principalId = "";
      principalResetKey += 1;
      submitError = null;
      publish();
    },
    setRole(value) {
      role = value;
      publish();
    },
    setSubmitting(value) {
      isSubmitting = value;
      if (value) submitError = null;
      publish();
    },
    setSubmitError(value) {
      submitError = value;
      isSubmitting = false;
      publish();
    },
    applyMembers(nextMembers) {
      members = cloneMembers(nextMembers);
      publish();
    },
    applyRevoked(nextRevoked) {
      revoked = nextRevoked;
      if (nextRevoked) {
        isSubmitting = false;
        members = [];
        submitError = "revoked";
        canEnableFlag = false;
      }
      publish();
    },
    applySnapshot(next) {
      viewerRole = next.viewerRole;
      members = cloneMembers(next.members);
      revoked = next.revoked;
      collaborationEnabled = next.collaborationEnabled;
      canEnableFlag = next.canEnable;
      if (next.revoked) {
        isSubmitting = false;
        members = [];
        submitError = "revoked";
        canEnableFlag = false;
      }
      publish();
    },
  };
}
