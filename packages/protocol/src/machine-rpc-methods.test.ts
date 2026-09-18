import { describe, expect, test } from "vitest";

import {
  MACHINE_RPC_METHODS,
  MachineRpcMethodSchema,
  machineRpcMethodPolicy,
} from "./enterprise-collaboration.js";

describe("the machine RPC method table", () => {
  test("every method is a well-formed method name", () => {
    for (const method of Object.keys(MACHINE_RPC_METHODS)) {
      expect(MachineRpcMethodSchema.safeParse(method).success).toBe(true);
    }
  });

  test("refuses a method the table does not list", () => {
    // The table is the allowlist ADR-0035 asks for, so an unlisted method has no policy at all
    // rather than a permissive default.
    expect(machineRpcMethodPolicy("agent.delete")).toBeNull();
    expect(machineRpcMethodPolicy("machine.shutdown")).toBeNull();
    // Inherited object keys must not answer as methods.
    expect(machineRpcMethodPolicy("constructor")).toBeNull();
    expect(machineRpcMethodPolicy("toString")).toBeNull();
  });

  test("does not list steering, which is a parameter rather than a method", () => {
    // Steering is send_agent_message_request's activeTurnBehavior. A method named for it would
    // name something that does not exist.
    expect(machineRpcMethodPolicy("agent.steer")).toBeNull();
    expect(machineRpcMethodPolicy("agent.interrupt")).toBeNull();
  });

  test("points each workspace method at the Session request it becomes", () => {
    // The actions are the entry's own; a test in the daemon pins them to its entry mapping, which
    // this package cannot import.
    expect(machineRpcMethodPolicy("agent.send")).toEqual({
      scope: "workspace",
      entry: "send_agent_message_request",
      actions: ["workspace.write"],
    });
    expect(machineRpcMethodPolicy("agent.cancel")).toEqual({
      scope: "workspace",
      entry: "cancel_agent_request",
      actions: ["workspace.write"],
    });
    expect(machineRpcMethodPolicy("checkout.status")).toEqual({
      scope: "workspace",
      entry: "checkout_status_request",
      actions: ["workspace.content.read"],
    });
  });

  test("answers the machine methods without deriving them", () => {
    // restart_server_request carries daemon.manage, which maps to no enterprise action. Deriving a
    // role from an empty action list would be satisfied by every role, viewer included, so these
    // are stated instead.
    expect(machineRpcMethodPolicy("machine.restart")).toEqual({
      scope: "machine",
      requires: "owner",
    });
    expect(machineRpcMethodPolicy("machine.upgrade")).toEqual({
      scope: "machine",
      requires: "owner",
    });
    expect(machineRpcMethodPolicy("machine.get_status")).toEqual({
      scope: "machine",
      requires: "member",
    });
  });

  test("never names a Session entry for a machine method", () => {
    // A machine method with an entry would fall back into the derivation this table exists to
    // avoid.
    for (const policy of Object.values(MACHINE_RPC_METHODS)) {
      if (policy.scope === "machine") expect("entry" in policy).toBe(false);
      else expect(policy.entry.length).toBeGreaterThan(0);
    }
  });
});
