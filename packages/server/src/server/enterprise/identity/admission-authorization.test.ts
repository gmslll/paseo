import type { ConnectionContext, NodeContext, PrincipalContext } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import * as identityIndex from "./index.js";
import {
  bindEnterpriseAdmissionSession,
  createEnterpriseAdmissionAuthorizationIssuer,
  invalidateEnterpriseCredential,
  invalidateEnterpriseAdmissionAuthorization,
  invalidateEnterprisePrincipal,
  issueEnterpriseAdmissionEvidence,
  isCurrentEnterpriseAdmissionAuthorization,
  releaseEnterpriseAdmissionSession,
  replaceEnterpriseAdmissionSession,
  resolveCurrentEnterpriseAdmissionAuthorization,
} from "./admission-authorization.js";

const mintSecret = Object.freeze({});

const principal: PrincipalContext = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  credentialId: "cred_0123456789abcdef01234567",
  grantVersion: "1",
  grants: [],
};
const node: NodeContext = {
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "srv",
  mode: "standalone",
};
const connection: ConnectionContext = { node, transport: "direct", peer: "loopback" };

describe("enterprise admission authorization", () => {
  test("public identity index does not expose mint helper", () => {
    expect("issueEnterpriseAdmissionEvidence" in identityIndex).toBe(false);
  });
  test("rejects forged mint secret without creating evidence", () => {
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
    const forged = Object.freeze({});
    expect(
      issueEnterpriseAdmissionEvidence(issuer, forged, principal, node, connection),
    ).toBeNull();
    expect(bindEnterpriseAdmissionSession(issuer, {} as never, "client")).toBeNull();
  });
  test("binds an immutable evidence snapshot and validates current handle", () => {
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
    const evidence = issueEnterpriseAdmissionEvidence(
      issuer,
      mintSecret,
      principal,
      node,
      connection,
    );
    expect(evidence).not.toBeNull();
    const handle = bindEnterpriseAdmissionSession(issuer, evidence!, "client-a");
    expect(handle).not.toBeNull();
    expect(isCurrentEnterpriseAdmissionAuthorization(issuer, handle)).toBe(true);
    const resolved = resolveCurrentEnterpriseAdmissionAuthorization(issuer, handle);
    expect(resolved?.clientId).toBe("client-a");
    expect(Object.isFrozen(resolved?.principal)).toBe(true);
    expect(Object.isFrozen(resolved?.node)).toBe(true);
    expect(Object.keys(resolved ?? {}).sort()).toEqual([
      "clientId",
      "node",
      "principal",
      "sessionBindingGeneration",
      "sessionBindingKey",
    ]);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(() => Object.assign(resolved!, { clientId: "evil" })).toThrow();
    expect(bindEnterpriseAdmissionSession(issuer, evidence!, "client-b")).toBeNull();
  });

  test("rejects foreign, released, and invalidated handles", () => {
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
    const foreign = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
    const evidence = issueEnterpriseAdmissionEvidence(
      issuer,
      mintSecret,
      principal,
      node,
      connection,
    )!;
    const handle = bindEnterpriseAdmissionSession(issuer, evidence, "client-a")!;
    expect(resolveCurrentEnterpriseAdmissionAuthorization(foreign, handle)).toBeNull();
    invalidateEnterpriseCredential(issuer, principal.credentialId);
    expect(isCurrentEnterpriseAdmissionAuthorization(issuer, handle)).toBe(false);
    expect(releaseEnterpriseAdmissionSession(issuer, handle)).toBe(false);
    expect(releaseEnterpriseAdmissionSession(issuer, handle)).toBe(false);
  });

  test("mismatched replacement burns evidence and preserves old handle", () => {
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
    const evidence = issueEnterpriseAdmissionEvidence(
      issuer,
      mintSecret,
      principal,
      node,
      connection,
    )!;
    const oldHandle = bindEnterpriseAdmissionSession(issuer, evidence, "client-a")!;
    const mismatched = issueEnterpriseAdmissionEvidence(
      issuer,
      mintSecret,
      { ...principal, credentialId: "cred_other" },
      node,
      connection,
    )!;
    expect(replaceEnterpriseAdmissionSession(issuer, oldHandle, mismatched, "client-a")).toBeNull();
    expect(isCurrentEnterpriseAdmissionAuthorization(issuer, oldHandle)).toBe(true);
  });

  test("exact replacement atomically rotates the generation", () => {
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
    const firstEvidence = issueEnterpriseAdmissionEvidence(
      issuer,
      mintSecret,
      principal,
      node,
      connection,
    )!;
    const oldHandle = bindEnterpriseAdmissionSession(issuer, firstEvidence, "client-a")!;
    const nextEvidence = issueEnterpriseAdmissionEvidence(
      issuer,
      mintSecret,
      principal,
      node,
      connection,
    )!;
    const nextHandle = replaceEnterpriseAdmissionSession(
      issuer,
      oldHandle,
      nextEvidence,
      "client-a",
    );
    expect(nextHandle).not.toBeNull();
    expect(isCurrentEnterpriseAdmissionAuthorization(issuer, oldHandle)).toBe(false);
    expect(isCurrentEnterpriseAdmissionAuthorization(issuer, nextHandle)).toBe(true);
    expect(
      resolveCurrentEnterpriseAdmissionAuthorization(issuer, nextHandle)?.sessionBindingGeneration,
    ).not.toBe(
      resolveCurrentEnterpriseAdmissionAuthorization(issuer, oldHandle)?.sessionBindingGeneration,
    );
  });

  test("primitive and proxy inputs fail closed", () => {
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
    expect(bindEnterpriseAdmissionSession(issuer, 1 as never, "c")).toBeNull();
    expect(replaceEnterpriseAdmissionSession(issuer, 1 as never, 2 as never, "c")).toBeNull();
    expect(releaseEnterpriseAdmissionSession(issuer, 1 as never)).toBe(false);
    expect(
      resolveCurrentEnterpriseAdmissionAuthorization(
        issuer,
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("trap");
            },
          },
        ),
      ),
    ).toBeNull();
  });

  test.each(["credential", "principal", "admission"])("stale %s evidence cannot bind", (kind) => {
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
    const evidence = issueEnterpriseAdmissionEvidence(
      issuer,
      mintSecret,
      principal,
      node,
      connection,
    )!;
    if (kind === "credential") invalidateEnterpriseCredential(issuer, principal.credentialId);
    if (kind === "principal")
      invalidateEnterprisePrincipal(issuer, principal.organizationId, principal.principalId);
    if (kind === "admission") invalidateEnterpriseAdmissionAuthorization(issuer);
    expect(bindEnterpriseAdmissionSession(issuer, evidence, "client")).toBeNull();
    if (kind !== "admission") {
      const fresh = issueEnterpriseAdmissionEvidence(
        issuer,
        mintSecret,
        { ...principal },
        node,
        connection,
      )!;
      expect(fresh).not.toBeNull();
      expect(bindEnterpriseAdmissionSession(issuer, fresh, "client")).not.toBeNull();
    }
  });

  test("closed audit guard rejects fresh issue and bind", () => {
    let current = true;
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret, () => current);
    const evidence = issueEnterpriseAdmissionEvidence(
      issuer,
      mintSecret,
      principal,
      node,
      connection,
    )!;
    current = false;
    expect(
      issueEnterpriseAdmissionEvidence(issuer, mintSecret, principal, node, connection),
    ).toBeNull();
    expect(bindEnterpriseAdmissionSession(issuer, evidence, "client")).toBeNull();
    expect(isCurrentEnterpriseAdmissionAuthorization(issuer, {})).toBe(false);
  });

  test.each([false, "throw"])("active handle becomes stale when audit is %s", (mode) => {
    let guardState: boolean | "throw" = true;
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret, () => {
      if (guardState === "throw") throw new Error("audit closed");
      return guardState;
    });
    const evidence = issueEnterpriseAdmissionEvidence(
      issuer,
      mintSecret,
      principal,
      node,
      connection,
    )!;
    const handle = bindEnterpriseAdmissionSession(issuer, evidence, "client")!;
    expect(handle).not.toBeNull();
    const pending = issueEnterpriseAdmissionEvidence(
      issuer,
      mintSecret,
      principal,
      node,
      connection,
    )!;
    expect(pending).not.toBeNull();
    guardState = mode;
    expect(isCurrentEnterpriseAdmissionAuthorization(issuer, handle)).toBe(false);
    expect(resolveCurrentEnterpriseAdmissionAuthorization(issuer, handle)).toBeNull();
    expect(bindEnterpriseAdmissionSession(issuer, pending, "client-2")).toBeNull();
    expect(replaceEnterpriseAdmissionSession(issuer, handle, pending, "client")).toBeNull();
  });

  test("audit guard exceptions fail closed", () => {
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret, () => {
      throw new Error("audit unavailable");
    });
    expect(
      issueEnterpriseAdmissionEvidence(issuer, mintSecret, principal, node, connection),
    ).toBeNull();
    expect(bindEnterpriseAdmissionSession(issuer, {} as never, "client")).toBeNull();
    expect(isCurrentEnterpriseAdmissionAuthorization(issuer, {})).toBe(false);
  });

  test("wrong mint secret cannot issue or bind", () => {
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
    const evidence = issueEnterpriseAdmissionEvidence(
      issuer,
      Object.freeze({}),
      principal,
      node,
      connection,
    );
    expect(evidence).toBeNull();
  });

  test("resolved view is exact and deeply frozen", () => {
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
    const evidence = issueEnterpriseAdmissionEvidence(
      issuer,
      mintSecret,
      principal,
      node,
      connection,
    )!;
    const handle = bindEnterpriseAdmissionSession(issuer, evidence, "client")!;
    const resolved = resolveCurrentEnterpriseAdmissionAuthorization(issuer, handle)!;
    expect(Object.keys(resolved).sort()).toEqual([
      "clientId",
      "node",
      "principal",
      "sessionBindingGeneration",
      "sessionBindingKey",
    ]);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.principal)).toBe(true);
    expect(Object.isFrozen(resolved.node)).toBe(true);
    expect(Reflect.set(resolved, "clientId", "other")).toBe(false);
    expect(isCurrentEnterpriseAdmissionAuthorization(issuer, handle)).toBe(true);
  });

  test("throwing audit guard fails closed", () => {
    const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret, () => {
      throw new Error("revoked");
    });
    expect(
      issueEnterpriseAdmissionEvidence(issuer, mintSecret, principal, node, connection),
    ).toBeNull();
    expect(isCurrentEnterpriseAdmissionAuthorization(issuer, {})).toBe(false);
  });
});
