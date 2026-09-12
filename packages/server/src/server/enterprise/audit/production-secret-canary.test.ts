import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { createEnterpriseSessionBindingKey } from "@getpaseo/protocol/messages";
import { WebSocket } from "ws";
import { describe, expect, test, vi } from "vitest";

import type { SessionAdmission } from "../../websocket-server.js";
import { isCurrentProductionAuthorizationRuntimeProvider } from "../access/production-authorization-runtime-provider.js";
import {
  isCurrentEnterpriseAdmissionAuthorization,
  resolveCurrentEnterpriseAdmissionAuthorization,
} from "../identity/admission-authorization.js";
import { EnterpriseAdmission } from "../identity/admission.js";
import { parsePersonalAccessToken } from "../identity/registry.js";
import type { EnterpriseAdmissionRuntime } from "../identity/runtime.js";
import {
  createProductionDirectDaemonTestHarness,
  PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED,
  type ProductionDirectDaemonTestHarness,
  type ProductionDirectWsEnvelope as WsEnvelope,
} from "./production-direct-daemon-test-helper.js";
import { productionAuditCapabilityIssuer } from "./production-audit-runtime.js";

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function decodedLogLines(chunks: readonly string[]): Array<Record<string, unknown>> {
  return chunks
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function countLogMessage(chunks: readonly string[], message: string): number {
  return decodedLogLines(chunks).filter((line) => line.msg === message).length;
}

function assertCanaryAbsent(
  label: string,
  serialized: string,
  personalAccessToken: string,
  fingerprint: string,
): void {
  expect(serialized, `${label} contained the personal access token`).not.toContain(
    personalAccessToken,
  );
  expect(serialized, `${label} contained the token fingerprint`).not.toContain(fingerprint);
}

function parseFrame(data: string): WsEnvelope | null {
  try {
    return JSON.parse(data) as WsEnvelope;
  } catch {
    return null;
  }
}

async function connectRejected(input: {
  readonly url: string;
  readonly token: string;
  readonly clientId: string;
}): Promise<{ readonly closeCode: number; readonly outboundFrames: string[] }> {
  const socket = new WebSocket(input.url, [`paseo.bearer.${input.token}`]);
  const outboundFrames: string[] = [];
  socket.on("message", (data) => outboundFrames.push(data.toString()));
  const closed = new Promise<number>((resolve, reject) => {
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId: input.clientId,
          clientType: "browser",
          protocolVersion: 1,
        }),
      );
    });
    socket.once("close", (code) => resolve(code));
    socket.once("error", reject);
  });
  return { closeCode: await closed, outboundFrames };
}

function outboundMessage(
  frames: readonly string[],
  predicate: (value: WsEnvelope) => boolean,
): WsEnvelope | undefined {
  for (const frame of frames) {
    const value = parseFrame(frame);
    if (value && predicate(value)) return value;
  }
  return undefined;
}

function isIdentityResponse(value: WsEnvelope): boolean {
  return (
    value.type === "session" && value.message?.type === "enterprise.identity.get_current.response"
  );
}

function isAuditListResponse(value: WsEnvelope): boolean {
  return (
    value.type === "session" && value.message?.type === "enterprise.audit.list_events.response"
  );
}

