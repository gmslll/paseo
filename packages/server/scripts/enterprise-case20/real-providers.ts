import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Logger } from "pino";

import type {
  AgentClient,
  AgentCreateSessionOptions,
  AgentSessionConfig,
} from "../../src/server/agent/agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../../src/server/agent/provider-launch-config.js";
import { ClaudeAgentClient } from "../../src/server/agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../../src/server/agent/providers/codex-app-server-agent.js";
import type { Case20Provider } from "./provider-preflight.js";
import {
  assertFileContainsNoSecrets,
  readKnownSecretsFromJson,
  readKnownSecretsFromJsonContents,
} from "./secret-scan.js";

const executeFile = promisify(execFile);
const PROVIDER_SOURCE_HOME = os.homedir();
const SYSTEM_ENV_ALLOWLIST = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "USER",
  "LOGNAME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "PASEO_CASE20_CODEX_BINARY",
  "PASEO_CASE20_CLAUDE_BINARY",
]);

interface FileSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly size: number;
  readonly mode: number;
  readonly sha256: string;
}

interface PreparedProviderHome {
  readonly root: string;
  readonly configRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly knownSecrets: readonly string[];
  verifyAndClose(): Promise<void>;
}

export interface Case20ProcessEnvironmentIsolation {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly knownSecrets: readonly string[];
  restore(): void;
}

export function createCase20AllowlistedBaseEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (SYSTEM_ENV_ALLOWLIST.has(key) && value !== undefined) environment[key] = value;
  }
  if (!environment.PATH && process.platform !== "win32")
    environment.PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return environment;
}

export function installCase20ProviderParentEnvironment(
  injectedBeforeIsolation: Readonly<Record<string, string>> = {},
): Case20ProcessEnvironmentIsolation {
  const original = { ...process.env };
  const environment = createCase20AllowlistedBaseEnvironment({
    ...process.env,
    ...injectedBeforeIsolation,
  });
  const knownSecrets = Object.freeze(
    Object.entries({ ...process.env, ...injectedBeforeIsolation })
      .filter(
        ([key, value]) =>
          /(?:TOKEN|KEY|SECRET|PASSWORD|COOKIE|AUTHORIZATION|CREDENTIAL)/i.test(key) &&
          typeof value === "string" &&
          value.length >= 8,
      )
      .map(([, value]) => value as string),
  );
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  let restored = false;
  return {
    environment: Object.freeze({ ...environment }),
    knownSecrets,
    restore() {
      if (restored) return;
      restored = true;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, original);
    },
  };
}

export interface Case20ProviderEnvironment {
  readonly provider: Case20Provider;
  readonly client: AgentClient;
  readonly config: Pick<AgentSessionConfig, "provider" | "model" | "modeId" | "thinkingOptionId">;
  readonly createOptions: AgentCreateSessionOptions;
  readonly knownSecrets: readonly string[];
  verifyAndClose(): Promise<void>;
}

function providerBinary(provider: Case20Provider): string {
  const override = process.env[`PASEO_CASE20_${provider.toUpperCase()}_BINARY`];
  return override && override.length > 0 ? override : provider;
}

function sha256(contents: Uint8Array | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown failure";
}

async function fileSnapshot(filePath: string): Promise<FileSnapshot> {
  const info = await stat(filePath).catch(() => null);
  if (!info) return { path: filePath, exists: false, size: 0, mode: 0, sha256: "absent" };
  if (!info.isFile()) throw new Error(`Case20 provider source is not a regular file: ${filePath}`);
  const contents = await readFile(filePath);
  return {
    path: filePath,
    exists: true,
    size: info.size,
    mode: info.mode & 0o777,
    sha256: sha256(contents),
  };
}

async function assertSnapshotsUnchanged(before: readonly FileSnapshot[]): Promise<void> {
  for (const expected of before) {
    const current = await fileSnapshot(expected.path);
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`Case20 provider changed its original source file: ${expected.path}`);
    }
  }
}

export async function captureCase20ImmutableProviderFiles(
  filePaths: readonly string[],
): Promise<() => Promise<void>> {
  const snapshots = await Promise.all([...new Set(filePaths)].map(fileSnapshot));
  return async () => await assertSnapshotsUnchanged(snapshots);
}

