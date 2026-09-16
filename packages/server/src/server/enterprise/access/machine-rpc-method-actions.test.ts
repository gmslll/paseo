import { describe, expect, test } from "vitest";

import {
  MACHINE_RPC_METHODS,
  WORKSPACE_MEMBER_ROLE_ACTIONS,
  roleAllowsMachineRpcMethod,
} from "@getpaseo/protocol/enterprise-collaboration";

import { inboundActionsForRequestType } from "./event-action-map.js";

/**
 * The plane checks a machine RPC method before it attests it (ADR-0035), and it cannot call
 * inboundActionsForRequestType: enterprise-management depends on the protocol package, not on the
 * daemon. So the method table restates each entry's actions, and this pins the restatement to the
 * mapping it copies. Without this the two would be free to disagree, and the plane would be
 * authorizing against an answer the daemon no longer gives.
 */
describe("the machine RPC method table against the daemon's entry mapping", () => {
  test("every workspace method names an entry the daemon actually accepts", () => {
    for (const [method, policy] of Object.entries(MACHINE_RPC_METHODS)) {
      if (policy.scope !== "workspace") continue;
      // null means the daemon has no such inbound request, so the method would name nothing.
      expect(inboundActionsForRequestType(policy.entry), method).not.toBeNull();
    }
  });

  test("every workspace method's actions are the entry's own", () => {
    for (const [method, policy] of Object.entries(MACHINE_RPC_METHODS)) {
      if (policy.scope !== "workspace") continue;
      expect([...policy.actions].sort(), method).toEqual(
        [...(inboundActionsForRequestType(policy.entry) ?? [])].sort(),
      );
    }
  });

  test("no workspace method resolves to an empty action list", () => {
    // An empty list passes vacuously for every role, viewer included. That is the trap the machine
    // methods are kept out of this shape to avoid, so no workspace method may fall into it either.
    for (const [method, policy] of Object.entries(MACHINE_RPC_METHODS)) {
      if (policy.scope !== "workspace") continue;
      expect(policy.actions.length, method).toBeGreaterThan(0);
    }
  });
});

describe("which role may call what", () => {
  test("an editor drives an Agent and a viewer does not", () => {
    const send = MACHINE_RPC_METHODS["agent.send"]!;
    expect(roleAllowsMachineRpcMethod("owner", send)).toBe(true);
    expect(roleAllowsMachineRpcMethod("editor", send)).toBe(true);
    expect(roleAllowsMachineRpcMethod("viewer", send)).toBe(false);
  });

  test("a viewer may look at what a read-shaped method reads", () => {
    const status = MACHINE_RPC_METHODS["checkout.status"]!;
    for (const role of ["owner", "editor", "viewer"] as const) {
      expect(roleAllowsMachineRpcMethod(role, status)).toBe(true);
    }
    // The daemon classifies forking context as a read, and this follows it rather than second
    // guessing it.
    expect(roleAllowsMachineRpcMethod("viewer", MACHINE_RPC_METHODS["agent.fork_context"]!)).toBe(
      true,
    );
  });

  test("only an owner restarts or upgrades the machine", () => {
    for (const method of ["machine.restart", "machine.upgrade"] as const) {
      const policy = MACHINE_RPC_METHODS[method]!;
      expect(roleAllowsMachineRpcMethod("owner", policy)).toBe(true);
      expect(roleAllowsMachineRpcMethod("editor", policy)).toBe(false);
      expect(roleAllowsMachineRpcMethod("viewer", policy)).toBe(false);
    }
  });

  test("any member may ask the machine how it is", () => {
    const status = MACHINE_RPC_METHODS["machine.get_status"]!;
    for (const role of ["owner", "editor", "viewer"] as const) {
      expect(roleAllowsMachineRpcMethod(role, status)).toBe(true);
    }
  });

  test("a role holding only some of an entry's actions is refused", () => {
    // Guards the "every" in the check: a method needing two actions must not pass on one of them.
    const twoActions = {
      scope: "workspace",
      entry: "synthetic",
      actions: ["workspace.content.read", "workspace.manage"],
    } as const;
    expect(WORKSPACE_MEMBER_ROLE_ACTIONS.editor).toContain("workspace.content.read");
    expect(WORKSPACE_MEMBER_ROLE_ACTIONS.editor).not.toContain("workspace.manage");
    expect(roleAllowsMachineRpcMethod("editor", twoActions)).toBe(false);
    expect(roleAllowsMachineRpcMethod("owner", twoActions)).toBe(true);
  });
});
