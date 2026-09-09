import type { PatAuthenticationPortResult } from "@/stores/enterprise/pat-login-form-model";

/**
 * UI-only seam. The root adapter supplies W3 lifecycle snapshots and W0/W2 typed ports;
 * The token is passed only as an invocation argument to the W3 adapter; it is not retained in
 * snapshots, wire state, or this UI seam. Handles and receipts never cross this boundary.
 */
export interface EnterpriseUiPort<TSessionGeneration extends string> {
  authenticatePat(input: {
    readonly serverId: string;
    readonly token: string;
    readonly signal: AbortSignal;
  }): Promise<PatAuthenticationPortResult<unknown>>;
  logoutCurrent(): Promise<void>;
  logoutAll(): Promise<void>;
  refreshScope(sessionGeneration: TSessionGeneration): Promise<void>;
}