async function regularFiles(root: string): Promise<readonly string[]> {
  const output: string[] = [];
  async function visit(current: string): Promise<void> {
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error(`Case20 generated provider home contains a symbolic link: ${current}`);
    if (info.isFile()) {
      output.push(current);
      return;
    }
    if (!info.isDirectory()) return;
    for (const entry of await readdir(current)) await visit(path.join(current, entry));
  }
  await visit(root);
  return output.sort();
}

async function scanGeneratedProviderHome(
  root: string,
  knownSecrets: readonly string[],
): Promise<void> {
  for (const filePath of await regularFiles(root))
    await assertFileContainsNoSecrets({ filePath, knownSecrets });
}

function sanitizedProcessEnvironment(): NodeJS.ProcessEnv {
  return createCase20AllowlistedBaseEnvironment(process.env);
}

function runtimeSettings(
  binary: string,
  env: Readonly<Record<string, string>>,
): ProviderRuntimeSettings {
  return { command: { mode: "replace", argv: [binary] }, env: { ...env } };
}

function environmentSecrets(prefix: RegExp): readonly string[] {
  return Object.entries(process.env)
    .filter(([key]) => prefix.test(key) && /(?:TOKEN|KEY|SECRET|PASSWORD|COOKIE)/i.test(key))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string" && value.length >= 8);
}

async function copyPrivateFile(source: string, destination: string): Promise<void> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
    throw new Error(`Case20 authentication source is not a regular file: ${source}`);
  await copyFile(source, destination);
  await chmod(destination, 0o600);
}

async function assertPrivateRegularFile(filePath: string): Promise<void> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Case20 authentication copy is not a private regular file: ${filePath}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new Error(`Case20 authentication copy has group or other permissions: ${filePath}`);
}

async function cleanupFailedProviderHome(input: {
  readonly root: string;
  readonly authPath: string;
  readonly knownSecrets: readonly string[];
  readonly verifyOriginals: () => Promise<void>;
}): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  if ((await lstat(input.authPath).catch(() => null)) !== null) {
    try {
      await assertPrivateRegularFile(input.authPath);
    } catch (error) {
      failures.push(error);
    }
    await rm(input.authPath, { force: true }).catch((error) => failures.push(error));
  }
  await scanGeneratedProviderHome(input.root, input.knownSecrets).catch((error) =>
    failures.push(error),
  );
  await input.verifyOriginals().catch((error) => failures.push(error));
  await rm(input.root, { recursive: true, force: true }).catch((error) => failures.push(error));
  return failures;
}

