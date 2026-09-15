// How a Provider launch sees a company-pinned runtime (ADR-0039). Kept separate from the manager
// so Provider launch code depends only on this shape.

export type ManagedBinaryResolution =
  | { kind: "unmanaged" }
  | {
      kind: "installed";
      runtimeName: string;
      version: string;
      commandPath: string;
      allowCommandOverride: boolean;
    }
  | {
      kind: "unavailable";
      runtimeName: string;
      reason: "not_installed" | "installing" | "mismatch" | "unsupported_platform";
      pathFallback: "allow" | "forbid";
      allowCommandOverride: boolean;
    };

export interface ManagedProviderBinary {
  resolve(): Promise<ManagedBinaryResolution>;
}

export interface ManagedRuntimeBindings {
  bindingFor(providerId: string): ManagedProviderBinary;
}
