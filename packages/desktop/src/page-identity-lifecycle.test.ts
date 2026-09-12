import { describe, expect, it } from "vitest";
import {
  closeBrowserPageIdentityLifecycle,
  createBrowserPageIdentityCloseBarrier,
} from "./page-identity-lifecycle.js";

describe("browser page identity lifecycle", () => {
  it("serializes close barrier and quit order", async () => {
    const events: string[] = [];
    let released = 0;
    let releaseRetire!: () => void;
    const retireGate = new Promise<void>((resolve) => (releaseRetire = resolve));
    const onClose = createBrowserPageIdentityCloseBarrier({
      retireRoute: async () => {
        events.push("retireRoute");
        await retireGate;
      },
      unregisterHost: async () => events.push("unregisterHost"),
      release: () => {
        events.push("close");
        released += 1;
      },
    });
    onClose(() => events.push("prevent"));
    onClose(() => events.push("prevent"));
    await Promise.resolve();
    expect(events).toEqual(["prevent", "retireRoute", "prevent"]);
    releaseRetire();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["prevent", "retireRoute", "prevent", "unregisterHost", "close"]);
    expect(released).toBe(1);
    await closeBrowserPageIdentityLifecycle({
      controllerClose: async () => events.push("controller"),
      disposer: async () => events.push("disposer"),
      registryClose: async () => events.push("registry"),
      transportClose: async () => events.push("transport"),
    });
    expect(events.slice(-4)).toEqual(["controller", "disposer", "registry", "transport"]);
  });

  it("reports retire and unregister failures without duplicate release", async () => {
    for (const phase of ["retire", "unregister"] as const) {
      const errors: unknown[] = [];
      let released = 0;
      const onClose = createBrowserPageIdentityCloseBarrier({
        retireRoute: async () => {
          if (phase === "retire") throw new Error("retire");
        },
        unregisterHost: async () => {
          if (phase === "unregister") throw new Error("unregister");
        },
        release: () => {
          released += 1;
        },
        onError: (error) => errors.push(error),
      });
      onClose(() => {});
      onClose(() => {});
      await Promise.resolve();
      await Promise.resolve();
      expect(errors).toHaveLength(1);
      expect(released).toBe(1);
    }
  });
});
