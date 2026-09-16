import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { collabPaths, ensureCollabRepoPath } from "./collab-paths.js";
import { CollabRepoStore } from "./loro-repo-store.js";

const CONTAINER = "cws_0123456789abcdef";

let directory: string;
let clock: number;
const open: CollabRepoStore[] = [];

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "collab-repo-"));
  clock = 1_700_000_000_000;
});

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  rmSync(directory, { recursive: true, force: true });
});

function openStore(): CollabRepoStore {
  const store = CollabRepoStore.open({
    path: ensureCollabRepoPath(collabPaths(directory), CONTAINER),
    now: () => clock,
  });
  open.push(store);
  return store;
}

function offset(sequence: number): string {
  return String(sequence).padStart(20, "0");
}

/** An update that sets one key, produced by a document that starts from `base` if given. */
function updateSetting(key: string, value: string, base?: Uint8Array): Uint8Array {
  const document = new LoroDoc();
  if (base) document.importBatch([base]);
  const from = document.version();
  document.getMap("meta").set(key, value);
  document.commit();
  return document.export({ mode: "update", from });
}

describe("collab repo paths", () => {
  test("keeps each container in its own 0700 directory", () => {
    const repoPath = ensureCollabRepoPath(collabPaths(directory), CONTAINER);

    expect(repoPath).toBe(path.join(directory, "enterprise", "collab", CONTAINER, "repo.sqlite3"));
    // ADR-0031 accepts plaintext content at rest only on an encrypted volume; the directory must
    // still not be world-readable.
    const mode = statSync(path.dirname(repoPath)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("refuses a container id that could escape the collab root", () => {
    expect(() => ensureCollabRepoPath(collabPaths(directory), "../../etc")).toThrow(
      "Invalid collaboration container id",
    );
  });
});

describe("producer fencing", () => {
  test("raises the epoch once per boot", () => {
    const first = openStore();
    expect(first.beginProducerEpoch("meta", "node-a")).toMatchObject({ epoch: 1, lastSeq: 0 });
    first.close();
    open.pop();

    // A restart reopens the same file, so the epoch has to survive it.
    const second = openStore();
    expect(second.beginProducerEpoch("meta", "node-a")).toMatchObject({ epoch: 2 });
  });

  test("numbers local updates in sequence under the current epoch", () => {
    const store = openStore();
    store.beginProducerEpoch("meta", "node-a");

    const first = store.enqueueLocalUpdate("meta", updateSetting("title", "one"));
    const second = store.enqueueLocalUpdate(
      "meta",
      updateSetting("subtitle", "two", store.documentSnapshot("meta")!),
    );

    expect([first.producerSeq, second.producerSeq]).toEqual([1, 2]);
    expect([first.producerEpoch, second.producerEpoch]).toEqual([1, 1]);
  });

  test("refuses local work before an epoch is claimed", () => {
    const store = openStore();

    // Producing without an epoch would emit an append the plane fences, losing the work silently.
    expect(() => store.enqueueLocalUpdate("meta", updateSetting("title", "x"))).toThrow(
      "no producer epoch",
    );
  });

  test("carries unsent work into the new epoch without gaps", () => {
    const store = openStore();
    store.beginProducerEpoch("meta", "node-a");
    store.enqueueLocalUpdate("meta", updateSetting("title", "one"));
    store.enqueueLocalUpdate(
      "meta",
      updateSetting("subtitle", "two", store.documentSnapshot("meta")!),
    );
    store.confirmUploaded("meta", 1);

    // The survivor was seq 2 under epoch 1. After a boot it must be renumbered from 1, or the plane
    // sees a sequence that starts with a gap and answers 409.
    const state = store.beginProducerEpoch("meta", "node-a");
    const pending = store.listPendingUpdates("meta");

    expect(state).toMatchObject({ epoch: 2, lastSeq: 1 });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ producerSeq: 1, producerEpoch: 2 });
  });
});

describe("the outbound queue", () => {
  test("survives a restart so a crash never drops produced work", () => {
    const first = openStore();
    first.beginProducerEpoch("meta", "node-a");
    first.enqueueLocalUpdate("meta", updateSetting("title", "one"));
    first.close();
    open.pop();

    const second = openStore();
    expect(second.listPendingUpdates("meta")).toHaveLength(1);
    // The replica moved with it: the document is not rebuilt from the queue.
    expect(second.document("meta").getMap("meta").get("title")).toBe("one");
  });

  test("clears only what the plane acknowledged", () => {
    const store = openStore();
    store.beginProducerEpoch("meta", "node-a");
    store.enqueueLocalUpdate("meta", updateSetting("a", "1"));
    store.enqueueLocalUpdate("meta", updateSetting("b", "2", store.documentSnapshot("meta")!));
    store.enqueueLocalUpdate("meta", updateSetting("c", "3", store.documentSnapshot("meta")!));

    expect(store.confirmUploaded("meta", 2)).toBe(2);
    expect(store.listPendingUpdates("meta").map((entry) => entry.producerSeq)).toEqual([3]);
  });
});

describe("resuming from the plane", () => {
  test("advances the cursor to the last applied offset", () => {
    const store = openStore();
    const remote = new LoroDoc();
    remote.getMap("meta").set("owner", "someone");
    remote.commit();

    const next = store.applyRemoteUpdates("meta", [
      { offset: offset(1), update: remote.export({ mode: "update" }) },
    ]);

    expect(next).toBe(offset(1));
    expect(store.remoteCursors()).toEqual({ meta: offset(1) });
    expect(store.document("meta").getMap("meta").get("owner")).toBe("someone");
  });

  test("keeps the cursor after a restart so the uplink resumes instead of replaying", () => {
    const first = openStore();
    const remote = new LoroDoc();
    remote.getMap("meta").set("owner", "someone");
    remote.commit();
    first.applyRemoteUpdates("meta", [
      { offset: offset(7), update: remote.export({ mode: "update" }) },
    ]);
    first.close();
    open.pop();

    expect(openStore().remoteCursors()).toEqual({ meta: offset(7) });
  });

  test("leaves the cursor alone for an empty batch", () => {
    const store = openStore();

    expect(store.applyRemoteUpdates("meta", [])).toBeNull();
    expect(store.remoteCursors()).toEqual({});
  });

  test("refuses an offset that is not a stream offset", () => {
    const store = openStore();

    expect(() =>
      store.applyRemoteUpdates("meta", [{ offset: "12", update: new Uint8Array() }]),
    ).toThrow("Invalid stream offset");
  });

  test("refuses a segment the protocol does not define", () => {
    const store = openStore();

    expect(() => store.beginProducerEpoch("nonsense:1", "node-a")).toThrow(
      "Unknown collaboration segment",
    );
  });

  test("rejects an update whose dependencies are missing, leaving the cursor untouched", () => {
    const store = openStore();
    const remote = new LoroDoc();
    remote.getMap("meta").set("first", "1");
    remote.commit();
    const base = remote.version();
    remote.getMap("meta").set("second", "2");
    remote.commit();

    // Only the second update, so its dependency never arrived.
    expect(() =>
      store.applyRemoteUpdates("meta", [
        { offset: offset(2), update: remote.export({ mode: "update", from: base }) },
      ]),
    ).toThrow("missing dependencies");
    expect(store.remoteCursor("meta")).toBeNull();
  });
});

describe("the RPC inbox", () => {
  const RPC_ID = "rpc_0f8fad5b-d9cb-469f-a165-70867728950e";

  test("accepts an id once and refuses the replay", () => {
    const store = openStore();

    expect(store.rememberRpc(RPC_ID, "agent.prompt", clock + 60_000)).toBe(true);
    expect(store.rememberRpc(RPC_ID, "agent.prompt", clock + 60_000)).toBe(false);
  });

  test("keeps refusing a replay after a restart", () => {
    const first = openStore();
    first.rememberRpc(RPC_ID, "agent.prompt", clock + 60_000);
    first.close();
    open.pop();

    // Dedup that lived only in memory would let a crash reopen the replay window.
    expect(openStore().rememberRpc(RPC_ID, "agent.prompt", clock + 60_000)).toBe(false);
  });

  test("sweeps only entries past their signed expiry", () => {
    const store = openStore();
    store.rememberRpc(RPC_ID, "agent.prompt", clock + 60_000);
    store.rememberRpc("rpc_1f8fad5b-d9cb-469f-a165-70867728950e", "agent.prompt", clock + 120_000);

    clock += 90_000;

    expect(store.sweepRpcInbox()).toBe(1);
    // Past the window the plane signed, the id may be reused; that is the plane's replay guard now.
    expect(store.rememberRpc(RPC_ID, "agent.prompt", clock + 60_000)).toBe(true);
  });
});
