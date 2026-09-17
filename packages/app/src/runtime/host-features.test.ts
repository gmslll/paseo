import { describe, expect, test } from "vitest";

import {
  hostSupportsFeature,
  selectHostFeature,
  type HostFeatureName,
  type HostFeatureSessionState,
} from "./host-features";
import type { DaemonServerInfo } from "@/stores/session-store";

const SERVER_ID = "srv_a";

function serverInfo(features: DaemonServerInfo["features"]): DaemonServerInfo {
  return { features } as DaemonServerInfo;
}

function stateWith(info: DaemonServerInfo | null): HostFeatureSessionState {
  return { sessions: { [SERVER_ID]: { serverInfo: info } } };
}

describe("reading what a host supports", () => {
  test("a feature the host advertises is supported, one it omits is not", () => {
    expect(hostSupportsFeature(serverInfo({ managedRuntimes: true }), "managedRuntimes")).toBe(
      true,
    );
    expect(hostSupportsFeature(serverInfo({}), "managedRuntimes")).toBe(false);
  });

  test("an absent host supports nothing rather than throwing", () => {
    // A session can be known before its server_info arrives, and every gate reads through here.
    expect(hostSupportsFeature(null, "managedRuntimes")).toBe(false);
    expect(hostSupportsFeature(undefined, "managedRuntimes")).toBe(false);
    expect(selectHostFeature({ sessions: {} }, SERVER_ID, "managedRuntimes")).toBe(false);
    expect(selectHostFeature(stateWith(null), SERVER_ID, "managedRuntimes")).toBe(false);
  });

  test("collaboration needs no gate of its own", () => {
    // HostFeatureName is keyof the protocol's feature map, so naming this key here is what proves
    // the claim: a collaboration surface calls useHostFeature like every other feature, and the key
    // became usable the moment the daemon started advertising it. If it were not in the protocol
    // type, this line would not compile.
    const collaboration: HostFeatureName = "enterpriseCollaborationV1";

    expect(
      selectHostFeature(
        stateWith(serverInfo({ enterpriseCollaborationV1: true })),
        SERVER_ID,
        collaboration,
      ),
    ).toBe(true);
    // A daemon whose collaboration stack was never wired advertises nothing, and the gate closes.
    expect(
      selectHostFeature(
        stateWith(serverInfo({ enterpriseIdentityV1: true })),
        SERVER_ID,
        collaboration,
      ),
    ).toBe(false);
  });
});
