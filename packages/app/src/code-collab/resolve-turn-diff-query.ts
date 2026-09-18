import type { ParsedDiffFile } from "@getpaseo/protocol/messages";

export interface TurnDiffQueryResult {
  files: ParsedDiffFile[];
  isLoading: boolean;
  error: Error | null;
  capabilityMissing: boolean;
}

export function resolveTurnDiffQueryResult(input: {
  enabled: boolean;
  capabilityPresent: boolean;
  canFetch: boolean;
  files: ParsedDiffFile[] | undefined;
  error: Error | null;
  isFetching: boolean;
}): TurnDiffQueryResult {
  if (!input.capabilityPresent) {
    return { files: [], isLoading: false, error: null, capabilityMissing: true };
  }
  if (input.files) {
    return { files: input.files, isLoading: false, error: null, capabilityMissing: false };
  }
  if (!input.enabled || !input.canFetch) {
    return { files: [], isLoading: false, error: null, capabilityMissing: false };
  }
  if (input.error) {
    return { files: [], isLoading: false, error: input.error, capabilityMissing: false };
  }
  return { files: [], isLoading: input.isFetching, error: null, capabilityMissing: false };
}
