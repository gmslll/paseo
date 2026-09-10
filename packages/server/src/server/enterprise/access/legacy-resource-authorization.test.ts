import { describe, expect, test } from "vitest";
import {
  closeProductionRuntimeFixture,
  createProductionRuntimeFixture,
} from "./production-runtime-test-fixture.js";
import {
  createEnterpriseLegacyResourceAuthorization,
  isEnterpriseLegacyResourceAuthorization,
} from "./legacy-resource-authorization.js";

describe.runIf(process.platform === "darwin")("legacy resource authorization", () => {
  test("binds the real runtime and fails closed after release", async () => {
    const fixture = await createProductionRuntimeFixture("legacy");
    try {
      const authorization = createEnterpriseLegacyResourceAuthorization({
        authorizationRuntime: fixture.runtime,
      });
      expect(authorization).not.toBeNull();
      expect(isEnterpriseLegacyResourceAuthorization(authorization)).toBe(true);
      expect(authorization?.isCurrent()).toBe(true);
      await fixture.runtime.release();
      expect(authorization?.isCurrent()).toBe(false);
      expect(
        await authorization?.assertWorkspace("workspace.metadata.read", "wks_missing"),
      ).toBeNull();
      expect(await authorization?.filterAgents([])).toEqual([]);
    } finally {
      await closeProductionRuntimeFixture();
    }
  });

  test("rejects structural and accessor inputs without touching getter", () => {
    let touched = false;
    const value = Object.create({ authorizationRuntime: null });
    expect(createEnterpriseLegacyResourceAuthorization(value)).toBeNull();
    const accessor = Object.defineProperty({}, "authorizationRuntime", {
      enumerable: true,
      get: () => {
        touched = true;
        return null;
      },
    });
    expect(createEnterpriseLegacyResourceAuthorization(accessor)).toBeNull();
    expect(touched).toBe(false);
  });
});
