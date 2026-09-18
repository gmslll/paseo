import { spawn, type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { BrowserProfileRecord } from "@getpaseo/protocol/messages";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";

import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../../agent/tools/types.js";
import type { BrowserToolsBroker } from "../../browser-tools/broker.js";
import type { AuthenticatedBrowserHostSession } from "../../browser-tools/page-identity-registry.js";
import { registerBrowserTools } from "../../browser-tools/tools.js";
import type { EnterpriseAdmissionRuntime } from "../identity/runtime.js";
import { DarwinWorkspaceFileSystem } from "../runtime/darwin-workspace-fs.js";
import { ResourceAuthorizationService } from "../access/resource-authorization.js";
import { resolveProductionBrowserProfileRegistry } from "../production-runtime-factory.js";
import {
  createProductionDirectDaemonTestHarness,
  PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED,
  type ProductionDirectDaemonTestHarness,
  type ProductionDirectSocket,
  type ProductionDirectWsEnvelope,
} from "./production-direct-daemon-test-helper.js";

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
);
const driverPath = path.join(
  repositoryRoot,
  "packages/desktop/e2e/enterprise-browser-page-identity-electron-main.mjs",
);
const DRIVER_PREFIX = "CASE13 ";
const DRIVER_TIMEOUT_MS = 20_000;
const ORGANIZATION_ID = "org_1313131313131313";
const PRINCIPAL_ID = "usr_1313131313131313";
const NODE_ID = "nod_1313131313131313";
const SERVER_ID = "srv_case13";
const WORKSPACE_ID = "wks_case13";
const AGENT_ID = "13131313-1313-4131-8131-131313131313";
const BUSINESS_IDENTITY_ID = "bid_1313131313131313";
const BROWSER_ID = "13131313-1313-4131-8131-131313131313";
const GRANT_VERSION = "grv_case13";

interface DriverMessage {
  readonly kind: "event" | "fatal" | "response";
  readonly event?: string;
  readonly flags?: { readonly observation?: boolean; readonly invalidation?: boolean };
  readonly id?: string;
  readonly ok?: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
}

interface DriverStats {
  readonly outboundFrameCount: number;
  readonly outboundByteLength: number;
  readonly automationRequestCount: number;
  readonly contentResponseCount: number;
  readonly protectedOutboundCount: number;
  readonly rpcErrorCount: number;
  readonly leakCount: number;
  readonly publisherErrorCount: number;
  readonly authorityTeardownCount: number;
}

interface RegisteredProductionBrowserHost {
  readonly routeId: string;
  readonly authenticatedSession?: AuthenticatedBrowserHostSession;
}

interface ProductionBrokerInternals {
  readonly clients: Map<string, RegisteredProductionBrowserHost>;
}

interface RegisteredBrowserTool {
  readonly config: PaseoToolConfig;
  readonly handler: (
    input: unknown,
    context: PaseoToolExecutionContext,
  ) => Promise<PaseoToolResult>;
}

class ElectronPageIdentityDriver {
  readonly stdoutChunks: string[] = [];
  readonly stderrChunks: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly readyPromise: Promise<DriverMessage>;
  private resolveReady!: (message: DriverMessage) => void;
  private rejectReady!: (error: Error) => void;
  private stdoutBuffer = "";
  private commandSequence = 0;

