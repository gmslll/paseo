import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  DaemonRuntimeInstallRequestSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const runtime = {
  runtimeName: "claude-code",
  pinnedVersion: "2.1.258",
  activeVersion: null,
  installedVersions: [],
  status: "not_installed",
  commandPath: null,
  error: null,
};

describe("managed runtime RPCs", () => {
  test("the daemon session accepts runtime status and install requests", () => {
    const status = { type: "daemon.runtime.get_status.request", requestId: "r1" };
    const install = {
      type: "daemon.runtime.install.request",
      requestId: "r2",
      runtimeName: "claude-code",
    };

    expect(SessionInboundMessageSchema.parse(status)).toEqual(status);
    expect(SessionInboundMessageSchema.parse(install)).toEqual(install);
    expect(
      DaemonRuntimeInstallRequestSchema.safeParse({
        type: "daemon.runtime.install.request",
        requestId: "r3",
      }).success,
    ).toBe(false);
  });

  test("clients parse runtime status and install responses", () => {
    const status = {
      type: "daemon.runtime.get_status.response",
      payload: { requestId: "r1", runtimes: [runtime] },
    };
    const install = {
      type: "daemon.runtime.install.response",
      payload: { requestId: "r2", runtime: { ...runtime, status: "installed" } },
    };

    expect(SessionOutboundMessageSchema.parse(status)).toEqual(status);
    expect(SessionOutboundMessageSchema.parse(install)).toEqual(install);
  });

  test("an older client ignores fields a newer daemon adds to a runtime status", () => {
    const LegacyRuntimeStatusSchema = z.object({
      runtimeName: z.string(),
      status: z.string(),
    });

    expect(
      LegacyRuntimeStatusSchema.parse({ ...runtime, rolloutPercent: 50, channel: "stable" }),
    ).toEqual({ runtimeName: "claude-code", status: "not_installed" });
  });
});