async function prepareCodexHome(
  additionalKnownSecrets: readonly string[],
): Promise<PreparedProviderHome> {
  const originalRoot = path.join(PROVIDER_SOURCE_HOME, ".codex");
  const authSource = path.join(originalRoot, "auth.json");
  const configSource = path.join(originalRoot, "config.toml");
  const verifyOriginals = await captureCase20ImmutableProviderFiles([authSource, configSource]);
  if (!(await fileSnapshot(authSource)).exists)
    throw new Error("Case20 Codex preflight requires ~/.codex/auth.json");
  const knownSecrets = [
    ...(await readKnownSecretsFromJson(authSource)),
    ...environmentSecrets(/(?:OPENAI|CODEX|OPENROUTER)/i),
    ...additionalKnownSecrets,
  ];
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-case20-codex-"));
  const homeRoot = path.join(root, "user-home");
  const configRoot = path.join(root, "codex-home");
  const authPath = path.join(configRoot, "auth.json");
  try {
    await Promise.all([
      mkdir(configRoot, { mode: 0o700 }),
      mkdir(homeRoot, { mode: 0o700 }),
      mkdir(path.join(root, "xdg-config"), { mode: 0o700 }),
      mkdir(path.join(root, "xdg-cache"), { mode: 0o700 }),
      mkdir(path.join(root, "xdg-state"), { mode: 0o700 }),
    ]);
    await copyPrivateFile(authSource, authPath);
    await writeFile(
      path.join(configRoot, "config.toml"),
      [
        'model = "gpt-5.6-sol"',
        'approval_policy = "never"',
        'sandbox_mode = "workspace-write"',
        'web_search = "disabled"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  } catch (error) {
    const cleanupFailures = await cleanupFailedProviderHome({
      root,
      authPath,
      knownSecrets,
      verifyOriginals,
    });
    if (cleanupFailures.length > 0)
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the setup error as its cause and first member.
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Case20 Codex home setup and cleanup failed",
        { cause: error },
      );
    throw error;
  }
  let closed = false;
  return {
    root,
    configRoot,
    env: Object.freeze({
      HOME: homeRoot,
      CODEX_HOME: configRoot,
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_CACHE_HOME: path.join(root, "xdg-cache"),
      XDG_STATE_HOME: path.join(root, "xdg-state"),
    }),
    knownSecrets,
    async verifyAndClose() {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      try {
        await assertPrivateRegularFile(authPath);
        await rm(authPath, { force: true });
        await scanGeneratedProviderHome(root, knownSecrets);
      } catch (error) {
        failures.push(error);
      }
      try {
        await verifyOriginals();
      } catch (error) {
        failures.push(error);
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          `Case20 Codex home verification failed: ${failures.map(errorMessage).join("; ")}`,
          {
            cause: failures[0],
          },
        );
    },
  };
}

async function claudeCredentialContents(): Promise<{
  readonly contents: Buffer;
  readonly verify: () => Promise<void>;
}> {
  const credentialsPath = path.join(PROVIDER_SOURCE_HOME, ".claude", ".credentials.json");
  const credentials = await readFile(credentialsPath).catch(() => null);
  if (credentials) {
    const before = await fileSnapshot(credentialsPath);
    return {
      contents: credentials,
      async verify() {
        await assertSnapshotsUnchanged([before]);
      },
    };
  }
  if (process.platform !== "darwin") {
    throw new Error("Case20 Claude requires isolated environment credentials on this platform");
  }
  const readKeychain = async () => {
    const result = await executeFile("security", [
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ]);
    return Buffer.from(result.stdout.trim());
  };
  const contents = await readKeychain();
  const expected = sha256(contents);
  return {
    contents,
    async verify() {
      if (sha256(await readKeychain()) !== expected)
        throw new Error("Case20 Claude keychain authentication changed during the run");
    },
  };
}

async function prepareClaudeHome(
  additionalKnownSecrets: readonly string[],
): Promise<PreparedProviderHome> {
  const claudeRoot = path.join(PROVIDER_SOURCE_HOME, ".claude");
  const verifyOriginals = await captureCase20ImmutableProviderFiles([
    path.join(PROVIDER_SOURCE_HOME, ".claude.json"),
    path.join(claudeRoot, "settings.json"),
  ]);
  const credentialSource = await claudeCredentialContents();
  const knownSecrets = [
    ...readKnownSecretsFromJsonContents(credentialSource.contents.toString("utf8")),
    ...environmentSecrets(/(?:ANTHROPIC|CLAUDE|OPENROUTER)/i),
    ...additionalKnownSecrets,
  ];
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-case20-claude-"));
  const homeRoot = path.join(root, "user-home");
  const configRoot = path.join(root, "claude-config");
  const authPath = path.join(configRoot, ".credentials.json");
  try {
    await Promise.all([
      mkdir(configRoot, { mode: 0o700 }),
      mkdir(homeRoot, { mode: 0o700 }),
      mkdir(path.join(root, "xdg-config"), { mode: 0o700 }),
      mkdir(path.join(root, "xdg-cache"), { mode: 0o700 }),
      mkdir(path.join(root, "xdg-state"), { mode: 0o700 }),
    ]);
    await writeFile(authPath, credentialSource.contents, { mode: 0o600 });
    await writeFile(
      path.join(configRoot, "settings.json"),
      `${JSON.stringify(
        {
          permissions: { allow: [], ask: [], deny: ["WebFetch(*)", "WebSearch(*)"] },
          sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    const cleanupFailures = await cleanupFailedProviderHome({
      root,
      authPath,
      knownSecrets,
      verifyOriginals: async () =>
        await Promise.all([verifyOriginals(), credentialSource.verify()]).then(() => undefined),
    });
    if (cleanupFailures.length > 0)
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the setup error as its cause and first member.
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Case20 Claude home setup and cleanup failed",
        { cause: error },
      );
    throw error;
  }
  let closed = false;
  return {
    root,
    configRoot,
    env: Object.freeze({
      HOME: homeRoot,
      CLAUDE_CONFIG_DIR: configRoot,
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_CACHE_HOME: path.join(root, "xdg-cache"),
      XDG_STATE_HOME: path.join(root, "xdg-state"),
    }),
    knownSecrets,
    async verifyAndClose() {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      try {
        await assertPrivateRegularFile(authPath);
        await rm(authPath, { force: true });
        await scanGeneratedProviderHome(root, knownSecrets);
      } catch (error) {
        failures.push(error);
      }
      try {
        await Promise.all([verifyOriginals(), credentialSource.verify()]);
      } catch (error) {
        failures.push(error);
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          `Case20 Claude home verification failed: ${failures.map(errorMessage).join("; ")}`,
          { cause: failures[0] },
        );
    },
  };
}

async function prepareProviderHome(
  provider: Case20Provider,
  additionalKnownSecrets: readonly string[] = [],
): Promise<PreparedProviderHome> {
  return provider === "codex"
    ? await prepareCodexHome(additionalKnownSecrets)
    : await prepareClaudeHome(additionalKnownSecrets);
}

async function isolatedAuthStatus(provider: Case20Provider): Promise<boolean> {
  const prepared = await prepareProviderHome(provider);
  try {
    const result = await executeFile(
      providerBinary(provider),
      provider === "codex" ? ["login", "status"] : ["auth", "status", "--json"],
      { timeout: 15_000, env: { ...sanitizedProcessEnvironment(), ...prepared.env } },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    if (provider === "codex") return /logged in/i.test(output);
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
    return parsed.loggedIn === true;
  } catch {
    return false;
  } finally {
    await prepared.verifyAndClose();
  }
}

export async function canRunCase20Provider(provider: Case20Provider): Promise<boolean> {
  return await isolatedAuthStatus(provider);
}

export async function createCase20ProviderEnvironment(
  provider: Case20Provider,
  logger: Logger,
  additionalKnownSecrets: readonly string[] = [],
): Promise<Case20ProviderEnvironment> {
  const prepared = await prepareProviderHome(provider, additionalKnownSecrets);
  try {
    const settings = runtimeSettings(providerBinary(provider), prepared.env);
    return provider === "codex"
      ? {
          provider,
          client: new CodexAppServerAgentClient(logger, settings),
          config: {
            provider,
            model: "gpt-5.6-sol",
            modeId: "auto",
            thinkingOptionId: "low",
          },
          createOptions: { persistSession: false },
          knownSecrets: prepared.knownSecrets,
          verifyAndClose: prepared.verifyAndClose,
        }
      : {
          provider,
          client: new ClaudeAgentClient({
            logger,
            runtimeSettings: settings,
            configDir: prepared.configRoot,
          }),
          config: { provider, model: "haiku", modeId: "acceptEdits" },
          createOptions: { persistSession: false },
          knownSecrets: prepared.knownSecrets,
          verifyAndClose: prepared.verifyAndClose,
        };
  } catch (error) {
    const cleanupError = await prepared.verifyAndClose().then(
      () => null,
      (failure: unknown) => failure,
    );
    if (cleanupError === null) throw error;
    // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the creation error as its cause and first member.
    throw new AggregateError(
      [error, cleanupError],
      `Case20 ${provider} environment creation and cleanup failed`,
      { cause: error },
    );
  }
}

export function getCase20RealProviderConfig(
  provider: Case20Provider,
): Pick<AgentSessionConfig, "provider" | "model" | "modeId" | "thinkingOptionId"> {
  return provider === "codex"
    ? { provider, model: "gpt-5.6-sol", modeId: "auto", thinkingOptionId: "low" }
    : { provider, model: "haiku", modeId: "acceptEdits" };
}
