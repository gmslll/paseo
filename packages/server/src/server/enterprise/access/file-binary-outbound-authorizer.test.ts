import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  FileTransferOpcode,
  decodeFileTransferFrame,
  encodeFileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { DaemonPermission, NodeContext, PrincipalContext } from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SessionAuthorization } from "../../authorization/index.js";
import { createProductionAuditRuntime } from "../audit/production-audit-runtime.js";
import {
  bindEnterpriseAdmissionSession,
  createEnterpriseAdmissionAuthorizationIssuer,
  issueEnterpriseAdmissionEvidence,
  releaseEnterpriseAdmissionSession,
} from "../identity/admission-authorization.js";
import {
  FILE_BINARY_MAX_ACTIVE_STREAMS,
  canonicalizeFileTransferFrame,
  type ActiveFileDownloadStreamHandle,
} from "./file-binary-outbound-authorizer.js";
import { FileBackedGrantStorage, GrantStore, type GrantVersionSource } from "./grant-store.js";
import { OwnerRegistry } from "./owner-registry.js";
import {
  createEnterpriseAuthorizationRuntime,
  type ProductionAuthorizationRuntime,
  type ProductionAuthorizationRuntimeOptions,
  type ProductionAuthorizationStatePort,
} from "./production-authorization-runtime.js";

const executeFile = promisify(execFile);
const node: NodeContext = {
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "srv_binary",
  mode: "standalone",
};
const principal: PrincipalContext = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  credentialId: "cred_binary",
  grantVersion: "grv_1",
  grants: [
    {
      action: "workspace.content.read",
      selector: { kind: "workspace", workspaceIds: ["wks_a"] },
    },
  ],
};
const resource = {
  organizationId: principal.organizationId,
  nodeId: node.nodeId,
  resourceKind: "workspace" as const,
  localResourceId: "wks_a",
};

class EmptyAuthorityState implements ProductionAuthorizationStatePort {
  async consumeAuthorizedRequest() {
    return null;
  }
  async resolveCurrentSessionBinding() {
    return null;
  }
  async register() {
    return null;
  }
  async resolveOpen() {
    return null;
  }
  async mintFreshReceipt() {
    return null;
  }
  async burnFreshReceipts() {}
  async close() {}
}

class Versions implements GrantVersionSource {
  private value = 1;
  next() {
    this.value += 1;
    return `grv_${this.value}`;
  }
}

let parent = "";
let addonPath = "";

beforeAll(async () => {
  if (process.platform !== "darwin") return;
  parent = await mkdtemp(path.join(os.tmpdir(), "paseo-w2-binary-auth-"));
  addonPath = path.join(parent, "darwin-audit-fs.node");
  await executeFile(process.execPath, [
    fileURLToPath(new URL("../audit/native/build-darwin-audit-fs.mjs", import.meta.url)),
    "--output",
    addonPath,
  ]);
});

afterAll(async () => {
  if (parent) await rm(parent, { recursive: true, force: true });
});

describe("canonicalizeFileTransferFrame", () => {
  test("issues an opaque snapshot only for exact canonical file frames", () => {
    const encoded = beginBytes("download-1", 3);
    const frame = canonicalizeFileTransferFrame(encoded);

    expect(frame).not.toBeNull();
    expect(Reflect.ownKeys(frame!)).toEqual([]);
    expect(Object.isFrozen(frame)).toBe(true);
    expect(canonicalizeFileTransferFrame(new Uint8Array([0xff, 0]))).toBeNull();
    expect(canonicalizeFileTransferFrame({ ...encoded } as never)).toBeNull();
    expect(
      canonicalizeFileTransferFrame(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileBegin,
          requestId: "download-extra",
          metadata: {
            mime: "text/plain",
            size: 0,
            encoding: "utf-8",
            modifiedAt: "2026-09-10T00:00:00.000Z",
            callerAuthority: true,
          } as never,
        }),
      ),
    ).toBeNull();
  });
});

