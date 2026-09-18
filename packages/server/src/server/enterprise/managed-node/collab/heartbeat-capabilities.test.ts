import { describe, expect, test } from "vitest";
import { collaborationHeartbeatCapabilities } from "./heartbeat-capabilities.js";

describe("collaboration heartbeat capabilities", () => {
  test("a collaborating node declares collaborationV1 even if enrollment did not", () => {
    expect(
      collaborationHeartbeatCapabilities({
        capabilities: { platform: "darwin", enterpriseManagedV1: true },
        collaborationOn: true,
      }),
    ).toEqual({
      platform: "darwin",
      enterpriseManagedV1: true,
      collaborationV1: true,
    });
  });

  test("a node without the collab runtime does not declare collaborationV1", () => {
    expect(
      collaborationHeartbeatCapabilities({
        capabilities: { platform: "darwin", collaborationV1: true },
        collaborationOn: false,
      }),
    ).toEqual({ platform: "darwin" });
  });
});
