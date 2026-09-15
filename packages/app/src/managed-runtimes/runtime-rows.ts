import type { ManagedRuntimeStatus } from "@getpaseo/protocol/managed-runtimes";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";

export type ManagedRuntimeStatusKey = ManagedRuntimeStatus["status"];

export interface ManagedRuntimeRow {
  runtimeName: string;
  status: ManagedRuntimeStatusKey;
  badgeVariant: StatusBadgeVariant;
  pinnedVersion: string | null;
  activeVersion: string | null;
  commandPath: string | null;
  failure: string | null;
  canInstall: boolean;
}

const BADGE_VARIANTS: Record<ManagedRuntimeStatusKey, StatusBadgeVariant> = {
  installed: "success",
  installing: "muted",
  not_installed: "warning",
  mismatch: "error",
  failed: "error",
  not_pinned: "muted",
};

const INSTALLABLE_STATUSES: ReadonlySet<ManagedRuntimeStatusKey> = new Set([
  "not_installed",
  "mismatch",
  "failed",
]);

export function buildManagedRuntimeRows(
  statuses: readonly ManagedRuntimeStatus[],
): ManagedRuntimeRow[] {
  return statuses.map((status) => ({
    runtimeName: status.runtimeName,
    status: status.status,
    badgeVariant: BADGE_VARIANTS[status.status],
    pinnedVersion: status.pinnedVersion,
    activeVersion: status.activeVersion,
    commandPath: status.status === "installed" ? status.commandPath : null,
    failure: status.status === "installed" ? null : status.error,
    canInstall: status.pinnedVersion !== null && INSTALLABLE_STATUSES.has(status.status),
  }));
}
