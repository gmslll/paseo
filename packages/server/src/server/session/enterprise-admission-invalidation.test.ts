import { describe, expect, test, vi } from "vitest";
import { createAdmissionInvalidationSink } from "./enterprise-admission-invalidation.js";

const base = {
  kind: "revoke" as const,
  credentialIds: ["cred-a"],
  principalId: "usr_aaaaaaaaaaaaaaaa",
  organizationId: "org_aaaaaaaaaaaaaaaa",
  grantVersion: "grant-a",
};
const registration = {
  sessionBindingKey: "binding-a",
  generation: "generation-a",
  credentialId: "cred-a",
  principalId: base.principalId,
  organizationId: base.organizationId,
  grantVersion: base.grantVersion,
};

describe("admission invalidation sink", () => {
  test("fans out only to exact matching live generations", async () => {
    const sink = createAdmissionInvalidationSink();
    const invalidateA = vi.fn().mockResolvedValue(undefined);
    const invalidateB = vi.fn().mockResolvedValue(undefined);
    const survivor = vi.fn().mockResolvedValue(undefined);
    sink.register({ ...registration, invalidate: invalidateA });
    sink.register({
      ...registration,
      sessionBindingKey: "binding-b",
      generation: "generation-b",
      invalidate: invalidateB,
    });
    sink.register({
      ...registration,
      sessionBindingKey: "binding-survivor",
      generation: "generation-survivor",
      principalId: "usr_bbbbbbbbbbbbbbbb",
      invalidate: survivor,
    });
    await sink.publishCredentialInvalidation({ ...base, kind: "logout_all" });
    expect(invalidateA).toHaveBeenCalledWith({
      sessionBindingKey: "binding-a",
      sessionBindingGeneration: "generation-a",
    });
    expect(invalidateB).toHaveBeenCalledWith({
      sessionBindingKey: "binding-b",
      sessionBindingGeneration: "generation-b",
    });
    expect(survivor).not.toHaveBeenCalled();
  });

  test("unknown or mismatched base events have no side effects", async () => {
    const sink = createAdmissionInvalidationSink();
    const invalidate = vi.fn().mockResolvedValue(undefined);
    sink.register({ ...registration, invalidate });
    await sink.publish({ ...base, grantVersion: "wrong" });
    await sink.publish({ ...base, credentialIds: ["other"] });
    await sink.publish({ ...base, credentialIds: ["cred-a", "cred-a"] });
    await sink.publish({ ...base, credentialIds: [] });
    await sink.publish({ ...base, kind: "unknown" as never });
    expect(invalidate).not.toHaveBeenCalled();
  });

  test("propagates all matching invalidation failures", async () => {
    const sink = createAdmissionInvalidationSink();
    const first = new Error("first");
    const second = new Error("second");
    const invalidateA = vi.fn().mockRejectedValue(first);
    const invalidateB = vi.fn().mockRejectedValue(second);
    sink.register({ ...registration, invalidate: invalidateA });
    sink.register({
      ...registration,
      sessionBindingKey: "binding-b",
      generation: "generation-b",
      invalidate: invalidateB,
    });
    await expect(sink.publish({ ...base, kind: "rotate" })).rejects.toMatchObject({
      errors: [first, second],
    });
    expect(invalidateA).toHaveBeenCalledTimes(1);
    expect(invalidateB).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe removes exactly one generation", async () => {
    const sink = createAdmissionInvalidationSink();
    const invalidateA = vi.fn().mockResolvedValue(undefined);
    const invalidateB = vi.fn().mockResolvedValue(undefined);
    const unsubscribeA = sink.register({ ...registration, invalidate: invalidateA });
    sink.register({
      ...registration,
      sessionBindingKey: "binding-b",
      generation: "generation-b",
      invalidate: invalidateB,
    });
    unsubscribeA();
    await sink.publish({ ...base, kind: "logout_all" });
    expect(invalidateA).not.toHaveBeenCalled();
    expect(invalidateB).toHaveBeenCalledTimes(1);
  });
});
