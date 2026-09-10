import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hash } from "bcryptjs";
import pino from "pino";

import { MockLoadTestAgentClient } from "../../src/server/agent/providers/mock-load-test-agent.js";
import { createPaseoDaemon, type PaseoDaemon } from "../../src/server/bootstrap.js";
import { productionAuditCapabilityIssuer } from "../../src/server/enterprise/audit/production-audit-runtime.js";
import { EnterpriseAdmission } from "../../src/server/enterprise/identity/admission.js";
import { createProductionEnterpriseRuntimeFactory } from "../../src/server/enterprise/production-runtime-factory.js";

import { CASE20_PART_A_CLIENT_COUNT, type Case20Mode } from "./model.js";
import type { Case20AuditVerification, Case20PartAClientFixture } from "./part-a-fixture.js";
import { assertFileContainsNoSecrets } from "./secret-scan.js";

const ORGANIZATION_ID = "org_20ca5e0000000000";
const NODE_ID = "nod_20ca5e0000000000";
const SERVER_ID = "srv_20ca5e000001";

interface StartedDaemon {
  readonly daemon: PaseoDaemon;
  readonly root: string;
  readonly paseoHome: string;
  readonly clients: readonly Case20PartAClientFixture[];
  readonly daemonPasswordPlaintext: string;
  readonly destination: ReturnType<typeof pino.destination>;
  readonly logger: pino.Logger;
}

interface StartState {
  root: string | null;
  paseoHome: string | null;
  daemon: PaseoDaemon | null;
  destination: ReturnType<typeof pino.destination> | null;
  logger: pino.Logger | null;
  readonly knownSecrets: string[];
}

function suffix(index: number): string {
  return index.toString(16).padStart(16, "0");
}

function agentId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

