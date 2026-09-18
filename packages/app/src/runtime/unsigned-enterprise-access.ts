export type UnsignedEnterpriseAccess = "children" | "pending" | "password_login";
export type UnsignedEnterpriseDiscovery = "pending" | "managed" | "standalone";

export function resolveUnsignedEnterpriseAccess(input: {
  signedIn: boolean;
  hasLifecycle: boolean;
  discovery: UnsignedEnterpriseDiscovery;
}): UnsignedEnterpriseAccess {
  if (input.signedIn) return "children";
  if (input.discovery === "pending") return "pending";
  if (input.discovery === "managed" && input.hasLifecycle) return "password_login";
  return "children";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
