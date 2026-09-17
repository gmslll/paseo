import { describe, expect, test } from "vitest";
import { openShareWorkspaceForm, type ShareWorkspaceFormSnapshot } from "./share-form-model";

const OWNER = "usr_aaaaaaaaaaaaaaaa";
const EDITOR = "usr_bbbbbbbbbbbbbbbb";
const NEW_MEMBER = "usr_cccccccccccccccc";

function snapshot(overrides: Partial<ShareWorkspaceFormSnapshot> = {}): ShareWorkspaceFormSnapshot {
  return {
    viewerPrincipalId: OWNER,
    viewerRole: "owner",
    members: [
      { principalId: OWNER, role: "owner" },
      { principalId: EDITOR, role: "editor" },
    ],
    revoked: false,
    collaborationEnabled: true,
    ...overrides,
  };
}

describe("share workspace form", () => {
  test("the owner can add an editor, and that intent is the submit value", () => {
    const form = openShareWorkspaceForm(snapshot());
    form.setPrincipalId(NEW_MEMBER);
    form.setRole("viewer");

    expect(form.getState().canSubmit).toBe(true);
    expect(form.getState().submitValue).toEqual({
      principalId: NEW_MEMBER,
      role: "viewer",
    });
  });

  test("an editor cannot add or remove people", () => {
    const form = openShareWorkspaceForm(
      snapshot({ viewerPrincipalId: EDITOR, viewerRole: "editor" }),
    );
    form.setPrincipalId(NEW_MEMBER);

    const state = form.getState();
    expect(state.canManage).toBe(false);
    expect(state.canSubmit).toBe(false);
    expect(state.members.map((member) => member.canRemove)).toEqual([false, false]);
  });

  test("a revoke clears members and blocks further submits", () => {
    const form = openShareWorkspaceForm(snapshot());
    form.setPrincipalId(NEW_MEMBER);
    form.applyRevoked(true);

    const state = form.getState();
    expect(state.members).toEqual([]);
    expect(state.canSubmit).toBe(false);
    expect(state.revoked).toBe(true);
    expect(state.submitError).toBe("revoked");
  });

  test("the owner cannot be removed, and adding yourself is rejected as already present", () => {
    const form = openShareWorkspaceForm(snapshot());
    form.setPrincipalId(OWNER);

    const state = form.getState();
    expect(state.principalIssue).toBe("self");
    expect(state.canSubmit).toBe(false);
    expect(state.members.find((member) => member.role === "owner")?.canRemove).toBe(false);
    expect(state.members.find((member) => member.principalId === EDITOR)?.canRemove).toBe(true);
  });

  test("an editor targeting the owner still cannot add them as a member", () => {
    const form = openShareWorkspaceForm(
      snapshot({ viewerPrincipalId: EDITOR, viewerRole: "editor" }),
    );
    form.setPrincipalId(OWNER);

    expect(form.getState().principalIssue).toBe("owner");
    expect(form.getState().canSubmit).toBe(false);
  });

  test("a garbage person ID does not submit", () => {
    const form = openShareWorkspaceForm(snapshot());
    form.setPrincipalId("alice");

    expect(form.getState().principalIssue).toBe("invalid");
    expect(form.getState().canSubmit).toBe(false);
  });

  test("resetting the person field after a successful add clears it", () => {
    const form = openShareWorkspaceForm(snapshot());
    form.setPrincipalId(NEW_MEMBER);
    form.resetPrincipal();

    expect(form.getState().principalId).toBe("");
    expect(form.getState().principalResetKey).toBe(1);
    expect(form.getState().canSubmit).toBe(false);
  });

  test("pending submit disables a second add", () => {
    const form = openShareWorkspaceForm(snapshot());
    form.setPrincipalId(NEW_MEMBER);
    form.setSubmitting(true);

    expect(form.getState().canSubmit).toBe(false);
    expect(form.getState().isSubmitting).toBe(true);
  });
});
