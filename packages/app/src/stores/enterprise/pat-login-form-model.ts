import {
  normalizeEnterpriseIdentityReason,
  type EnterpriseIdentityReasonDisplay,
} from "./display-policy";

export interface PatLoginFormSnapshot {
  readonly status: "idle" | "pending" | "closed";
  readonly hasToken: boolean;
  readonly canSubmit: boolean;
}

export type PatAuthenticationPortResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasonCode: string };

export type PatAuthenticationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasonCode: EnterpriseIdentityReasonDisplay };

export interface PatLoginFormModel {
  getSnapshot(): PatLoginFormSnapshot;
  subscribe(listener: () => void): () => void;
  setToken(token: string): void;
  // The lifecycle adapter settles abort and late-result compensation before this promise resolves.
  // The form owns display state only and must never tear down an accepted session.
  submit<T>(
    authenticate: (token: string, signal: AbortSignal) => Promise<PatAuthenticationPortResult<T>>,
  ): Promise<PatAuthenticationResult<T>>;
  clear(): void;
  close(): void;
}

function createSnapshot(status: PatLoginFormSnapshot["status"], token: string) {
  const hasToken = status === "closed" ? false : token.trim().length > 0;
  return Object.freeze({
    status,
    hasToken,
    canSubmit: status === "idle" && hasToken,
  });
}

export function createPatLoginFormModel(): PatLoginFormModel {
  let token = "";
  let status: PatLoginFormSnapshot["status"] = "idle";
  let snapshot = createSnapshot(status, token);
  let pendingAbortController: AbortController | undefined;
  const listeners = new Set<() => void>();
  const isClosed = () => status === "closed";

  const publish = () => {
    const next = createSnapshot(status, token);
    if (
      next.status === snapshot.status &&
      next.hasToken === snapshot.hasToken &&
      next.canSubmit === snapshot.canSubmit
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A form observer cannot prevent the remaining observers from receiving state changes.
      }
    }
  };

  const clear = () => {
    if (status !== "idle" || token.length === 0) return;
    token = "";
    publish();
  };

  async function submit<T>(
    authenticate: (token: string, signal: AbortSignal) => Promise<PatAuthenticationPortResult<T>>,
  ): Promise<PatAuthenticationResult<T>> {
    if (status === "closed") {
      return { ok: false, reasonCode: "identity.form_closed" };
    }
    if (status === "pending") {
      return { ok: false, reasonCode: "identity.authentication_pending" };
    }
    if (!snapshot.canSubmit) {
      return { ok: false, reasonCode: "identity.token_required" };
    }

    const submittedToken = token;
    const abortController = new AbortController();
    pendingAbortController = abortController;
    status = "pending";
    publish();

    let result: PatAuthenticationPortResult<T>;
    try {
      result = await authenticate(submittedToken, abortController.signal);
    } catch {
      pendingAbortController = undefined;
      if (isClosed()) return { ok: false, reasonCode: "identity.form_closed" };
      status = "idle";
      publish();
      return { ok: false, reasonCode: "identity.unavailable" };
    }
    pendingAbortController = undefined;

    if (isClosed()) {
      return { ok: false, reasonCode: "identity.form_closed" };
    }

    if (result.ok) {
      token = "";
    }
    status = "idle";
    publish();
    return result.ok
      ? { ok: true, value: result.value }
      : {
          ok: false,
          reasonCode: normalizeEnterpriseIdentityReason(result.reasonCode),
        };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (status === "closed") return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setToken: (nextToken) => {
      if (status !== "idle" || nextToken === token) return;
      token = nextToken;
      publish();
    },
    submit,
    clear,
    close: () => {
      if (status === "closed") return;
      status = "closed";
      pendingAbortController?.abort();
      pendingAbortController = undefined;
      token = "";
      publish();
      listeners.clear();
    },
  };
}