  constructor(input: {
    readonly harness: ProductionDirectDaemonTestHarness;
    readonly token: string;
    readonly fingerprint: string;
    readonly pathCanary: string;
    readonly profile: BrowserProfileRecord;
    readonly clientId: string;
    readonly userData: string;
  }) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.child = spawn(electronExecutable, [driverPath], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PASEO_CASE13_AGENT_ID: AGENT_ID,
        PASEO_CASE13_BROWSER_ID: BROWSER_ID,
        PASEO_CASE13_BROWSER_PROFILE_ID: input.profile.browserProfileId,
        PASEO_CASE13_CLIENT_ID: input.clientId,
        PASEO_CASE13_FINGERPRINT: input.fingerprint,
        PASEO_CASE13_NODE_ID: NODE_ID,
        PASEO_CASE13_ORGANIZATION_ID: ORGANIZATION_ID,
        PASEO_CASE13_PARTITION: input.profile.partitionKey,
        PASEO_CASE13_PATH_CANARY: input.pathCanary,
        PASEO_CASE13_TOKEN: input.token,
        PASEO_CASE13_USER_DATA: input.userData,
        PASEO_CASE13_WORKSPACE_ID: WORKSPACE_ID,
        PASEO_CASE13_WS_URL: input.harness.url,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.captureStdout(chunk.toString()));
    this.child.stderr.on("data", (chunk: Buffer) => this.stderrChunks.push(chunk.toString()));
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => {
      if (code !== 0 && this.pending.size > 0) {
        this.fail(new Error(`Case13 Electron driver exited (${code ?? signal ?? "unknown"}).`));
      }
    });
  }

  async ready(): Promise<DriverMessage> {
    return withTimeout(this.readyPromise, DRIVER_TIMEOUT_MS, "Electron driver ready");
  }

  async command(
    command: string,
    input: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.child.exitCode !== null) throw new Error("Case13 Electron driver already exited.");
    const id = `driver-${++this.commandSequence}`;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify({ id, command, ...input })}\n`);
    return withTimeout(response, DRIVER_TIMEOUT_MS, `Electron driver ${command}`);
  }

  async stats(): Promise<DriverStats> {
    return (await this.command("stats")) as unknown as DriverStats;
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    try {
      await this.command("shutdown");
    } catch {
      this.child.kill("SIGTERM");
    }
    await withTimeout(
      new Promise<void>((resolve) => {
        if (this.child.exitCode !== null) resolve();
        else this.child.once("exit", () => resolve());
      }),
      DRIVER_TIMEOUT_MS,
      "Electron driver shutdown",
    ).catch(() => this.child.kill("SIGKILL"));
  }

  private captureStdout(chunk: string): void {
    this.stdoutChunks.push(chunk);
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.startsWith(DRIVER_PREFIX)) continue;
      let message: DriverMessage;
      try {
        message = JSON.parse(line.slice(DRIVER_PREFIX.length)) as DriverMessage;
      } catch {
        this.fail(new Error("Case13 Electron driver emitted invalid JSON."));
        continue;
      }
      if (message.kind === "event" && message.event === "ready") {
        this.resolveReady(message);
        continue;
      }
      if (message.kind === "fatal") {
        this.fail(new Error(`Case13 Electron driver failed: ${message.error ?? "unknown"}`));
        continue;
      }
      if (message.kind !== "response" || !message.id) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result ?? {});
      else pending.reject(new Error(message.error ?? "Case13 Electron driver command failed."));
    }
  }

  private fail(error: Error): void {
    this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

beforeAll(async () => {
  if (!PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED) return;
  await executeFile("npm", ["run", "build:main", "--workspace=@getpaseo/desktop"], {
    cwd: repositoryRoot,
    timeout: 120_000,
  });
}, 120_000);

const activeDrivers: ElectronPageIdentityDriver[] = [];

afterEach(async () => {
  await Promise.all(activeDrivers.splice(0).map((driver) => driver.close()));
});

describe.runIf(PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED)(
  "production Browser page identity with a real Electron guest",
  () => {
    // oxlint-disable-next-line complexity -- one ordered production lifecycle is the Case13 evidence boundary.
    test("rejects actual Profile mismatch before protected side effects and fences stale identity", async () => {
      const loggerChunks: string[] = [];
      const pathCanary = `case13-${randomBytes(32).toString("base64url")}`;
      let harness: ProductionDirectDaemonTestHarness | undefined;
      let control: ProductionDirectSocket | undefined;
      let token = "";
      let fingerprint = "";
      const authorizationSpy = vi.spyOn(
        ResourceAuthorizationService.prototype,
        "assertBrowserProfile",
      );
      const fileSystemSpy = vi.spyOn(DarwinWorkspaceFileSystem.prototype, "openWorkspaceRoot");
      try {
        harness = await createProductionDirectDaemonTestHarness({
          name: "case13-page-identity",
          serverId: SERVER_ID,
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          principals: [
            {
              principalId: PRINCIPAL_ID,
              grantVersion: GRANT_VERSION,
              grants: [
                {
                  action: "workspace.metadata.read",
                  selector: { kind: "workspace", workspaceIds: [WORKSPACE_ID] },
                },
                {
                  action: "workspace.write",
                  selector: { kind: "workspace", workspaceIds: [WORKSPACE_ID] },
                },
                {
                  action: "browser.profile.manage",
                  selector: { kind: "organization", organizationId: ORGANIZATION_ID },
                },
                {
                  action: "browser.use",
                  selector: { kind: "organization", organizationId: ORGANIZATION_ID },
                },
              ],
            },
          ],
          loggerChunks,
        });
        const issued = await harness.issuePersonalAccessToken(PRINCIPAL_ID);
        token = issued.token;
        fingerprint = createHash("sha256").update(token).digest("hex");
        await harness.start();
        const runtime = harness.runtime;
        const provider = runtime.authorizationRuntimeProvider;
        if (!provider) throw new Error("Expected production authorization provider.");
        provider.owners.registerWorkspace({
          id: WORKSPACE_ID,
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          ownerPrincipalId: PRINCIPAL_ID,
          createdByPrincipalId: PRINCIPAL_ID,
        });
        provider.owners.registerAgent({
          id: AGENT_ID,
          workspaceId: WORKSPACE_ID,
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          ownerPrincipalId: PRINCIPAL_ID,
          createdByPrincipalId: PRINCIPAL_ID,
        });
        const profiles = resolveProductionBrowserProfileRegistry({
          admission: runtime.admission,
          audit: runtime.audit,
          provider,
        });
        if (!profiles) throw new Error("Expected production Browser Profile registry.");
        const profile = await profiles.create({
          organizationId: ORGANIZATION_ID,
          homeNodeId: NODE_ID,
          businessIdentityId: BUSINESS_IDENTITY_ID,
          ownerPrincipalId: PRINCIPAL_ID,
          platform: "generic",
          businessAccountKey: "case13-account",
          label: "Case13 account",
          expectedIdentity: { hostnames: ["localhost"] },
          status: "ready",
        });
        await mkdir(profile.downloadRoot, { recursive: true, mode: 0o700 });

        control = await harness.connectAndHello({
          token,
          clientId: "case13-control",
        });
        expect(
          serverFeature(control.serverInfo, "enterpriseBrowserPageIdentityObservationV1"),
        ).toBe(true);
        expect(
          serverFeature(control.serverInfo, "enterpriseBrowserPageIdentityInvalidationV1"),
        ).toBe(true);
        const bindResponse = await sendControlRequest(control, {
          type: "enterprise.browser.bind_profile.request",
          requestId: "case13-bind",
          workspaceId: WORKSPACE_ID,
          browserProfileId: profile.browserProfileId,
        });
        expect(bindResponse.type).toBe("enterprise.browser.bind_profile.response");
        const bindingRevision = String(bindResponse.payload?.binding?.boundAt ?? "");
        expect(bindingRevision.length).toBeGreaterThan(0);

        const firstDriver = new ElectronPageIdentityDriver({
          harness,
          token,
          fingerprint,
          pathCanary,
          profile,
          clientId: "case13-electron-old",
          userData: path.join(harness.root, "electron-old"),
        });
        activeDrivers.push(firstDriver);
        const firstReady = await firstDriver.ready();
        expect(firstReady.flags).toEqual({ observation: true, invalidation: true });
        const broker = harness.daemon.browserToolsBroker;
        const brokerInternals = broker as unknown as ProductionBrokerInternals;
        const oldHost = await waitForProductionHost(brokerInternals, "case13-electron-old");
        const configuredMismatch = await firstDriver.command("configure", {
          bindingRevision,
          lifecycleGeneration: oldHost.sessionBindingGeneration,
          initialHostname: "127.0.0.1",
        });
        expect(configuredMismatch).toMatchObject({
          executionAllowed: true,
          actualGuestHost: true,
          actualProfileSession: true,
          actualWebContents: true,
        });

        expect(await firstDriver.command("acquire_lease")).toEqual({
          acquired: true,
          resourceKind: "browser_profile",
          mode: "read",
        });
        const handle = runtime.agentContextRegistry.resolve(AGENT_ID);
        if (!handle) throw new Error("Expected production Session-bound Agent handle.");
        expect(handle.context.sessionBindingGeneration).toBe(oldHost.sessionBindingGeneration);
        const executeBrowserTool = registerProductionBrowserToolExecutor({
          broker,
          runtime,
          cwd: harness.root,
        });
        await expect(executeBrowserTool("browser_list_tabs", {})).resolves.toMatchObject({
          structuredContent: { ok: true, result: { command: "list_tabs" } },
        });

        const mismatchBaseline = await captureSideEffects({
          harness,
          control,
          driver: firstDriver,
          authorizationCalls: authorizationSpy.mock.calls.length,
          fileSystemCalls: fileSystemSpy.mock.calls.length,
        });
        const mismatchContent = await sendControlRequest(
          control,
          contentReadRequest(profile, "case13-content-mismatch"),
        );
        expect(mismatchContent).toMatchObject({
          type: "rpc_error",
          payload: { requestId: "case13-content-mismatch", code: "unavailable" },
        });
        await expect(
          executeBrowserTool("browser_click", { browserId: BROWSER_ID, ref: "@e1" }),
        ).resolves.toMatchObject({
          structuredContent: { ok: false, error: { code: "browser_denied" } },
        });
        await expectSideEffectsUnchanged(mismatchBaseline, {
          harness,
          control,
          driver: firstDriver,
          authorizationCalls: authorizationSpy.mock.calls.length,
          fileSystemCalls: fileSystemSpy.mock.calls.length,
        });

        const matchNavigation = await firstDriver.command("navigate_match");
        expect(matchNavigation).toEqual({
          executionAllowedAtStart: false,
          executionAllowedAfterCommit: true,
        });
        const beforeAllowedEvents = (await runtime.audit.snapshotEvents()).length;
        const matchedContent = await sendControlRequest(
          control,
          contentReadRequest(profile, "case13-content-match"),
        );
        if (matchedContent.type !== "enterprise.browser_profile.content.read.response") {
          const fileSystemResults = await Promise.all(
            fileSystemSpy.mock.results.map(async (result) => {
              try {
                await result.value;
                return { type: result.type, outcome: "fulfilled" };
              } catch (error) {
                const record = error as { code?: unknown; message?: unknown; name?: unknown };
                return {
                  type: result.type,
                  outcome: "rejected",
                  name: String(record.name ?? "Error"),
                  code: String(record.code ?? "unknown"),
                  message: String(record.message ?? "unknown")
                    .split(token)
                    .join("[redacted-token]")
                    .split(fingerprint)
                    .join("[redacted-fingerprint]")
                    .split(pathCanary)
                    .join("[redacted-path]")
                    .split(harness.root)
                    .join("[run-root]"),
                };
              }
            }),
          );
          throw new Error(
            `Case13 matched content read failed: ${JSON.stringify({
              response: matchedContent,
              authorizationCalls: authorizationSpy.mock.calls.length,
              fileSystemCalls: fileSystemSpy.mock.calls.length,
              fileSystemResults,
              auditEventsDelta: (await runtime.audit.snapshotEvents()).length - beforeAllowedEvents,
              driverStats: await firstDriver.stats(),
            })}`,
          );
        }
        expect(matchedContent).toMatchObject({
          type: "enterprise.browser_profile.content.read.response",
          payload: {
            requestId: "case13-content-match",
            page: { items: [{ kind: "state", status: "ready" }] },
          },
        });
        expect(authorizationSpy.mock.calls.length).toBeGreaterThan(
          mismatchBaseline.authorizationCalls,
        );
        expect(fileSystemSpy.mock.calls.length).toBeGreaterThan(mismatchBaseline.fileSystemCalls);
        expect((await runtime.audit.snapshotEvents()).length).toBe(beforeAllowedEvents + 1);
        await expect(
          executeBrowserTool("browser_click", { browserId: BROWSER_ID, ref: "@e1" }),
        ).resolves.toMatchObject({
          structuredContent: {
            ok: true,
            result: { command: "click", browserId: BROWSER_ID, ref: "@e1" },
          },
        });

        const navigationBaseline = await captureSideEffects({
          harness,
          control,
          driver: firstDriver,
          authorizationCalls: authorizationSpy.mock.calls.length,
          fileSystemCalls: fileSystemSpy.mock.calls.length,
        });
        const mismatchNavigation = await firstDriver.command("navigate_mismatch");
        expect(mismatchNavigation).toEqual({
          executionAllowedAtStart: false,
          executionAllowedAfterCommit: true,
        });
        await expect(
          executeBrowserTool("browser_click", { browserId: BROWSER_ID, ref: "@e1" }),
        ).resolves.toMatchObject({
          structuredContent: { ok: false, error: { code: "browser_denied" } },
        });
        await expectSideEffectsUnchanged(navigationBaseline, {
          harness,
          control,
          driver: firstDriver,
          authorizationCalls: authorizationSpy.mock.calls.length,
          fileSystemCalls: fileSystemSpy.mock.calls.length,
        });

        await firstDriver.command("navigate_match");
        const rebound = await firstDriver.command("rebind");
        expect(rebound).toEqual({
          oldExecutionCurrent: false,
          executionAllowed: true,
          actualGuestHost: true,
          actualProfileSession: true,
        });
        const rebindClickBaseline = await captureSideEffects({
          harness,
          control,
          driver: firstDriver,
          authorizationCalls: authorizationSpy.mock.calls.length,
          fileSystemCalls: fileSystemSpy.mock.calls.length,
        });
        await expect(
          executeBrowserTool("browser_click", { browserId: BROWSER_ID, ref: "@e1" }),
        ).resolves.toMatchObject({
          structuredContent: {
            ok: true,
            result: { command: "click", browserId: BROWSER_ID, ref: "@e1" },
          },
        });
        const rebindClickStats = await firstDriver.stats();
        expect(rebindClickStats.automationRequestCount).toBe(
          rebindClickBaseline.driverAutomationRequests + 1,
        );
        expect(authorizationSpy.mock.calls.length).toBeGreaterThan(
          rebindClickBaseline.authorizationCalls,
        );

        const invalidateBaseline = await captureSideEffects({
          harness,
          control,
          driver: firstDriver,
          authorizationCalls: authorizationSpy.mock.calls.length,
          fileSystemCalls: fileSystemSpy.mock.calls.length,
        });
        expect(await firstDriver.command("invalidate")).toEqual({ executionAllowed: false });
        await expect(
          executeBrowserTool("browser_click", { browserId: BROWSER_ID, ref: "@e1" }),
        ).resolves.toMatchObject({
          structuredContent: { ok: false, error: { code: "browser_denied" } },
        });
        await expectSideEffectsUnchanged(invalidateBaseline, {
          harness,
          control,
          driver: firstDriver,
          authorizationCalls: authorizationSpy.mock.calls.length,
          fileSystemCalls: fileSystemSpy.mock.calls.length,
        });

        const firstStats = await firstDriver.stats();
        expect(firstStats.leakCount).toBe(0);
        await firstDriver.close();
        activeDrivers.splice(activeDrivers.indexOf(firstDriver), 1);
        await waitFor(() => broker.getRegisteredClientCount() === 0);
        const secondDriver = new ElectronPageIdentityDriver({
          harness,
          token,
          fingerprint,
          pathCanary,
          profile,
          clientId: "case13-electron-new",
          userData: path.join(harness.root, "electron-new"),
        });
        activeDrivers.push(secondDriver);
        await secondDriver.ready();
        const newHost = await waitForProductionHost(brokerInternals, "case13-electron-new");
        const oldGenerationBaseline = await captureSideEffects({
          harness,
          control,
          driver: secondDriver,
          authorizationCalls: authorizationSpy.mock.calls.length,
          fileSystemCalls: fileSystemSpy.mock.calls.length,
        });
        await expect(
          secondDriver.command("configure", {
            bindingRevision,
            lifecycleGeneration: oldHost.sessionBindingGeneration,
            initialHostname: "localhost",
          }),
        ).rejects.toThrow(/page identity transport rejected the revision/i);
        await expectSideEffectsUnchanged(oldGenerationBaseline, {
          harness,
          control,
          driver: secondDriver,
          authorizationCalls: authorizationSpy.mock.calls.length,
          fileSystemCalls: fileSystemSpy.mock.calls.length,
        });
        expect(await secondDriver.command("acquire_lease")).toEqual({
          acquired: true,
          resourceKind: "browser_profile",
          mode: "read",
        });
        const currentHandle = runtime.agentContextRegistry.resolve(AGENT_ID);
        if (!currentHandle) throw new Error("Expected rebound production Agent handle.");
        expect(currentHandle.context.sessionBindingGeneration).toBe(
          newHost.sessionBindingGeneration,
        );
        expect(currentHandle.context.sessionBindingGeneration).not.toBe(
          oldHost.sessionBindingGeneration,
        );
        const oldGenerationClickBaseline = await captureSideEffects({
          harness,
          control,
          driver: secondDriver,
          authorizationCalls: authorizationSpy.mock.calls.length,
          fileSystemCalls: fileSystemSpy.mock.calls.length,
        });
        await expect(
          executeBrowserTool("browser_click", { browserId: BROWSER_ID, ref: "@e1" }),
        ).resolves.toMatchObject({
          structuredContent: { ok: false, error: { code: "browser_denied" } },
        });
        await expectSideEffectsUnchanged(oldGenerationClickBaseline, {
          harness,
          control,
          driver: secondDriver,
          authorizationCalls: authorizationSpy.mock.calls.length,
          fileSystemCalls: fileSystemSpy.mock.calls.length,
        });
        const secondStats = await secondDriver.stats();
        expect(secondStats.authorityTeardownCount).toBe(1);
        expect(secondStats.publisherErrorCount).toBeGreaterThan(0);
        expect(secondStats.leakCount).toBe(0);

        await secondDriver.close();
        activeDrivers.splice(activeDrivers.indexOf(secondDriver), 1);
        control.socket.close();
        const auditEvents = await runtime.audit.snapshotEvents();
        await harness.stop();
        assertCanariesAbsent("logger", loggerChunks.join(""), token, fingerprint, pathCanary);
        assertCanariesAbsent(
          "control server_info/outbound",
          control.outboundFrames.join(""),
          token,
          fingerprint,
          pathCanary,
        );
        assertCanariesAbsent(
          "Electron stdout/stderr",
          [
            ...firstDriver.stdoutChunks,
            ...firstDriver.stderrChunks,
            ...secondDriver.stdoutChunks,
            ...secondDriver.stderrChunks,
          ].join(""),
          token,
          fingerprint,
          pathCanary,
        );
        assertCanariesAbsent(
          "audit events",
          JSON.stringify(auditEvents),
          token,
          fingerprint,
          pathCanary,
        );
        const persistedFiles = await filesUnder(harness.paseoHome);
        for (const file of persistedFiles) {
          assertCanariesAbsent(
            `paseoHome ${path.relative(harness.paseoHome, file)}`,
            (await readFile(file)).toString("utf8"),
            token,
            fingerprint,
            pathCanary,
          );
        }
        const credentials = JSON.parse(
          await readFile(path.join(harness.paseoHome, "enterprise", "credentials.json"), "utf8"),
        ) as { credentials: Record<string, Record<string, unknown>> };
        expect(credentials.credentials[issued.credentialId]).toMatchObject({
          credentialId: issued.credentialId,
          principalId: PRINCIPAL_ID,
          organizationId: ORGANIZATION_ID,
          secretHash: expect.stringMatching(/^\$2[aby]\$12\$/),
        });
        const artifact = JSON.stringify({
          case: 13,
          canaries: {
            tokenLength: token.length,
            fingerprintAlgorithm: "sha256",
            fingerprintLength: fingerprint.length,
            fingerprintIdentifier: "runtime-only",
            pathLength: pathCanary.length,
          },
          counts: {
            auditEvents: auditEvents.length,
            controlOutboundFrames: control.outboundFrames.length,
            persistedFiles: persistedFiles.length,
            electronOutboundFrames: firstStats.outboundFrameCount + secondStats.outboundFrameCount,
          },
          evidence: {
            actualGuestHost: true,
            actualProfileSession: true,
            mismatchRejected: true,
            matchSucceeded: true,
            navigationInvalidated: true,
            rebindInvalidated: true,
            oldGenerationRejected: true,
          },
        });
        assertCanariesAbsent("artifact", artifact, token, fingerprint, pathCanary);
      } finally {
        authorizationSpy.mockRestore();
        fileSystemSpy.mockRestore();
        control?.socket.close();
        await Promise.all(activeDrivers.splice(0).map((driver) => driver.close()));
        await harness?.close();
      }
    }, 120_000);
  },
);

function serverFeature(info: ProductionDirectWsEnvelope, feature: string): boolean {
  return info.message?.payload?.features instanceof Object
    ? (info.message.payload.features as Record<string, unknown>)[feature] === true
    : false;
}

function parseFrame(frame: string): { type?: string; message?: Record<string, unknown> } | null {
  try {
    return JSON.parse(frame) as { type?: string; message?: Record<string, unknown> };
  } catch {
    return null;
  }
}

async function sendControlRequest(
  control: ProductionDirectSocket,
  message: Record<string, unknown>,
): Promise<{ type?: string; payload?: Record<string, unknown> }> {
  const requestId = String(message.requestId);
  control.socket.send(JSON.stringify({ type: "session", message }));
  return waitForValue(() => {
    for (const frame of control.outboundFrames) {
      const candidate = parseFrame(frame)?.message;
      const payload = candidate?.payload as Record<string, unknown> | undefined;
      if (payload?.requestId === requestId) {
        return candidate as { type?: string; payload?: Record<string, unknown> };
      }
    }
    return null;
  }, `control response ${requestId}`);
}

function contentReadRequest(
  profile: BrowserProfileRecord,
  requestId: string,
): Record<string, unknown> {
  return {
    type: "enterprise.browser_profile.content.read.request",
    requestId,
    resource: {
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      resourceKind: "browser_profile",
      localResourceId: profile.browserProfileId,
    },
    selector: { kind: "browser_profile", view: "state" },
    page: { limit: 10 },
  };
}

async function waitForProductionHost(
  internals: ProductionBrokerInternals,
  clientId: string,
): Promise<AuthenticatedBrowserHostSession> {
  return waitForValue(() => {
    for (const host of internals.clients.values()) {
      if (host.authenticatedSession?.clientId === clientId) return host.authenticatedSession;
    }
    return null;
  }, `production Browser host ${clientId}`);
}

function registerProductionBrowserToolExecutor(input: {
  readonly broker: BrowserToolsBroker;
  readonly runtime: EnterpriseAdmissionRuntime;
  readonly cwd: string;
}): (name: string, toolInput: unknown) => Promise<PaseoToolResult> {
  const tools = new Map<string, RegisteredBrowserTool>();
  registerBrowserTools({
    registerTool: (name, config, handler) => tools.set(name, { config, handler }),
    broker: input.broker,
    callerAgentId: AGENT_ID,
    resolveCallerAgent: () => ({
      id: AGENT_ID,
      cwd: input.cwd,
      workspaceId: WORKSPACE_ID,
    }),
    resolveEnterpriseBrowserContext: () => {
      const handle = input.runtime.agentContextRegistry.resolve(AGENT_ID);
      return handle ? { handle } : null;
    },
  });
  return async (name, toolInput) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Expected registered production Browser tool ${name}.`);
    const parsed = browserToolSchema(tool.config.inputSchema).parse(toolInput);
    return tool.handler(parsed, {});
  };
}

