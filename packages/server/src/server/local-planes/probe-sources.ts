import type { ProbeState } from "@getpaseo/protocol/local-planes";

import type { TerminalManager } from "../../terminal/terminal-manager.js";
import type { EnterpriseMultiUserConfig } from "../persisted-config.js";

export async function countTerminals(
  terminals: Pick<TerminalManager, "listDirectories" | "getTerminals">,
): Promise<number> {
  const perDirectory = await Promise.all(
    terminals.listDirectories().map(async (cwd) => (await terminals.getTerminals(cwd)).length),
  );
  return perDirectory.reduce((total, count) => total + count, 0);
}

/** Names the node's enterprise mode without connection details, credentials, or Principals. */
export function enterpriseProbeSummary(
  config: EnterpriseMultiUserConfig | undefined,
): ProbeState["enterprise"] {
  if (!config?.enabled) return null;
  return {
    enabled: true,
    managementMode: config.managementMode,
    nodeId: config.nodeId,
    nodeStatus: null,
    policyAgeMs: null,
    lastHeartbeatAt: null,
  };
}
