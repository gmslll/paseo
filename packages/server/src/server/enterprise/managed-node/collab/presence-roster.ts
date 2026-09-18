import { PRESENCE_TTL_MS, type PresenceEntry } from "@getpaseo/protocol/enterprise-collaboration";

export type PrincipalPresence = Extract<PresenceEntry, { kind: "principal" }>;

export const COLLAB_PRESENCE_UNAVAILABLE = "Workspace presence is unavailable on this daemon";

/**
 * Who is looking at a Workspace on this node. Plane presence stays client-only (ADR-0032); this
 * roster is the Sessions that are actually connected here.
 */
export interface CollabPresenceBeatInput {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly displayName?: string;
  readonly clientId: string;
  readonly focusAgentId: string | null;
  readonly nowMs: number;
}

export interface CollabPresenceControl {
  beat(input: CollabPresenceBeatInput): readonly PrincipalPresence[];
  list(workspaceId: string, nowMs: number): readonly PrincipalPresence[];
}

interface PresenceRecord {
  workspaceId: string;
  principalId: string;
  displayName?: string;
  clientId: string;
  focusAgentId: string | null;
  heartbeatMs: number;
}

function entryKey(workspaceId: string, principalId: string, clientId: string): string {
  return `${workspaceId}\0${principalId}\0${clientId}`;
}

function toEntry(record: PresenceRecord): PrincipalPresence {
  return {
    kind: "principal",
    principalId: record.principalId,
    ...(record.displayName ? { displayName: record.displayName } : {}),
    clientId: record.clientId,
    focusAgentId: record.focusAgentId,
    heartbeatAt: new Date(record.heartbeatMs).toISOString(),
  };
}

export function createCollabPresenceRoster(options?: { ttlMs?: number }): CollabPresenceControl {
  const ttlMs = options?.ttlMs ?? PRESENCE_TTL_MS;
  const records = new Map<string, PresenceRecord>();

  function prune(workspaceId: string, nowMs: number): PrincipalPresence[] {
    const live: PrincipalPresence[] = [];
    for (const [key, record] of records) {
      if (record.workspaceId !== workspaceId) continue;
      if (nowMs - record.heartbeatMs >= ttlMs) {
        records.delete(key);
        continue;
      }
      live.push(toEntry(record));
    }
    return live;
  }

  return {
    beat(input) {
      records.set(entryKey(input.workspaceId, input.principalId, input.clientId), {
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        clientId: input.clientId,
        focusAgentId: input.focusAgentId,
        heartbeatMs: input.nowMs,
      });
      return prune(input.workspaceId, input.nowMs);
    },
    list(workspaceId, nowMs) {
      return prune(workspaceId, nowMs);
    },
  };
}