function browserToolSchema(inputSchema: PaseoToolConfig["inputSchema"]): z.ZodType {
  if (!inputSchema) return z.object({}).passthrough();
  if (typeof (inputSchema as { safeParse?: unknown }).safeParse === "function") {
    return inputSchema as z.ZodType;
  }
  return z.object(inputSchema as z.ZodRawShape).passthrough();
}

interface SideEffects {
  readonly authorizationCalls: number;
  readonly fileSystemCalls: number;
  readonly auditEvents: string;
  readonly leaseGeneration: string;
  readonly controlProtectedFrames: number;
  readonly driverProtectedFrames: number;
  readonly driverAutomationRequests: number;
  readonly brokerPendingRequests: number;
}

async function captureSideEffects(input: {
  readonly harness: ProductionDirectDaemonTestHarness;
  readonly control: ProductionDirectSocket;
  readonly driver: ElectronPageIdentityDriver;
  readonly authorizationCalls: number;
  readonly fileSystemCalls: number;
}): Promise<SideEffects> {
  const driverStats = await input.driver.stats();
  return {
    authorizationCalls: input.authorizationCalls,
    fileSystemCalls: input.fileSystemCalls,
    auditEvents: JSON.stringify(await input.harness.runtime.audit.snapshotEvents()),
    leaseGeneration: await readFile(
      path.join(input.harness.paseoHome, "enterprise", "browser", "lease-generation.json"),
      "utf8",
    ),
    controlProtectedFrames: input.control.outboundFrames.filter((frame) =>
      frame.includes("enterprise.browser_profile.content.read.response"),
    ).length,
    driverProtectedFrames: driverStats.protectedOutboundCount,
    driverAutomationRequests: driverStats.automationRequestCount,
    brokerPendingRequests: input.harness.daemon.browserToolsBroker.getPendingRequestCount(),
  };
}

async function expectSideEffectsUnchanged(
  before: SideEffects,
  input: Parameters<typeof captureSideEffects>[0],
): Promise<void> {
  expect(await captureSideEffects(input)).toEqual(before);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  await waitForValue(() => (predicate() ? true : null), "condition");
}

async function waitForValue<T>(read: () => T | null, label: string): Promise<T> {
  const deadline = Date.now() + DRIVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(`${label} timed out.`);
    }),
  ]);
}

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

function assertCanariesAbsent(
  label: string,
  serialized: string,
  token: string,
  fingerprint: string,
  pathCanary: string,
): void {
  expect(serialized, `${label} leaked PAT`).not.toContain(token);
  expect(serialized, `${label} leaked fingerprint`).not.toContain(fingerprint);
  expect(serialized, `${label} leaked path`).not.toContain(pathCanary);
}