describe.runIf(process.platform === "darwin")("FileBinaryOutboundAuthorizer", () => {
  test("authorizes Begin, repeatable Chunk frames, and one terminal End", async () => {
    const fixture = await createFixture("sequence");
    const beginEncoded = beginBytes("download-1", 5);
    const begin = canonicalizeFileTransferFrame(beginEncoded)!;
    beginEncoded.fill(0xff);
    const opened = await fixture.binary.open({ resource, frame: begin });
    expect(opened).not.toBeNull();
    if (!opened) throw new Error("expected stream");

    const deliveredBegin = fixture.binary.consumeForDelivery(opened.stream, opened.emission);
    expect(decodeFileTransferFrame(deliveredBegin!)?.opcode).toBe(FileTransferOpcode.FileBegin);
    expect(deliveredBegin?.[0]).toBe(FileTransferOpcode.FileBegin);
    expect(fixture.binary.consumeForDelivery(opened.stream, opened.emission)).toBeNull();

    for (const payload of ["he", "llo"]) {
      const emission = await fixture.binary.authorizeNext({
        stream: opened.stream,
        frame: canonicalizeFileTransferFrame(chunkBytes("download-1", payload))!,
      });
      expect(emission).not.toBeNull();
      const delivered = fixture.binary.consumeForDelivery(opened.stream, emission!);
      expect(new TextDecoder().decode(decodeFileTransferFrame(delivered!)?.payload)).toBe(payload);
    }
    const endEmission = await fixture.binary.authorizeNext({
      stream: opened.stream,
      frame: canonicalizeFileTransferFrame(endBytes("download-1"))!,
    });
    expect(endEmission).not.toBeNull();
    expect(
      decodeFileTransferFrame(fixture.binary.consumeForDelivery(opened.stream, endEmission!)!)
        ?.opcode,
    ).toBe(FileTransferOpcode.FileEnd);
    expect(
      await fixture.binary.authorizeNext({
        stream: opened.stream,
        frame: canonicalizeFileTransferFrame(chunkBytes("download-1", "ghost"))!,
      }),
    ).toBeNull();
    await fixture.cleanup();
  });

  test("allows only one pending frame and burns cross-stream emissions", async () => {
    const fixture = await createFixture("one-use");
    const first = await openStream(fixture.runtime, "first", 2);
    const second = await openStream(fixture.runtime, "second", 1);
    const firstChunk = canonicalizeFileTransferFrame(chunkBytes("first", "ab"))!;
    const extraChunk = canonicalizeFileTransferFrame(chunkBytes("first", "x"))!;
    const pending = fixture.binary.authorizeNext({ stream: first, frame: firstChunk });
    const concurrent = fixture.binary.authorizeNext({ stream: first, frame: extraChunk });
    const emission = await pending;

    expect(emission).not.toBeNull();
    await expect(concurrent).resolves.toBeNull();
    expect(fixture.binary.consumeForDelivery(second, emission!)).toBeNull();
    expect(fixture.binary.consumeForDelivery(first, emission!)).toBeNull();
    expect(fixture.binary.close(first, "cancel")).toBe(false);
    expect(fixture.binary.close(second, "cancel")).toBe(true);
    await fixture.cleanup();
  });

  test("burns a pending emission after same-value permission replacement", async () => {
    const fixture = await createFixture("permission");
    const stream = await openStream(fixture.runtime, "permission", 1);
    const emission = await fixture.binary.authorizeNext({
      stream,
      frame: canonicalizeFileTransferFrame(chunkBytes("permission", "x"))!,
    });
    expect(emission).not.toBeNull();

    fixture.sessionAuthorization.replacePermissions(["workspace.read"]);

    expect(fixture.binary.consumeForDelivery(stream, emission!)).toBeNull();
    expect(
      await fixture.binary.authorizeNext({
        stream,
        frame: canonicalizeFileTransferFrame(endBytes("permission"))!,
      }),
    ).toBeNull();
    await fixture.cleanup();
  });

  test("burns pending output on Grant update and W1 session release", async () => {
    const grantFixture = await createFixture("grant");
    const grantStream = await openStream(grantFixture.runtime, "grant", 1);
    const grantEmission = await grantFixture.binary.authorizeNext({
      stream: grantStream,
      frame: canonicalizeFileTransferFrame(chunkBytes("grant", "x"))!,
    });
    await grantFixture.store.update({
      actor: principal,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
      grants: [],
      expectedVersion: principal.grantVersion,
    });
    expect(grantFixture.binary.consumeForDelivery(grantStream, grantEmission!)).toBeNull();
    await grantFixture.cleanup();

    const releaseFixture = await createFixture("release");
    const releaseStream = await openStream(releaseFixture.runtime, "release", 1);
    const releaseEmission = await releaseFixture.binary.authorizeNext({
      stream: releaseStream,
      frame: canonicalizeFileTransferFrame(chunkBytes("release", "x"))!,
    });
    expect(releaseEnterpriseAdmissionSession(releaseFixture.issuer, releaseFixture.handle)).toBe(
      true,
    );
    expect(releaseFixture.binary.consumeForDelivery(releaseStream, releaseEmission!)).toBeNull();
    await releaseFixture.cleanup();
  });

  test("rejects missing coarse permission, mismatched request IDs, and short streams", async () => {
    const denied = await createFixture("denied", []);
    const deniedOpen = await denied.binary.open({
      resource,
      frame: canonicalizeFileTransferFrame(beginBytes("denied", 0))!,
    });
    expect(deniedOpen).toBeNull();
    await denied.cleanup();

    const mismatch = await createFixture("mismatch");
    const stream = await openStream(mismatch.runtime, "expected", 2);
    expect(
      await mismatch.binary.authorizeNext({
        stream,
        frame: canonicalizeFileTransferFrame(chunkBytes("wrong", "x"))!,
      }),
    ).toBeNull();
    expect(mismatch.binary.close(stream, "cancel")).toBe(false);

    const short = await openStream(mismatch.runtime, "short", 2);
    expect(
      await mismatch.binary.authorizeNext({
        stream: short,
        frame: canonicalizeFileTransferFrame(endBytes("short"))!,
      }),
    ).toBeNull();
    await mismatch.cleanup();
  });

  test("fails a deferred frame when admission is revoked across the authorization await", async () => {
    const fixture = await createFixture("await-race");
    const stream = await openStream(fixture.runtime, "race", 1);
    const pending = fixture.binary.authorizeNext({
      stream,
      frame: canonicalizeFileTransferFrame(chunkBytes("race", "x"))!,
    });
    releaseEnterpriseAdmissionSession(fixture.issuer, fixture.handle);

    await expect(pending).resolves.toBeNull();
    expect(fixture.binary.close(stream, "cancel")).toBe(false);
    await fixture.cleanup();
  });

  test("rejects foreign authorizers, resource authority mismatches, and accessors", async () => {
    const first = await createFixture("foreign-a");
    const second = await createFixture("foreign-b");
    const opened = await first.binary.open({
      resource,
      frame: canonicalizeFileTransferFrame(beginBytes("foreign", 0))!,
    });
    expect(opened).not.toBeNull();
    if (!opened) throw new Error("expected stream");
    expect(second.binary.consumeForDelivery(opened.stream, opened.emission)).toBeNull();
    expect(first.binary.consumeForDelivery(opened.stream, opened.emission)).toBeNull();

    const badResourceFrame = canonicalizeFileTransferFrame(beginBytes("bad-resource", 0))!;
    expect(
      await first.binary.open({
        resource: { ...resource, nodeId: "nod_fedcba9876543210" },
        frame: badResourceFrame,
      }),
    ).toBeNull();
    expect(await first.binary.open({ resource, frame: badResourceFrame })).toBeNull();

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "frame", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("hostile frame getter");
      },
    });
    await expect(first.binary.open(accessor as never)).resolves.toBeNull();
    expect(getterCalls).toBe(0);
    const extraFrame = canonicalizeFileTransferFrame(beginBytes("extra-resource", 0))!;
    expect(
      await first.binary.open({
        resource: { ...resource, permission: "workspace.read" } as never,
        frame: extraFrame,
        current: true,
      } as never),
    ).toBeNull();
    expect(await first.binary.open({ resource, frame: extraFrame })).toBeNull();
    await first.cleanup();
    await second.cleanup();
  });

  test("burns a fresh pending emission when the production audit capability closes", async () => {
    const fixture = await createFixture("audit-close");
    const stream = await openStream(fixture.runtime, "audit-close", 1);
    const emission = await fixture.binary.authorizeNext({
      stream,
      frame: canonicalizeFileTransferFrame(chunkBytes("audit-close", "x"))!,
    });
    expect(emission).not.toBeNull();

    await fixture.audit.close();

    expect(fixture.binary.consumeForDelivery(stream, emission!)).toBeNull();
    expect(fixture.binary.close(stream, "cancel")).toBe(false);
    await fixture.runtime.release();
  });

  test("requires workspace.content.read for the exact workspace selector", async () => {
    const missing = await createFixture("missing-action", ["workspace.read"], []);
    expect(
      await missing.binary.open({
        resource,
        frame: canonicalizeFileTransferFrame(beginBytes("missing-action", 0))!,
      }),
    ).toBeNull();
    await missing.cleanup();

    const wrongWorkspace = await createFixture(
      "wrong-selector",
      ["workspace.read"],
      [
        {
          action: "workspace.content.read",
          selector: { kind: "workspace", workspaceIds: ["wks_other"] },
        },
      ],
    );
    expect(
      await wrongWorkspace.binary.open({
        resource,
        frame: canonicalizeFileTransferFrame(beginBytes("wrong-selector", 0))!,
      }),
    ).toBeNull();
    await wrongWorkspace.cleanup();
  });

  test("bounds active stream state and releases capacity on cleanup", async () => {
    const fixture = await createFixture("stream-limit");
    const streams: ActiveFileDownloadStreamHandle[] = [];
    for (let index = 0; index < FILE_BINARY_MAX_ACTIVE_STREAMS; index += 1) {
      streams.push(await openStream(fixture.runtime, `bounded-${index}`, 0));
    }
    expect(
      await fixture.binary.open({
        resource,
        frame: canonicalizeFileTransferFrame(beginBytes("over-limit", 0))!,
      }),
    ).toBeNull();
    expect(fixture.binary.close(streams[0]!, "cancel")).toBe(true);
    const replacement = await fixture.binary.open({
      resource,
      frame: canonicalizeFileTransferFrame(beginBytes("replacement", 0))!,
    });
    expect(replacement).not.toBeNull();
    fixture.binary.closeAll("session_release");
    expect(
      replacement && fixture.binary.consumeForDelivery(replacement.stream, replacement.emission),
    ).toBeNull();
    await fixture.cleanup();
  });

  test("rechecks the server owner registry for every frame", async () => {
    const fixture = await createFixture("owner-revoke");
    const stream = await openStream(fixture.runtime, "owner-revoke", 1);
    fixture.owners.registerWorkspace({ id: "wks_a" });

    expect(
      await fixture.binary.authorizeNext({
        stream,
        frame: canonicalizeFileTransferFrame(chunkBytes("owner-revoke", "x"))!,
      }),
    ).toBeNull();
    expect(fixture.binary.close(stream, "cancel")).toBe(false);
    await fixture.cleanup();
  });

  test.each([
    ["owner", { ownerPrincipalId: "usr_fedcba9876543210" }],
    ["creator", { createdByPrincipalId: "usr_fedcba9876543210" }],
    ["organization", { organizationId: "org_fedcba9876543210" }],
    ["node", { nodeId: "nod_fedcba9876543210" }],
    ["resource", null],
  ] as const)(
    "rechecks exact %s identity between emission authorization and delivery",
    async (name, replacement) => {
      const fixture = await createFixture(`delivery-owner-${name}`);
      const stream = await openStream(fixture.runtime, `delivery-owner-${name}`, 1);
      const emission = await fixture.binary.authorizeNext({
        stream,
        frame: canonicalizeFileTransferFrame(chunkBytes(`delivery-owner-${name}`, "x"))!,
      });
      expect(emission).not.toBeNull();

      fixture.owners.registerWorkspace(
        replacement
          ? {
              id: "wks_a",
              organizationId: principal.organizationId,
              nodeId: node.nodeId,
              ownerPrincipalId: principal.principalId,
              createdByPrincipalId: principal.principalId,
              ...replacement,
            }
          : { id: "wks_a" },
      );

      expect(fixture.binary.consumeForDelivery(stream, emission!)).toBeNull();
      expect(fixture.binary.close(stream, "cancel")).toBe(false);
      await fixture.cleanup();
    },
  );
});

