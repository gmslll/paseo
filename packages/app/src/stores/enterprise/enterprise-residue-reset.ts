/** The only state passed to the residue reset seam. No PAT, client generation, or legacy scope. */
export interface EnterpriseResidueScope<TGeneration extends string = string> {
  readonly serverId: string;
  readonly lifecycleGeneration: TGeneration;
}

export interface EnterpriseResidueResetTargets<TGeneration extends string = string> {
  /** Root injects coordinated tab, draft and attachment-store clearing here. */
  reset(scope: EnterpriseResidueScope<TGeneration>): void;
}

export interface EnterpriseResidueResetAdapter<TGeneration extends string = string> {
  activate(scope: EnterpriseResidueScope<TGeneration>): void;
  reset(scope: EnterpriseResidueScope<TGeneration>): void;
  getActiveScope(): EnterpriseResidueScope<TGeneration> | null;
}

function cloneScope<TGeneration extends string>(
  scope: EnterpriseResidueScope<TGeneration>,
): EnterpriseResidueScope<TGeneration> {
  return Object.freeze({
    serverId: scope.serverId,
    lifecycleGeneration: scope.lifecycleGeneration,
  });
}

/**
 * Coordinates removal of enterprise-only app residue when W3 changes lifecycle generation.
 * The root/HostRuntime assembly owns the target callback; this adapter owns no app stores.
 */
export function createEnterpriseResidueResetAdapter<TGeneration extends string>(
  targets: EnterpriseResidueResetTargets<TGeneration>,
): EnterpriseResidueResetAdapter<TGeneration> {
  let activeScope: EnterpriseResidueScope<TGeneration> | null = null;

  const reset = (scope: EnterpriseResidueScope<TGeneration>) => {
    const snapshot = cloneScope<TGeneration>(scope);
    targets.reset(snapshot);
    if (
      activeScope?.serverId === snapshot.serverId &&
      activeScope.lifecycleGeneration === snapshot.lifecycleGeneration
    ) {
      activeScope = null;
    }
  };

  return Object.freeze({
    activate(scope: EnterpriseResidueScope<TGeneration>) {
      const next = cloneScope(scope);
      if (
        activeScope &&
        (activeScope.serverId !== next.serverId ||
          activeScope.lifecycleGeneration !== next.lifecycleGeneration)
      ) {
        targets.reset(activeScope);
      }
      activeScope = next;
    },
    reset,
    getActiveScope: () => activeScope,
  });
}
