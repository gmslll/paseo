import { describe, expect, test, vi } from "vitest";
import { createAdmissionInvalidationSink } from "./enterprise-admission-invalidation.js";

const registration = {
  sessionBindingKey: "binding-a",
  generation: "generation-a",
  credentialId: "cred-a",
  principalId: "usr_aaaaaaaaaaaaaaaa",
  organizationId: "org_aaaaaaaaaaaaaaaa",
  grantVersion: "grant-a",
};

describe("admission invalidation sink", () => {
  test("publishes only on exact correlation", async () => {
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const sink = createAdmissionInvalidationSink();
    const unsubscribe = sink.register({ ...registration, invalidate });
    await sink.publish({
      ...registration,
      kind: "revoke",
      credentialIds: ["cred-a"],
      grantVersion: "wrong",
    });
    expect(invalidate).not.toHaveBeenCalled();
    await sink.publish({ ...registration, kind: "revoke", credentialIds: ["cred-a"] });
    expect(invalidate).toHaveBeenCalledWith({
      sessionBindingKey: "binding-a",
      sessionBindingGeneration: "generation-a",
    });
    unsubscribe();
    await sink.publish({ ...registration, kind: "logout_all", credentialIds: ["cred-a"] });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  test("propagates cleanup rejection and leaves registration until unsubscribe", async () => {
    const error = new Error("cleanup failed");
    const sink = createAdmissionInvalidationSink();
    const invalidate = vi.fn().mockRejectedValue(error);
    sink.register({ ...registration, invalidate });
    await expect(
      sink.publish({ ...registration, kind: "rotate", credentialIds: ["cred-a"] }),
    ).rejects.toBe(error);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