async function openStream(
  runtime: ProductionAuthorizationRuntime,
  requestId: string,
  size: number,
): Promise<ActiveFileDownloadStreamHandle> {
  const opened = await runtime.fileBinaryOutboundAuthorizer.open({
    resource,
    frame: canonicalizeFileTransferFrame(beginBytes(requestId, size))!,
  });
  if (!opened) throw new Error("expected open stream");
  expect(
    runtime.fileBinaryOutboundAuthorizer.consumeForDelivery(opened.stream, opened.emission),
  ).not.toBeNull();
  return opened.stream;
}

function beginBytes(requestId: string, size: number): Uint8Array {
  return encodeFileTransferFrame({
    opcode: FileTransferOpcode.FileBegin,
    requestId,
    metadata: {
      mime: "text/plain",
      size,
      encoding: "utf-8",
      modifiedAt: "2026-09-10T00:00:00.000Z",
    },
  });
}

function chunkBytes(requestId: string, payload: string): Uint8Array {
  return encodeFileTransferFrame({ opcode: FileTransferOpcode.FileChunk, requestId, payload });
}

function endBytes(requestId: string): Uint8Array {
  return encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId });
}

async function createFixture(
  name: string,
  permissions: readonly DaemonPermission[] = ["workspace.read"],
  grants: PrincipalContext["grants"] = principal.grants,
) {
  const audit = await createProductionAuditRuntime({
    node,
    auditRoot: path.join(parent, `audit-${name}`),
    nativeAddonPath: addonPath,
  });
  const storage = new FileBackedGrantStorage(path.join(parent, `grants-${name}.json`));
  await storage.put({
    principalId: principal.principalId,
    organizationId: principal.organizationId,
    grants,
    grantVersion: principal.grantVersion,
  });
  const store = new GrantStore(storage, new Versions(), audit);
  const mintSecret = Object.freeze({});
  const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
  const fixturePrincipal = { ...principal, grants } satisfies PrincipalContext;
  const evidence = issueEnterpriseAdmissionEvidence(issuer, mintSecret, fixturePrincipal, node, {
    node,
    transport: "direct",
    peer: "loopback",
  })!;
  const handle = bindEnterpriseAdmissionSession(issuer, evidence, "client-a")!;
  const owners = new OwnerRegistry();
  owners.registerWorkspace({
    id: "wks_a",
    organizationId: principal.organizationId,
    nodeId: node.nodeId,
    ownerPrincipalId: principal.principalId,
    createdByPrincipalId: principal.principalId,
  });
  const sessionAuthorization = new SessionAuthorization([...permissions]);
  const options = {
    admissionAuthorizationIssuer: issuer,
    admissionAuthorizationHandle: handle,
    grantStore: store,
    audit,
    sessionAuthorization,
    sessionId: `session-${name}`,
    owners,
    authorityState: new EmptyAuthorityState(),
  } satisfies ProductionAuthorizationRuntimeOptions;
  const runtime = await createEnterpriseAuthorizationRuntime(options);
  if (!runtime) throw new Error("expected production runtime");
  return {
    runtime,
    binary: runtime.fileBinaryOutboundAuthorizer,
    store,
    audit,
    issuer,
    handle,
    owners,
    sessionAuthorization,
    cleanup: async () => {
      await runtime.release();
      await audit.close();
    },
  };
}
