import { PRESENCE_TTL_MS, type PresenceEntry } from "@getpaseo/protocol/enterprise-collaboration";
import type { CollabCopy } from "./copy";
import { formatCollabCopy } from "./copy";

export interface TimelineAuthor {
  readonly principalId: string;
  readonly displayName?: string;
}

export interface QueuedTurnView {
  readonly messageId: string;
  readonly author: TimelineAuthor;
  readonly queuedAt: string;
}

export interface PresencePerson {
  readonly id: string;
  readonly label: string;
  readonly isSelf: boolean;
  readonly isNode: boolean;
  readonly clientCount: number;
  readonly focusAgentId: string | null;
}

export interface CollabBanner {
  readonly title: string;
  readonly description: string;
}

function authorName(author: TimelineAuthor, copy: CollabCopy, viewerPrincipalId: string): string {
  if (author.principalId === viewerPrincipalId) return copy.author.you;
  if (author.displayName && author.displayName.length > 0) return author.displayName;
  return author.principalId;
}

export function projectPresence(input: {
  entries: readonly PresenceEntry[];
  viewerPrincipalId: string;
  now: number;
  copy: CollabCopy;
  ttlMs?: number;
}): readonly PresencePerson[] {
  const ttlMs = input.ttlMs ?? PRESENCE_TTL_MS;
  const grouped = new Map<string, PresencePerson>();
  for (const entry of input.entries) {
    const heartbeatAt = Date.parse(entry.heartbeatAt);
    if (Number.isNaN(heartbeatAt) || input.now - heartbeatAt >= ttlMs) continue;
    if (entry.kind === "node") {
      grouped.set(entry.nodeId, {
        id: entry.nodeId,
        label: input.copy.presence.node,
        isSelf: false,
        isNode: true,
        clientCount: 1,
        focusAgentId: null,
      });
      continue;
    }
    const existing = grouped.get(entry.principalId);
    if (existing) {
      grouped.set(entry.principalId, {
        ...existing,
        clientCount: existing.clientCount + 1,
        focusAgentId: existing.focusAgentId ?? entry.focusAgentId,
      });
      continue;
    }
    grouped.set(entry.principalId, {
      id: entry.principalId,
      label: authorName(
        { principalId: entry.principalId, displayName: entry.displayName },
        input.copy,
        input.viewerPrincipalId,
      ),
      isSelf: entry.principalId === input.viewerPrincipalId,
      isNode: false,
      clientCount: 1,
      focusAgentId: entry.focusAgentId,
    });
  }
  return [...grouped.values()].sort((left, right) => {
    if (left.isSelf !== right.isSelf) return left.isSelf ? -1 : 1;
    if (left.isNode !== right.isNode) return left.isNode ? 1 : -1;
    return left.label.localeCompare(right.label);
  });
}

export function projectAuthorLabel(input: {
  author: TimelineAuthor | null | undefined;
  viewerPrincipalId: string;
  copy: CollabCopy;
}): string | null {
  if (!input.author) return null;
  return authorName(input.author, input.copy, input.viewerPrincipalId);
}

export function projectQueuedTurnBanner(input: {
  queuedTurns: readonly QueuedTurnView[] | undefined;
  viewerPrincipalId: string;
  copy: CollabCopy;
}): CollabBanner | null {
  const queued = [...(input.queuedTurns ?? [])].sort((left, right) =>
    left.queuedAt.localeCompare(right.queuedAt),
  );
  if (queued.length === 0) return null;
  const viewerIsWaiting = queued.some(
    (turn) => turn.author.principalId === input.viewerPrincipalId,
  );
  if (viewerIsWaiting) {
    return { title: input.copy.queued.yours, description: "" };
  }
  if (queued.length === 1) {
    const only = queued[0];
    if (!only) return null;
    return {
      title: formatCollabCopy(input.copy.queued.one, {
        name: authorName(only.author, input.copy, input.viewerPrincipalId),
      }),
      description: "",
    };
  }
  return {
    title: formatCollabCopy(input.copy.queued.many, { count: queued.length }),
    description: "",
  };
}

export function projectRevokeBanner(input: {
  revoked: boolean;
  reason: string | null;
  copy: CollabCopy;
}): CollabBanner | null {
  if (!input.revoked) return null;
  const description =
    input.reason === "membership_removed"
      ? input.copy.revoke.membershipRemoved
      : input.copy.revoke.generic;
  return { title: input.copy.revoke.title, description };
}
