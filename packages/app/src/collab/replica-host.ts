import { CollabReplica } from "@getpaseo/client/internal/collab";

/** One replica per App process so revoke and logout drop the same copy (ADR-0036). */
export const appCollabReplica = new CollabReplica();
