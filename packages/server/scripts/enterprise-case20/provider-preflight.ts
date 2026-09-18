export type Case20Provider = "codex" | "claude";

export interface Case20ProviderPreflight {
  readonly canRun: (provider: Case20Provider) => Promise<boolean>;
}

export async function assertCase20PartBProviderPreflight(
  preflight: Case20ProviderPreflight,
): Promise<void> {
  const availability = await Promise.all(
    (["codex", "claude"] as const).map(async (provider) => ({
      provider,
      available: await preflight.canRun(provider),
    })),
  );
  const missing = availability.filter((entry) => !entry.available).map((entry) => entry.provider);
  if (missing.length > 0) {
    throw new Error(
      `Case20 Part B requires real provider binary and authentication for: ${missing.join(", ")}`,
    );
  }
}
