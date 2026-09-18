import { describe, expect, test } from "vitest";

import { resolveTurnDiffQueryResult } from "./resolve-turn-diff-query";

const file = {
  path: "src/a.ts",
  isNew: false,
  isDeleted: false,
  additions: 1,
  deletions: 0,
  hunks: [],
};

describe("resolveTurnDiffQueryResult", () => {
  test("a host without the feature is unsupported, not empty", () => {
    expect(
      resolveTurnDiffQueryResult({
        enabled: true,
        capabilityPresent: false,
        canFetch: true,
        files: undefined,
        error: null,
        isFetching: true,
      }),
    ).toEqual({ files: [], isLoading: false, error: null, capabilityMissing: true });
  });

  test("loaded files win over a later error", () => {
    expect(
      resolveTurnDiffQueryResult({
        enabled: true,
        capabilityPresent: true,
        canFetch: true,
        files: [file],
        error: new Error("stale"),
        isFetching: false,
      }),
    ).toEqual({ files: [file], isLoading: false, error: null, capabilityMissing: false });
  });

  test("a fetch failure is an error, not an empty turn", () => {
    const error = new Error("unavailable");
    expect(
      resolveTurnDiffQueryResult({
        enabled: true,
        capabilityPresent: true,
        canFetch: true,
        files: undefined,
        error,
        isFetching: false,
      }),
    ).toEqual({ files: [], isLoading: false, error, capabilityMissing: false });
  });
});
