import type {
  CurrentIdentityProjection,
  EnterpriseResourceStatusProjection,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { getIdentityDisplayPolicy, getResourceStatusDisplayPolicy } from "./display-policy";

const IDENTITY: CurrentIdentityProjection = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "server-a",
  displayName: "Avery",
  grantVersion: "grant-v1",
  navigation: ["organization", "unknown", "workspaces", "organization"],
  allowedOperations: [
    "organization.resources.view",
    "future.operation",
    "organization.resources.view",
  ],
};

function resourceStatus(
  status: EnterpriseResourceStatusProjection["status"],
  allowedOperations: string[] = [],
): EnterpriseResourceStatusProjection {
  return {
    resource: {
      organizationId: "org_0123456789abcdef",
      nodeId: "nod_0123456789abcdef",
      resourceKind: "browser_profile",
      localResourceId: "brp_0123456789abcdef",
    },
    status,
    label: "Storefront",
    allowedOperations,
  };
}

describe("enterprise display policy", () => {
  it("filters identity navigation and operations without consulting principal type", () => {
    const human = getIdentityDisplayPolicy(IDENTITY);
    const service = getIdentityDisplayPolicy({
      ...IDENTITY,
      principalType: "service",
      principalId: "svc_0123456789abcdef",
    });

    expect(human).toEqual({
      navigation: ["organization", "workspaces"],
      allowedOperations: ["organization.resources.view"],
    });
    expect(service).toEqual(human);
    expect(
      getIdentityDisplayPolicy({ ...IDENTITY, principalType: "future-principal" }),
    ).toBeUndefined();
  });

  it("deep-freezes identity display results so callers cannot mutate later reads", () => {
    const first = getIdentityDisplayPolicy(IDENTITY)!;

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.navigation)).toBe(true);
    expect(Object.isFrozen(first.allowedOperations)).toBe(true);
    expect(() => {
      (first.navigation as unknown as string[]).push("audit");
    }).toThrow();

    expect(getIdentityDisplayPolicy(IDENTITY)).toEqual({
      navigation: ["organization", "workspaces"],
      allowedOperations: ["organization.resources.view"],
    });
  });

  it("maps every resource status exactly and never invents an operation from status", () => {
    expect(
      ["ready", "resource_waiting", "login_required", "mfa_required", "risk_control", "disabled"]
        .map(
          (status) =>
            getResourceStatusDisplayPolicy(
              resourceStatus(status as EnterpriseResourceStatusProjection["status"]),
            )!,
        )
        .map(({ status, tone, allowedOperations }) => ({ status, tone, allowedOperations })),
    ).toEqual([
      { status: "ready", tone: "success", allowedOperations: [] },
      { status: "resource_waiting", tone: "warning", allowedOperations: [] },
      { status: "login_required", tone: "warning", allowedOperations: [] },
      { status: "mfa_required", tone: "warning", allowedOperations: [] },
      { status: "risk_control", tone: "error", allowedOperations: [] },
      { status: "disabled", tone: "muted", allowedOperations: [] },
    ]);
  });

  it("clones safe resource metadata and filters projected operations and reason codes", () => {
    const projection = {
      ...resourceStatus("resource_waiting", ["open", "future.operation", "open"]),
      workspaceId: "workspace-1",
      agentId: "agent-1",
      queue: {
        queuedAt: "2026-09-09T00:00:00.000Z",
        position: 3,
        holderPrincipalId: "usr-secret-holder",
        futureQueueField: "must-not-be-copied",
      },
      reasonCode: "capacity_wait",
      holderPrincipalId: "usr-secret-holder",
      futureServerField: "must-not-be-copied",
    };
    const policy = getResourceStatusDisplayPolicy(projection);

    expect(policy).toEqual({
      resource: {
        organizationId: "org_0123456789abcdef",
        nodeId: "nod_0123456789abcdef",
        resourceKind: "browser_profile",
        localResourceId: "brp_0123456789abcdef",
      },
      status: "resource_waiting",
      tone: "warning",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      label: "Storefront",
      allowedOperations: ["open"],
      queue: { queuedAt: "2026-09-09T00:00:00.000Z", position: 3 },
      reasonCode: "capacity_wait",
    });
    expect(policy).not.toHaveProperty("holderPrincipalId");
    expect(policy).not.toHaveProperty("futureServerField");
    expect(policy?.queue).not.toHaveProperty("holderPrincipalId");
    expect(policy?.queue).not.toHaveProperty("futureQueueField");

    projection.resource.localResourceId = "changed-after-policy";
    projection.queue.position = 9;
    expect(policy?.resource.localResourceId).toBe("brp_0123456789abcdef");
    expect(policy?.queue?.position).toBe(3);
  });

  it("ignores unknown open reason codes instead of passing them to the UI", () => {
    const policy = getResourceStatusDisplayPolicy({
      ...resourceStatus("risk_control", ["future.operation"]),
      reasonCode: "future.raw.server.reason",
    });

    expect(policy).not.toHaveProperty("reasonCode");
    expect(policy?.allowedOperations).toEqual([]);
  });

  it("deep-freezes resource status display results and their nested projections", () => {
    const policy = getResourceStatusDisplayPolicy({
      ...resourceStatus("resource_waiting", ["open"]),
      queue: { queuedAt: "2026-09-09T00:00:00.000Z", position: 3 },
    })!;

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.resource)).toBe(true);
    expect(Object.isFrozen(policy.allowedOperations)).toBe(true);
    expect(Object.isFrozen(policy.queue)).toBe(true);
    expect(() => {
      (policy.allowedOperations as unknown as string[]).push("future.operation");
    }).toThrow();
    expect(() => {
      (policy.resource as { localResourceId: string }).localResourceId = "mutated";
    }).toThrow();

    expect(getResourceStatusDisplayPolicy(resourceStatus("ready", ["open"]))).toMatchObject({
      resource: { localResourceId: "brp_0123456789abcdef" },
      allowedOperations: ["open"],
    });
  });

  it("fails closed when runtime resource kind or status is outside the V1 schema", () => {
    expect(
      getResourceStatusDisplayPolicy({
        ...resourceStatus("ready"),
        status: "future-status",
      }),
    ).toBeUndefined();
    expect(
      getResourceStatusDisplayPolicy({
        ...resourceStatus("ready"),
        resource: {
          ...resourceStatus("ready").resource,
          resourceKind: "future-resource",
        },
      }),
    ).toBeUndefined();
  });
});