async function seedAuthority(paseoHome: string, workspacesRoot: string): Promise<void> {
  const now = new Date().toISOString();
  const principals: Record<string, unknown> = {};
  const grants: Record<string, unknown> = {};
  const projects: unknown[] = [];
  const workspaces: unknown[] = [];
  for (let index = 1; index <= CASE20_PART_A_CLIENT_COUNT; index += 1) {
    const principalId = `usr_${suffix(index)}`;
    const workspaceId = `wks_case20_${index.toString().padStart(2, "0")}`;
    const projectId = `project-case20-${index.toString().padStart(2, "0")}`;
    const workspaceInput = path.join(workspacesRoot, workspaceId);
    await mkdir(workspaceInput, { recursive: true, mode: 0o700 });
    const cwd = await realpath(workspaceInput);
    principals[principalId] = {
      principalId,
      organizationId: ORGANIZATION_ID,
      principalType: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    grants[principalId] = {
      principalId,
      organizationId: ORGANIZATION_ID,
      grants: [
        {
          action: "workspace.metadata.read",
          selector: { kind: "workspace", workspaceIds: [workspaceId] },
        },
        {
          action: "workspace.content.read",
          selector: { kind: "workspace", workspaceIds: [workspaceId] },
        },
        {
          action: "workspace.write",
          selector: { kind: "workspace", workspaceIds: [workspaceId] },
        },
      ],
      grantVersion: `grv_case20_${index}`,
    };
    projects.push({
      projectId,
      rootPath: cwd,
      kind: "non_git",
      displayName: `Case20 ${index}`,
      projectKey: null,
      customName: null,
      customIconRevision: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    workspaces.push({
      workspaceId,
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      ownerPrincipalId: principalId,
      createdByPrincipalId: principalId,
      projectId,
      cwd,
      kind: "directory",
      displayName: `Case20 ${index}`,
      title: null,
      branch: null,
      worktreeRoot: null,
      baseBranch: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
  }
  await Promise.all([
    writeFile(
      path.join(paseoHome, "enterprise", "principals.json"),
      `${JSON.stringify({ version: 1, principals })}\n`,
      { mode: 0o600 },
    ),
    writeFile(path.join(paseoHome, "enterprise", "grants.json"), `${JSON.stringify(grants)}\n`, {
      mode: 0o600,
    }),
    writeFile(
      path.join(paseoHome, "enterprise", "credentials.json"),
      `${JSON.stringify({ version: 1, credentials: {} })}\n`,
      { mode: 0o600 },
    ),
    writeFile(path.join(paseoHome, "projects", "projects.json"), `${JSON.stringify(projects)}\n`, {
      mode: 0o600,
    }),
    writeFile(
      path.join(paseoHome, "projects", "workspaces.json"),
      `${JSON.stringify(workspaces)}\n`,
      { mode: 0o600 },
    ),
    writeFile(path.join(paseoHome, "server-id"), `${SERVER_ID}\n`, { mode: 0o600 }),
  ]);
}

async function listRegularFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile()) files.push(filePath);
      else if (entry.isSymbolicLink())
        throw new Error(`Case20 daemon evidence contains a symbolic link: ${filePath}`);
    }
  };
  if ((await stat(root).catch(() => null))?.isDirectory()) await visit(root);
  return files;
}

async function scanAndVerify(
  started: StartedDaemon,
  daemonLogPath: string,
): Promise<Case20AuditVerification> {
  started.logger.flush();
  started.destination.flushSync();
  const verifier = await productionAuditCapabilityIssuer.issue({
    node: { nodeId: NODE_ID, paseoServerId: SERVER_ID, mode: "standalone" },
    auditRoot: path.join(started.paseoHome, "enterprise", "audit"),
  });
  await verifier.close();
  const homeFiles = await listRegularFiles(started.paseoHome);
  const paths = [...homeFiles, daemonLogPath];
  const knownSecrets = [
    started.daemonPasswordPlaintext,
    ...started.clients.map((client) => client.personalAccessToken),
  ];
  for (const filePath of paths) await assertFileContainsNoSecrets({ filePath, knownSecrets });
  const auditFiles = homeFiles.filter((filePath) =>
    filePath.includes(`${path.sep}audit${path.sep}`),
  ).length;
  if (auditFiles === 0) throw new Error("Case20 production audit chain has no persisted files");
  return {
    restored: true,
    filesScanned: paths.length,
    auditFiles,
  };
}

// oxlint-disable-next-line complexity -- startup records independent credential, daemon, audit, and cleanup failures.
async function startDaemon(
  daemonLogPath: string,
  mode: Case20Mode,
  state: StartState,
): Promise<StartedDaemon> {
  if (process.platform !== "darwin") throw new Error("Case20 Part A requires Darwin");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paseo-case20-a-daemon-")));
  state.root = root;
  const paseoHome = path.join(root, ".paseo");
  state.paseoHome = paseoHome;
  const staticDir = path.join(root, "static");
  const workspacesRoot = path.join(root, "workspaces");
  await Promise.all([
    mkdir(path.join(paseoHome, "enterprise"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(paseoHome, "projects"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(paseoHome, "agents"), { recursive: true, mode: 0o700 }),
    mkdir(staticDir, { recursive: true, mode: 0o700 }),
    mkdir(workspacesRoot, { recursive: true, mode: 0o700 }),
  ]);
  await seedAuthority(paseoHome, workspacesRoot);
  const daemonPasswordPlaintext = randomBytes(32).toString("base64url");
  state.knownSecrets.push(daemonPasswordPlaintext);
  const daemonPassword = await hash(daemonPasswordPlaintext, 12);
  const audit = await productionAuditCapabilityIssuer.issue({
    node: { nodeId: NODE_ID, paseoServerId: SERVER_ID, mode: "standalone" },
    auditRoot: path.join(paseoHome, "enterprise", "audit"),
  });
  const runtime = await createProductionEnterpriseRuntimeFactory({ paseoHome, daemonPassword })({
    config: {
      enabled: true,
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      managementMode: "standalone",
      legacyRecords: "owner_only",
    },
    audit,
  }).catch(async (error: unknown) => {
    const auditCloseFailure = await audit.close().then(
      () => null,
      (failure: unknown) => failure,
    );
    if (auditCloseFailure !== null)
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the factory error as cause and first member.
      throw new AggregateError(
        [error, auditCloseFailure],
        "Case20 authorization runtime setup cleanup failed",
        { cause: error },
      );
    throw error;
  });
  const clients: Case20PartAClientFixture[] = [];
  let issueFailure: unknown;
  const closeFailures: unknown[] = [];
  try {
    const owner = await runtime.admission.authenticate(daemonPasswordPlaintext, {
      node: runtime.node,
      transport: "direct",
      peer: "loopback",
    });
    if (!owner || !(runtime.admission instanceof EnterpriseAdmission))
      throw new Error("Case20 could not establish production admission");
    for (let index = 1; index <= CASE20_PART_A_CLIENT_COUNT; index += 1) {
      const principalId = `usr_${suffix(index)}`;
      const issued = await runtime.admission.registry.issueToken({
        actor: owner,
        principalId,
        organizationId: ORGANIZATION_ID,
      });
      clients.push({
        clientId: `case20-client-${index.toString().padStart(2, "0")}`,
        principalId,
        personalAccessToken: issued.token,
        agentId: agentId(index),
        streamCanary: `case20-canary-${index.toString().padStart(2, "0")}-${randomBytes(8).toString("hex")}`,
      });
      state.knownSecrets.push(issued.token);
    }
  } catch (error) {
    issueFailure = error;
  } finally {
    const results = await Promise.allSettled([runtime.close?.(), audit.close()]);
    for (const result of results) {
      if (result.status === "rejected") closeFailures.push(result.reason);
    }
  }
  if (issueFailure || closeFailures.length > 0) {
    const failures = [...(issueFailure ? [issueFailure] : []), ...closeFailures];
    throw new AggregateError(failures, "Case20 credential issuance cleanup failed", {
      cause: failures[0],
    });
  }
  await writeFile(daemonLogPath, "", { flag: "wx", mode: 0o600 });
  const destination = pino.destination({ dest: daemonLogPath, sync: false, mkdir: true });
  const logger = pino({ level: "info" }, destination);
  state.destination = destination;
  state.logger = logger;
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: { mock: new MockLoadTestAgentClient(logger) },
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      enterpriseMultiUser: {
        enabled: true,
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        managementMode: "standalone",
        legacyRecords: "owner_only",
      },
    },
    logger,
    {
      createEnterpriseAdmissionRuntime: createProductionEnterpriseRuntimeFactory({
        paseoHome,
        daemonPassword,
      }),
    },
  );
  state.daemon = daemon;
  try {
    await daemon.start();
    for (let index = 0; index < clients.length; index += 1) {
      const client = clients[index];
      if (!client) throw new Error("Case20 fixture client missing");
      const workspaceId = `wks_case20_${(index + 1).toString().padStart(2, "0")}`;
      const cwd = await realpath(path.join(workspacesRoot, workspaceId));
      await daemon.agentManager.createAgent(
        {
          provider: "mock",
          cwd,
          model: mode === "smoke" ? "ten-second-stream" : "thirty-minute-stream",
        },
        client.agentId,
        {
          workspaceId,
          enterpriseOwnership: {
            workspaceId,
            organizationId: ORGANIZATION_ID,
            nodeId: NODE_ID,
            ownerPrincipalId: client.principalId,
            createdByPrincipalId: client.principalId,
          },
        },
      );
    }
    const target = daemon.getListenTarget();
    if (!target || target.type !== "tcp") throw new Error("Case20 daemon has no TCP listener");
    process.send?.({
      type: "ready",
      daemonUrl: `ws://127.0.0.1:${target.port}/ws`,
      daemonPid: process.pid,
      clients,
    });
    return {
      daemon,
      root,
      paseoHome,
      clients,
      daemonPasswordPlaintext,
      destination,
      logger,
    };
  } catch (error) {
    const cleanupFailures: unknown[] = [error];
    await daemon.stop().catch((cleanupError) => cleanupFailures.push(cleanupError));
    logger.flush();
    destination.flushSync();
    try {
      const files = await listRegularFiles(paseoHome);
      const logExists = (await stat(daemonLogPath).catch(() => null))?.isFile() === true;
      const knownSecrets = [
        daemonPasswordPlaintext,
        ...clients.map((client) => client.personalAccessToken),
      ];
      for (const filePath of [...files, ...(logExists ? [daemonLogPath] : [])])
        await assertFileContainsNoSecrets({ filePath, knownSecrets });
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    destination.end();
    await rm(root, { recursive: true, force: true }).catch((cleanupError) =>
      cleanupFailures.push(cleanupError),
    );
    // oxlint-disable-next-line preserve-caught-error -- AggregateError carries the caught error as cause.
    throw new AggregateError(cleanupFailures, "Case20 daemon start failed", {
      cause: error,
    });
  }
}

async function cleanupFailedStart(state: StartState, daemonLogPath: string): Promise<void> {
  const failures: unknown[] = [];
  if (state.daemon) await state.daemon.stop().catch((error) => failures.push(error));
  try {
    state.logger?.flush();
    state.destination?.flushSync();
  } catch (error) {
    failures.push(error);
  }
  try {
    const homeFiles = state.paseoHome ? await listRegularFiles(state.paseoHome) : [];
    const logExists = (await stat(daemonLogPath).catch(() => null))?.isFile() === true;
    for (const filePath of [...homeFiles, ...(logExists ? [daemonLogPath] : [])])
      await assertFileContainsNoSecrets({ filePath, knownSecrets: state.knownSecrets });
  } catch (error) {
    failures.push(error);
  }
  state.destination?.end();
  if (state.root)
    await rm(state.root, { recursive: true, force: true }).catch((error) => failures.push(error));
  if (failures.length > 0)
    throw new AggregateError(failures, "Case20 failed-start cleanup failed", {
      cause: failures[0],
    });
}

async function closeDaemon(
  started: StartedDaemon,
  daemonLogPath: string,
): Promise<Case20AuditVerification> {
  const failures: unknown[] = [];
  let verification: Case20AuditVerification | null = null;
  try {
    await started.daemon.stop();
    await started.daemon.agentManager.flush();
  } catch (error) {
    failures.push(error);
  }
  try {
    verification = await scanAndVerify(started, daemonLogPath);
  } catch (error) {
    failures.push(error);
  } finally {
    started.destination.end();
    await rm(started.root, { recursive: true, force: true }).catch((error) => failures.push(error));
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Case20 daemon cleanup failed", { cause: failures[0] });
  if (!verification) throw new Error("Case20 audit verification missing");
  return verification;
}

async function main(): Promise<void> {
  const daemonLogPath = process.env.CASE20_DAEMON_LOG_PATH;
  const mode = process.env.CASE20_MODE;
  if (!daemonLogPath || (mode !== "formal" && mode !== "smoke"))
    throw new Error("Case20 child environment invalid");
  const state: StartState = {
    root: null,
    paseoHome: null,
    daemon: null,
    destination: null,
    logger: null,
    knownSecrets: [],
  };
  let started: StartedDaemon;
  try {
    started = await startDaemon(daemonLogPath, mode, state);
  } catch (error) {
    const cleanupError = await cleanupFailedStart(state, daemonLogPath).then(
      () => null,
      (failure: unknown) => failure,
    );
    let message = error instanceof Error ? error.message : "unknown";
    if (cleanupError !== null) message = "startup and cleanup evidence failed";
    process.send?.({
      type: "failed",
      phase: "start",
      message,
    });
    process.exitCode = 1;
    return;
  }
  let closing = false;
  const close = (report: boolean) => {
    if (closing) return;
    closing = true;
    void closeDaemon(started, daemonLogPath)
      .then((audit) => {
        if (report) process.send?.({ type: "closed", audit });
        return undefined;
      })
      .catch((error: unknown) => {
        if (report)
          process.send?.({
            type: "failed",
            phase: "close",
            message: error instanceof Error ? error.message : "unknown",
          });
        process.exitCode = 1;
      })
      .finally(() => process.disconnect?.());
  };
  process.once("message", (message: unknown) => {
    if (
      !message ||
      typeof message !== "object" ||
      (message as { readonly type?: unknown }).type !== "shutdown"
    )
      return;
    close(true);
  });
  process.once("disconnect", () => close(false));
  process.once("SIGTERM", () => close(false));
  process.once("SIGINT", () => close(false));
}

void main().catch((error: unknown) => {
  process.send?.({
    type: "failed",
    phase: "start",
    message: error instanceof Error ? error.message : "unknown",
  });
  process.exitCode = 1;
});