describe.runIf(PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED)(
  "production enterprise secret canary evidence",
  () => {
    // oxlint-disable-next-line complexity -- one sequential production lifecycle is the evidence boundary.
    test("keeps a high-entropy PAT and fingerprint out of production direct-WS surfaces", async () => {
      const serverId = "srv_case15";
      const organizationId = "org_abcdef0123456789";
      const principalId = "usr_abcdef0123456789";
      const nodeId = "nod_abcdef0123456789";
      const grantVersion = "grv_case15";
      const auditInputs: unknown[] = [];
      const loggerChunks: string[] = [];
      const sockets: WebSocket[] = [];
      let harness: ProductionDirectDaemonTestHarness | undefined;
      let daemonRuntime: EnterpriseAdmissionRuntime | undefined;
      let paseoHome = "";
      let personalAccessToken: string | undefined;
      let fingerprint: string | undefined;
      try {
        const seedInput = Object.freeze({
          organizationId,
          actorPrincipalId: principalId,
          action: "audit.read",
          resource: { kind: "daemon", id: nodeId },
          outcome: "allowed" as const,
        });
        auditInputs.push(structuredClone(seedInput));
        harness = await createProductionDirectDaemonTestHarness({
          name: "production-secret-canary",
          serverId,
          organizationId,
          nodeId,
          principals: [
            {
              principalId,
              grantVersion,
              grants: [
                {
                  action: "audit.read",
                  selector: { kind: "organization", organizationId },
                },
              ],
            },
          ],
          preparatoryAuditInputs: [seedInput],
          loggerChunks,
        });
        paseoHome = harness.paseoHome;
        const issued = await harness.issuePersonalAccessToken(principalId);
        personalAccessToken = issued.token;
        fingerprint = createHash("sha256").update(personalAccessToken).digest("hex");
        const parsedToken = parsePersonalAccessToken(personalAccessToken);
        expect(parsedToken).not.toBeNull();
        expect(Buffer.from(parsedToken!.secret, "base64url")).toHaveLength(32);
        expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
        await harness.start();
        daemonRuntime = harness.runtime;
        expect(daemonRuntime.admission).toBeInstanceOf(EnterpriseAdmission);
        const connection = {
          node: daemonRuntime.node,
          transport: "direct" as const,
          peer: "loopback" as const,
          remoteAddress: "127.0.0.1",
        };

        const closeEvidence = await daemonRuntime.admission.authenticateEvidence(
          personalAccessToken,
          connection,
        );
        if (!closeEvidence) throw new Error("expected production admission evidence");
        const sessionAdmissionSnapshot = {
          kind: "enterprise",
          authorizationEvidence: closeEvidence,
        } satisfies SessionAdmission;
        const closeHandle = daemonRuntime.admission.bindSession(closeEvidence, "case15-close");
        if (!closeHandle) throw new Error("expected close-test admission handle");
        const closeSnapshot = resolveCurrentEnterpriseAdmissionAuthorization(
          daemonRuntime.admission.authorizationIssuer,
          closeHandle,
        );
        if (!closeSnapshot) throw new Error("expected current close-test admission snapshot");
        expect(
          isCurrentEnterpriseAdmissionAuthorization(
            daemonRuntime.admission.authorizationIssuer,
            closeHandle,
          ),
        ).toBe(true);
        expect(daemonRuntime.admission.releaseSession(closeHandle)).toBe(true);
        expect(
          isCurrentEnterpriseAdmissionAuthorization(
            daemonRuntime.admission.authorizationIssuer,
            closeHandle,
          ),
        ).toBe(false);

        const revokeEvidence = await daemonRuntime.admission.authenticateEvidence(
          personalAccessToken,
          connection,
        );
        if (!revokeEvidence) throw new Error("expected revoke-test admission evidence");
        const revokeHandle = daemonRuntime.admission.bindSession(revokeEvidence, "case15-revoke");
        if (!revokeHandle) throw new Error("expected revoke-test admission handle");
        const revokeSnapshot = resolveCurrentEnterpriseAdmissionAuthorization(
          daemonRuntime.admission.authorizationIssuer,
          revokeHandle,
        );
        if (!revokeSnapshot) throw new Error("expected current revoke-test admission snapshot");

        const url = harness.url;
        const clientId = "case15-direct";
        const valid = await harness.connectAndHello({ token: personalAccessToken, clientId });
        sockets.push(valid.socket);
        valid.socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "enterprise.identity.get_current.request",
              requestId: "case15-identity",
            },
          }),
        );
        await vi.waitFor(() =>
          expect(outboundMessage(valid.outboundFrames, isIdentityResponse)).not.toBeUndefined(),
        );
        valid.socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "enterprise.audit.list_events.request",
              requestId: "case15-audit",
              limit: 100,
            },
          }),
        );
        await vi.waitFor(() =>
          expect(outboundMessage(valid.outboundFrames, isAuditListResponse)).not.toBeUndefined(),
        );

        const directGeneration = String(Number(revokeSnapshot.sessionBindingGeneration) + 1);
        const directBindingKey = createEnterpriseSessionBindingKey({
          organizationId,
          principalId,
          credentialId: issued.credentialId,
          grantVersion,
          clientId,
        });
        const directBinding =
          await daemonRuntime.authorityReceiptState.resolveCurrentSessionBinding({
            sessionBindingKey: directBindingKey,
            sessionBindingGeneration: directGeneration,
          });
        expect(directBinding).toMatchObject({
          sessionBindingKey: directBindingKey,
          sessionBindingGeneration: directGeneration,
          organizationId,
          principalId,
          credentialId: issued.credentialId,
          grantVersion,
          nodeId,
          clientId,
        });
        const runtimeSnapshot = {
          audit: {
            adapterKind: daemonRuntime.audit.adapterKind,
            node: daemonRuntime.audit.node,
            releaseReady: daemonRuntime.audit.releaseReady,
          },
          admission: {
            type: daemonRuntime.admission.constructor.name,
            node: daemonRuntime.admission.authenticator.node,
            organizationId: daemonRuntime.admission.authenticator.configuredOrganizationId,
          },
          closedAdmission: closeSnapshot,
          revocableAdmission: revokeSnapshot,
          directBinding,
          ownerState: {
            quarantined: daemonRuntime.authorizationRuntimeProvider?.owners.quarantined() ?? [],
            canaryWorkspace:
              daemonRuntime.authorizationRuntimeProvider?.owners.getWorkspace("wks_case15") ?? null,
          },
        };
        assertCanaryAbsent(
          "SessionAdmission snapshot",
          JSON.stringify(sessionAdmissionSnapshot),
          personalAccessToken,
          fingerprint,
        );
        assertCanaryAbsent(
          "runtime snapshots",
          JSON.stringify(runtimeSnapshot),
          personalAccessToken,
          fingerprint,
        );

        const tokenParts = parsePersonalAccessToken(personalAccessToken)!;
        const wrongToken = `pso_u_${tokenParts.credentialId}.${randomBytes(32).toString("base64url")}`;
        const beforeWrongEvents = await daemonRuntime.audit.snapshotEvents();
        const beforeWrongAllowed = beforeWrongEvents.filter(
          (event) => event.outcome === "allowed",
        ).length;
        const beforeWrongAwaiting = countLogMessage(
          loggerChunks,
          "Client connected; awaiting hello",
        );
        const beforeWrongSessions = countLogMessage(loggerChunks, "Client connected via hello");
        const beforeWrongOwner = JSON.stringify(runtimeSnapshot.ownerState);
        const wrong = await connectRejected({
          url,
          token: wrongToken,
          clientId: "case15-wrong",
        });
        expect(wrong.closeCode).toBe(4401);
        expect(wrong.outboundFrames).toEqual([]);
        const afterWrongEvents = await daemonRuntime.audit.snapshotEvents();
        expect(afterWrongEvents.filter((event) => event.outcome === "allowed")).toHaveLength(
          beforeWrongAllowed,
        );
        expect(countLogMessage(loggerChunks, "Client connected; awaiting hello")).toBe(
          beforeWrongAwaiting,
        );
        expect(countLogMessage(loggerChunks, "Client connected via hello")).toBe(
          beforeWrongSessions,
        );
        expect(
          JSON.stringify({
            quarantined: daemonRuntime.authorizationRuntimeProvider?.owners.quarantined() ?? [],
            canaryWorkspace:
              daemonRuntime.authorizationRuntimeProvider?.owners.getWorkspace("wks_case15") ?? null,
          }),
        ).toBe(beforeWrongOwner);
        expect(daemonRuntime.agentContextRegistry.resolve("agt_case15_wrong")).toBeNull();
        expect(
          await daemonRuntime.authorityReceiptState.resolveCurrentSessionBinding({
            sessionBindingKey: createEnterpriseSessionBindingKey({
              organizationId,
              principalId,
              credentialId: issued.credentialId,
              grantVersion,
              clientId: "case15-wrong",
            }),
            sessionBindingGeneration: String(Number(directGeneration) + 1),
          }),
        ).toBeNull();

        const revokeActor = await daemonRuntime.admission.authenticate(
          harness.breakGlassPassword,
          connection,
        );
        if (!revokeActor) throw new Error("expected break-glass revoke actor");
        await expect(
          (daemonRuntime.admission as EnterpriseAdmission).registry.revokeCredential(
            revokeActor,
            issued.credentialId,
          ),
        ).resolves.toBe(true);
        expect(
          isCurrentEnterpriseAdmissionAuthorization(
            daemonRuntime.admission.authorizationIssuer,
            revokeHandle,
          ),
        ).toBe(false);
        await expect(
          daemonRuntime.admission.isCurrentPrincipalContext(issued.principal),
        ).resolves.toBe(false);
        await vi.waitFor(async () =>
          expect(
            await daemonRuntime!.authorityReceiptState.resolveCurrentSessionBinding({
              sessionBindingKey: directBindingKey,
              sessionBindingGeneration: directGeneration,
            }),
          ).toBeNull(),
        );

        const beforeRevokedEvents = await daemonRuntime.audit.snapshotEvents();
        const beforeRevokedAllowed = beforeRevokedEvents.filter(
          (event) => event.outcome === "allowed",
        ).length;
        const beforeRevokedAwaiting = countLogMessage(
          loggerChunks,
          "Client connected; awaiting hello",
        );
        const beforeRevokedSessions = countLogMessage(loggerChunks, "Client connected via hello");
        const revoked = await connectRejected({
          url,
          token: personalAccessToken,
          clientId: "case15-revoked",
        });
        expect(revoked.closeCode).toBe(4401);
        expect(revoked.outboundFrames).toEqual([]);
        const auditEvents = await daemonRuntime.audit.snapshotEvents();
        expect(auditEvents).toHaveLength(beforeRevokedEvents.length);
        expect(auditEvents.filter((event) => event.outcome === "allowed")).toHaveLength(
          beforeRevokedAllowed,
        );
        expect(countLogMessage(loggerChunks, "Client connected; awaiting hello")).toBe(
          beforeRevokedAwaiting,
        );
        expect(countLogMessage(loggerChunks, "Client connected via hello")).toBe(
          beforeRevokedSessions,
        );
        expect(daemonRuntime.agentContextRegistry.resolve("agt_case15_revoked")).toBeNull();

        assertCanaryAbsent(
          "captured logger lines",
          loggerChunks.join(""),
          personalAccessToken,
          fingerprint,
        );
        assertCanaryAbsent(
          "audit inputs",
          JSON.stringify(auditInputs),
          personalAccessToken,
          fingerprint,
        );
        assertCanaryAbsent(
          "audit events",
          JSON.stringify(auditEvents),
          personalAccessToken,
          fingerprint,
        );
        assertCanaryAbsent(
          "server_info and outbound frames",
          JSON.stringify([
            ...valid.outboundFrames,
            ...wrong.outboundFrames,
            ...revoked.outboundFrames,
          ]),
          personalAccessToken,
          fingerprint,
        );

        const credentialsPath = path.join(paseoHome, "enterprise", "credentials.json");
        const credentialsText = await readFile(credentialsPath, "utf8");
        const credentials = JSON.parse(credentialsText) as {
          version: number;
          credentials: Record<string, Record<string, unknown>>;
        };
        expect(credentials.version).toBe(1);
        expect(Object.keys(credentials.credentials)).toEqual([issued.credentialId]);
        const credential = credentials.credentials[issued.credentialId]!;
        expect(Object.keys(credential).sort()).toEqual(
          [
            "credentialId",
            "principalId",
            "organizationId",
            "secretHash",
            "createdAt",
            "lastUsedAt",
            "revokedAt",
          ].sort(),
        );
        expect(credential).toMatchObject({
          credentialId: issued.credentialId,
          principalId,
          organizationId,
          secretHash: expect.stringMatching(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/),
          createdAt: expect.any(String),
          lastUsedAt: expect.any(String),
          revokedAt: expect.any(String),
        });
        assertCanaryAbsent("credentials.json", credentialsText, personalAccessToken, fingerprint);

        await harness.stop();
        expect(productionAuditCapabilityIssuer.current(daemonRuntime.audit)).toBe(false);
        expect(
          isCurrentProductionAuthorizationRuntimeProvider(
            daemonRuntime.authorizationRuntimeProvider,
          ),
        ).toBe(false);

        const persistedFiles = await filesUnder(paseoHome);
        const persistedBytes = await Promise.all(persistedFiles.map((file) => readFile(file)));
        for (const [index, contents] of persistedBytes.entries()) {
          assertCanaryAbsent(
            `paseoHome file ${path.relative(paseoHome, persistedFiles[index]!)}`,
            contents.toString("utf8"),
            personalAccessToken,
            fingerprint,
          );
        }

        const evidenceArtifact = JSON.stringify({
          case: 15,
          canary: {
            tokenLength: personalAccessToken.length,
            fingerprintAlgorithm: "sha256",
            fingerprintLength: fingerprint.length,
            fingerprintIdentifier: "runtime-only",
          },
          counts: {
            loggerLines: decodedLogLines(loggerChunks).length,
            auditInputs: auditInputs.length,
            auditEvents: auditEvents.length,
            outboundFrames:
              valid.outboundFrames.length +
              wrong.outboundFrames.length +
              revoked.outboundFrames.length,
            persistedFiles: persistedFiles.length,
            rejectedAttempts: 2,
          },
          credentialStorage: { records: 1, hash: "bcrypt", cost: 12 },
        });
        assertCanaryAbsent("evidence artifact", evidenceArtifact, personalAccessToken, fingerprint);
        expect(Object.keys(JSON.parse(evidenceArtifact))).toEqual([
          "case",
          "canary",
          "counts",
          "credentialStorage",
        ]);
      } finally {
        for (const socket of sockets) socket.close();
        await harness?.close().catch(() => undefined);
        personalAccessToken = undefined;
        fingerprint = undefined;
      }
    }, 120_000);
  },
);
