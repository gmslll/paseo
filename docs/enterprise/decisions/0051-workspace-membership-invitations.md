# ADR-0051: Workspace membership invitations

- Status: Proposed — drafted 2026-09-16 at the integration owner's request, awaiting their decision
- Date: 2026-09-16
- Decision owner: Enterprise integration owner

## Problem

ADR-0033 says only that invitations stay inside one organization and that public share links are
out of scope. ADR-0037 requires `required` audit on membership invite and accept. Nothing anywhere
says what an invitation is: no route, no token, no lifetime, no rule for what happens when one is
presented twice. Membership today is added by an administrator calling `setCollabMember` directly,
so invite and accept have nothing to audit and `collab_invites` has nothing to hold.

## Decision

An invitation is a short-lived secret that names one Workspace and one role. It is modelled on the
node enrollment token, which already solves the same shape in this plane: a hashed secret with a
bounded lifetime, redeemed once, idempotent when the same party presents it again.

- Identity `inv_<24 hex>`, token `pso_inv_<id>.<secret>`. The secret is stored as salt and digest
  and never in plaintext, the same construction as enrollment tokens and personal access tokens.
- Created by the Workspace owner. It names `editor` or `viewer`. An invitation never names `owner`:
  ADR-0033 keeps exactly one, and ownership moves through ADR-0027 transfer, not through an invite.
- Lifetime is bounded, default seven days, minimum one hour, maximum thirty. Enrollment tokens are
  capped at a day because a machine is enrolled by someone already at the keyboard; an invitation
  waits on a person reading their messages.
- Accepting requires an authenticated Principal of the same organization. The token alone admits
  nobody: it selects which Workspace and role, and the credential decides who. This is what keeps
  ADR-0033's organization boundary true even if a token leaks.
- Accepting creates the membership through the existing path, so the Grant projection and the Grant
  version increment stay in one place.
- Presenting a redeemed invitation again returns the membership it already created when it is the
  same Principal, and is refused otherwise. A retried request should not fail, and a forwarded one
  should not admit a stranger.
- The owner may revoke an unredeemed invitation. A redeemed one is undone by removing the member,
  not by revoking the invitation.
- Invite, accept, and revoke are `required` audit events under ADR-0037, recording the Workspace,
  the role, and the inviting and accepting Principals. The token and its secret are never recorded.

Routes, alongside the existing collaboration routes:

| Route                                               | Who              | Effect                         |
| --------------------------------------------------- | ---------------- | ------------------------------ |
| `POST /v1/collab/workspaces/<workspaceUid>/invites` | Workspace owner  | creates one, returns the token |
| `POST /v1/collab/invites/accept`                    | any member-to-be | redeems it, creates membership |
| `DELETE /v1/collab/invites/<inviteId>`              | Workspace owner  | revokes an unredeemed one      |

Table `collab_invites`: invite id, workspace uid, organization id, role, salt and digest, expiry,
created by, created at, redeemed at, redeemed principal id, revoked at.

## For the decision owner

Three points are choices rather than consequences, and this ADR is not accepted until they are
settled:

1. **Who may invite.** Drafted as the Workspace owner alone. Today `setCollabMember` requires
   `identity.manage`, so as drafted an owner gains a power they do not currently have. The
   alternatives are to keep it with platform administrators, or to let editors invite viewers.
2. **Lifetime.** Seven days is a guess at how long an invitation should wait for a person. Nothing
   in the specs implies a number.
3. **Whether viewer invitations ship in V1**, or whether invitations are editors only until the
   viewer experience exists.

## Acceptance

Tests prove that an expired, revoked, or already-redeemed-by-someone-else invitation is refused;
that redeeming twice as the same Principal is idempotent; that a Principal outside the organization
is refused even with a valid token; that accepting produces the same membership and Grant version
increment as `setCollabMember`; and that no audit event contains the token or its secret.
