import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { statSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type {
  AuditEvent,
  AuditEventInput,
  AuditAppendOptions,
  PrincipalContext,
} from "@getpaseo/protocol/messages";
import {
  CredentialInvalidationCommittedError,
  formatPersonalAccessToken,
  IdentityRegistry,
  IdentityRegistryPoisonedError,
  IdentityRegistryStorageUnsupportedError,
  parsePersonalAccessToken,
  type CredentialInvalidation,
  type IdentityAuditSink,
  type PrincipalGrantProjection,
  type PrincipalGrantSource,
} from "./registry.js";
import {
  type IdentityRegistryFsPort,
  type IdentityRegistryFsStat,
  nodeIdentityRegistryFs,
} from "./fs-port.js";

const principal: PrincipalContext = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  grants: [],
  credentialId: "source",
  grantVersion: "1",
};
const source = {
  resolvePrincipal: async (): Promise<PrincipalGrantProjection> => {
    const { credentialId: _credentialId, ...projection } = principal;
    return projection;
  },
};
const actor = principal;
const invalidation = { publish: async () => {} };
const node = { nodeId: "nod_0123456789abcdef", paseoServerId: "srv", mode: "standalone" as const };
function memoryAudit() {
  const events: AuditEvent[] = [];
  const sink: IdentityAuditSink = {
    append: async (input: AuditEventInput, _options: AuditAppendOptions): Promise<AuditEvent> => {
      const event = {
        ...input,
        eventId: `evt_${events.length + 1}`,
        occurredAt: new Date().toISOString(),
        nodeId: node.nodeId,
        nodeEventSeq: events.length,
        eventHash: `hash_${events.length + 1}`,
      } as AuditEvent;
      events.push(event);
      return event;
    },
  };
  return { sink, events };
}

type FsOperation =
  | "mkdir"
  | "open"
  | "close"
  | "read"
  | "write"
  | "fstat"
  | "fchmod"
  | "fsync"
  | "rename"
  | "unlink";

interface FsCall {
  operation: FsOperation;
  path?: string;
  from?: string;
  to?: string;
  fd?: number;
  flags?: number;
}

interface FsFault {
  operation: FsOperation;
  occurrence: number;
  seen: number;
  error: Error;
  matches?: (call: FsCall) => boolean;
}

class FaultFs implements IdentityRegistryFsPort {
  readonly calls: FsCall[] = [];
  readonly noFollowFlag: number;
  private readonly delegate: IdentityRegistryFsPort;
  private readonly pathsByFd = new Map<number, string>();
  private readonly modesByFd = new Map<number, number>();
  private readonly faults: FsFault[] = [];

  constructor(options?: { noFollowFlag?: number; delegate?: IdentityRegistryFsPort }) {
    this.delegate = options?.delegate ?? nodeIdentityRegistryFs;
    this.noFollowFlag = options?.noFollowFlag ?? (this.delegate.noFollowFlag || 0x40000000);
  }

  fail(
    operation: FsOperation,
    error: Error,
    options?: { occurrence?: number; matches?: (call: FsCall) => boolean },
  ): void {
    this.faults.push({
      operation,
      occurrence: options?.occurrence ?? 1,
      seen: 0,
      error,
      matches: options?.matches,
    });
  }

  count(operation: FsOperation, matches?: (call: FsCall) => boolean): number {
    return this.calls.filter(
      (call) => call.operation === operation && (matches === undefined || matches(call)),
    ).length;
  }

  private visit(call: FsCall): void {
    this.calls.push(call);
    for (let index = 0; index < this.faults.length; index++) {
      const fault = this.faults[index]!;
      if (fault.operation !== call.operation || (fault.matches && !fault.matches(call))) continue;
      fault.seen += 1;
      if (fault.seen !== fault.occurrence) continue;
      this.faults.splice(index, 1);
      throw fault.error;
    }
  }

  mkdir(filePath: string, mode: number): void {
    this.visit({ operation: "mkdir", path: filePath });
    this.delegate.mkdir(filePath, mode);
  }

  open(filePath: string, flags: number, mode?: number): number {
    this.visit({ operation: "open", path: filePath, flags });
    const synthetic = this.delegate.noFollowFlag === 0 && this.noFollowFlag !== 0;
    const delegateFlags = synthetic ? flags & ~this.noFollowFlag : flags;
    const fd = this.delegate.open(filePath, delegateFlags, mode);
    this.pathsByFd.set(fd, filePath);
    return fd;
  }

  close(fd: number): void {
    this.visit({ operation: "close", fd, path: this.pathsByFd.get(fd) });
    this.delegate.close(fd);
    this.pathsByFd.delete(fd);
    this.modesByFd.delete(fd);
  }

  read(fd: number): string {
    this.visit({ operation: "read", fd, path: this.pathsByFd.get(fd) });
    return this.delegate.read(fd);
  }

  write(fd: number, data: string): void {
    this.visit({ operation: "write", fd, path: this.pathsByFd.get(fd) });
    this.delegate.write(fd, data);
  }

  fstat(fd: number): IdentityRegistryFsStat {
    this.visit({ operation: "fstat", fd, path: this.pathsByFd.get(fd) });
    const statValue = this.delegate.fstat(fd);
    const mode = this.modesByFd.get(fd);
    if (mode === undefined) return statValue;
    return Object.assign(Object.create(statValue), {
      mode: (statValue.mode & ~0o777) | mode,
    });
  }

  fchmod(fd: number, mode: number): void {
    this.visit({ operation: "fchmod", fd, path: this.pathsByFd.get(fd) });
    this.modesByFd.set(fd, mode);
    try {
      this.delegate.fchmod(fd, mode);
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM")
        throw error;
    }
  }

  fsync(fd: number): void {
    this.visit({ operation: "fsync", fd, path: this.pathsByFd.get(fd) });
    try {
      this.delegate.fsync(fd);
    } catch (error) {
      const filePath = this.pathsByFd.get(fd);
      if (
        process.platform !== "win32" ||
        !filePath ||
        (error as NodeJS.ErrnoException).code !== "EPERM" ||
        !statSync(filePath).isDirectory()
      )
        throw error;
    }
  }

  rename(from: string, to: string): void {
    this.visit({ operation: "rename", from, to });
    this.delegate.rename(from, to);
  }

  unlink(filePath: string): void {
    this.visit({ operation: "unlink", path: filePath });
    this.delegate.unlink(filePath);
  }
}

const TEST_NOW = "2026-09-10T00:00:00.000Z";
const TEST_SECRETS = [1, 2, 3, 4].map((value) => Buffer.alloc(32, value).toString("base64url"));
const TEST_CREDENTIAL_IDS = [1, 2, 3, 4].map(
  (value) => `cred_${value.toString(16).padStart(24, "0")}`,
);

function testDigest(secret: string): string {
  return `$2b$12$${Buffer.from(secret).toString("hex").slice(0, 53)}`;
}

function sequenceSource(values: readonly string[]): { next(): string } {
  let index = 0;
  return {
    next(): string {
      const value = values[index];
      if (value === undefined) throw new Error("Test sequence exhausted");
      index += 1;
      return value;
    },
  };
}

function memoryInvalidation() {
  const events: CredentialInvalidation[] = [];
  return {
    events,
    sink: {
      publish: async (event: CredentialInvalidation): Promise<void> => {
        events.push(event);
      },
    },
  };
}

function createTestRegistry(input: {
  filePath: string;
  fs?: IdentityRegistryFsPort;
  audit?: ReturnType<typeof memoryAudit>;
  invalidation?: ReturnType<typeof memoryInvalidation>;
  credentialIds?: readonly string[];
  secrets?: readonly string[];
  principalSource?: PrincipalGrantSource;
  clock?: { now(): string };
  hasher?: { hash(secret: string): Promise<string> };
}): {
  registry: IdentityRegistry;
  audit: ReturnType<typeof memoryAudit>;
  invalidation: ReturnType<typeof memoryInvalidation>;
} {
  const audit = input.audit ?? memoryAudit();
  const invalidationRecorder = input.invalidation ?? memoryInvalidation();
  return {
    registry: new IdentityRegistry({
      filePath: input.filePath,
      principalSource: input.principalSource ?? source,
      node,
      audit: audit.sink,
      invalidation: invalidationRecorder.sink,
      fs: input.fs,
      clock: input.clock ?? { now: () => TEST_NOW },
      credentialIds: sequenceSource(input.credentialIds ?? TEST_CREDENTIAL_IDS),
      secrets: sequenceSource(input.secrets ?? TEST_SECRETS),
      hasher: input.hasher ?? { hash: async (secret) => testDigest(secret) },
      verifier: { compare: async (secret, digest) => digest === testDigest(secret) },
    }),
    audit,
    invalidation: invalidationRecorder,
  };
}

function isTemporaryPath(call: FsCall, filePath: string): boolean {
  const candidate = call.path ?? call.from;
  return candidate?.startsWith(`${filePath}.`) === true && candidate.endsWith(".tmp");
}

function isParentPath(call: FsCall, filePath: string): boolean {
  return call.path === path.dirname(filePath);
}

async function expectPoisonedPublicEntries(
  registry: IdentityRegistry,
  token: string,
  credentialId: string,
): Promise<void> {
  await expect(registry.load()).rejects.toBeInstanceOf(IdentityRegistryPoisonedError);
  await expect(registry.authenticate(token, node)).resolves.toBeNull();
  await expect(
    registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    }),
  ).rejects.toBeInstanceOf(IdentityRegistryPoisonedError);
  await expect(registry.revokeCredential(actor, credentialId)).rejects.toBeInstanceOf(
    IdentityRegistryPoisonedError,
  );
  await expect(registry.rotateCredential(actor, credentialId)).rejects.toBeInstanceOf(
    IdentityRegistryPoisonedError,
  );
  await expect(
    registry.logoutAll(actor, principal.principalId, principal.organizationId),
  ).rejects.toBeInstanceOf(IdentityRegistryPoisonedError);
}

async function expectTokenStates(
  registry: IdentityRegistry,
  states: ReadonlyArray<{ token: string; authenticated: boolean }>,
): Promise<void> {
  for (const state of states) {
    const authenticated = await registry.authenticate(state.token, node);
    expect(authenticated?.principalId ?? null).toBe(
      state.authenticated ? principal.principalId : null,
    );
  }
}

function validRegistryDocument(credentialId?: string, key = credentialId): string {
  const credentials = credentialId
    ? {
        [key!]: {
          credentialId,
          principalId: principal.principalId,
          organizationId: principal.organizationId,
          secretHash: testDigest(TEST_SECRETS[0]!),
          createdAt: TEST_NOW,
        },
      }
    : {};
  return `${JSON.stringify({ version: 1, credentials })}\n`;
}

describe("IdentityRegistry", () => {
  test("issues, authenticates, updates lastUsed, and never persists plaintext", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const filePath = path.join(root, "enterprise", "credentials.json");
    const audit = memoryAudit();
    const registry = new IdentityRegistry({
      filePath,
      principalSource: source,
      node,
      audit: audit.sink,
      invalidation,
    });
    const issued = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    expect(parsePersonalAccessToken(issued.token)?.secret.length).toBeGreaterThanOrEqual(43);
    expect((await registry.authenticate(issued.token, node))?.principalId).toBe(
      principal.principalId,
    );
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(filePath, "utf8")).not.toContain(
      parsePersonalAccessToken(issued.token)!.secret,
    );
    expect(await registry.revokeCredential(actor, issued.credentialId)).toBe(true);
    expect(
      audit.events.some(
        (event) => event.action === "identity.credential.issue" && event.outcome === "allowed",
      ),
    ).toBe(true);
    expect(await registry.authenticate(issued.token, node)).toBeNull();
  });

  test("rejects malformed strict registry and required-audit failure leaves no credential", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const filePath = path.join(root, "credentials.json");
    await writeFile(filePath, JSON.stringify({ version: 1, credentials: { bad: {} } }));
    const corrupt = new IdentityRegistry({
      filePath,
      principalSource: source,
      node,
      audit: memoryAudit().sink,
      invalidation,
    });
    await expect(corrupt.load()).rejects.toThrow("Invalid identity registry");
    const auditPath = path.join(root, "audit-credentials.json");
    const failingAudit = {
      append: async () => {
        throw new Error("audit unavailable");
      },
    };
    const registry = new IdentityRegistry({
      filePath: auditPath,
      principalSource: source,
      node,
      audit: failingAudit,
      invalidation,
    });
    await expect(
      registry.issueToken({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ).rejects.toThrow("audit unavailable");
    expect(await readFile(auditPath, "utf8")).not.toContain("secretHash");
  });

  test("rotation invalidates the old token and logoutAll invalidates the replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const registry = new IdentityRegistry({
      filePath: path.join(root, "credentials.json"),
      principalSource: source,
      node,
      audit: memoryAudit().sink,
      invalidation,
    });
    const first = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    const rotated = await registry.rotateCredential(actor, first.credentialId);
    expect(rotated?.credentialId).not.toBe(first.credentialId);
    expect(await registry.authenticate(first.token, node)).toBeNull();
    expect(await registry.logoutAll(actor, principal.principalId, principal.organizationId)).toBe(
      1,
    );
    expect(await registry.authenticate(rotated!.token, node)).toBeNull();
  });

  test("rejects malformed and wrong tokens and performs one verifier call", async () => {
    let comparisons = 0;
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const registry = new IdentityRegistry({
      filePath: path.join(root, "credentials.json"),
      principalSource: source,
      node,
      audit: memoryAudit().sink,
      invalidation,
      verifier: {
        compare: async () => {
          comparisons++;
          return false;
        },
      },
    });
    const issued = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    expect(await registry.authenticate("not-a-pat", node)).toBeNull();
    expect(await registry.authenticate("pso_u_cred_000000000000000000000000.bad", node)).toBeNull();
    expect(await registry.authenticate(issued.token, node)).toBeNull();
    expect(comparisons).toBe(1);
  });

  test("revoke during blocked verification cannot establish authentication", async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const audit = memoryAudit();
    const registry = new IdentityRegistry({
      filePath: path.join(root, "credentials.json"),
      principalSource: source,
      node,
      audit: audit.sink,
      invalidation,
      verifier: {
        compare: async () => {
          await blocked;
          return true;
        },
      },
    });
    const issued = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    const pending = registry.authenticate(issued.token, node);
    await registry.revokeCredential(actor, issued.credentialId);
    unblock();
    await expect(pending).resolves.toBeNull();
  });

  test("restart fails closed when durable poison marker is present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const filePath = path.join(root, "credentials.json");
    await writeFile(`${filePath}.poison`, "poisoned\n", { mode: 0o600 });
    const registry = new IdentityRegistry({
      filePath,
      principalSource: source,
      node,
      audit: memoryAudit().sink,
      invalidation,
    });
    await expect(registry.load()).rejects.toThrow("poisoned");
    await expect(registry.authenticate("not-a-pat", node)).resolves.toBeNull();
  });

  test("fails closed before filesystem access when O_NOFOLLOW is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const fs = new FaultFs({ noFollowFlag: 0 });
    expect(() =>
      createTestRegistry({
        filePath: path.join(root, "credentials.json"),
        fs,
      }),
    ).toThrow(IdentityRegistryStorageUnsupportedError);
    expect(fs.calls).toEqual([]);
  });

  test("loads through handle-bound operations and tightens wide file and directory modes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const directoryPath = path.join(root, "enterprise");
    const filePath = path.join(directoryPath, "credentials.json");
    await mkdir(directoryPath, { mode: 0o777 });
    await writeFile(filePath, validRegistryDocument(), { mode: 0o666 });
    await chmod(directoryPath, 0o777);
    await chmod(filePath, 0o666);
    const fs = new FaultFs();
    const { registry } = createTestRegistry({ filePath, fs });

    await registry.load();
    await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });

    expect((await stat(directoryPath)).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(fs.count("read", (call) => call.path === filePath)).toBe(1);
    expect(fs.count("fchmod", (call) => call.path === filePath)).toBe(1);
    expect(
      fs.calls
        .filter((call) => call.operation === "open")
        .every((call) => ((call.flags ?? 0) & fs.noFollowFlag) === fs.noFollowFlag),
    ).toBe(true);
  });

  test("rejects symlinked parents, symlinked registry files, and non-regular registry files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const realDirectory = path.join(root, "real");
    const linkedDirectory = path.join(root, "linked");
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory);
    const parentSymlinkRegistry = createTestRegistry({
      filePath: path.join(linkedDirectory, "credentials.json"),
    }).registry;
    await expect(parentSymlinkRegistry.load()).rejects.toMatchObject({ code: "ELOOP" });

    const regularPath = path.join(root, "regular.json");
    const linkedFilePath = path.join(root, "linked.json");
    await writeFile(regularPath, validRegistryDocument(), { mode: 0o600 });
    await symlink(regularPath, linkedFilePath);
    const fileSymlinkRegistry = createTestRegistry({ filePath: linkedFilePath }).registry;
    await expect(fileSymlinkRegistry.load()).rejects.toMatchObject({ code: "ELOOP" });

    const nonRegularPath = path.join(root, "directory-as-registry");
    await mkdir(nonRegularPath);
    const nonRegularRegistry = createTestRegistry({ filePath: nonRegularPath }).registry;
    await expect(nonRegularRegistry.load()).rejects.toThrow(
      "Identity registry is not a regular file",
    );
  });

  test("treats any present poison marker as fail-closed state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const targetPath = path.join(root, "marker-target");
    const filePath = path.join(root, "credentials.json");
    await writeFile(targetPath, "poisoned\n", { mode: 0o600 });
    await symlink(targetPath, `${filePath}.poison`);
    const registry = createTestRegistry({ filePath }).registry;
    await expect(registry.load()).rejects.toBeInstanceOf(IdentityRegistryPoisonedError);
    await expect(registry.authenticate("not-a-pat", node)).resolves.toBeNull();

    const wideRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const widePath = path.join(wideRoot, "credentials.json");
    await writeFile(`${widePath}.poison`, "poisoned\n", { mode: 0o644 });
    await chmod(`${widePath}.poison`, 0o644);
    const wideMarkerRegistry = createTestRegistry({ filePath: widePath }).registry;
    await expect(wideMarkerRegistry.load()).rejects.toBeInstanceOf(IdentityRegistryPoisonedError);
  });

  test("rejects corrupt JSON and credential-key mismatch without replacing the file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const corruptPath = path.join(root, "corrupt.json");
    await writeFile(corruptPath, "{not-json", { mode: 0o600 });
    const corruptBefore = await readFile(corruptPath, "utf8");
    await expect(createTestRegistry({ filePath: corruptPath }).registry.load()).rejects.toThrow(
      "Invalid identity registry",
    );
    expect(await readFile(corruptPath, "utf8")).toBe(corruptBefore);

    const mismatchPath = path.join(root, "mismatch.json");
    await writeFile(
      mismatchPath,
      validRegistryDocument(TEST_CREDENTIAL_IDS[0]!, TEST_CREDENTIAL_IDS[1]!),
      { mode: 0o600 },
    );
    const mismatchBefore = await readFile(mismatchPath, "utf8");
    await expect(createTestRegistry({ filePath: mismatchPath }).registry.load()).rejects.toThrow(
      "Invalid identity registry",
    );
    expect(await readFile(mismatchPath, "utf8")).toBe(mismatchBefore);
  });

  test.each([
    { operation: "open" as const },
    { operation: "fstat" as const },
    { operation: "fchmod" as const },
    { operation: "read" as const },
  ])("load fails closed on injected registry $operation failure", async ({ operation }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const filePath = path.join(root, "credentials.json");
    await writeFile(filePath, validRegistryDocument(), { mode: 0o600 });
    const before = await readFile(filePath, "utf8");
    const fs = new FaultFs();
    const failure = new Error(`injected-load-${operation}`);
    fs.fail(operation, failure, {
      matches: (call) => call.path === filePath,
    });
    const registry = createTestRegistry({ filePath, fs }).registry;

    await expect(registry.load()).rejects.toBe(failure);

    expect(await readFile(filePath, "utf8")).toBe(before);
    expect(fs.count("write")).toBe(0);
    expect(fs.count("rename")).toBe(0);
    expect(fs.count("close", (call) => call.path === filePath)).toBe(operation === "open" ? 0 : 1);
  });

  test.each([
    { label: "parent mkdir", operation: "mkdir" as const, target: "parent" as const },
    { label: "parent open", operation: "open" as const, target: "parent" as const },
    { label: "parent fstat", operation: "fstat" as const, target: "parent" as const },
    { label: "parent fchmod", operation: "fchmod" as const, target: "parent" as const },
    { label: "temporary open", operation: "open" as const, target: "temporary" as const },
    { label: "temporary write", operation: "write" as const, target: "temporary" as const },
    { label: "temporary fchmod", operation: "fchmod" as const, target: "temporary" as const },
    { label: "temporary fstat", operation: "fstat" as const, target: "temporary" as const },
    { label: "temporary fsync", operation: "fsync" as const, target: "temporary" as const },
    { label: "rename", operation: "rename" as const, target: "temporary" as const },
  ])("preserves the old snapshot on pre-rename $label failure", async ({ operation, target }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const filePath = path.join(root, "credentials.json");
    const fs = new FaultFs();
    const {
      registry,
      audit,
      invalidation: invalidationRecorder,
    } = createTestRegistry({
      filePath,
      fs,
    });
    await registry.load();
    const before = await readFile(filePath, "utf8");
    const failure = new Error(`injected-${operation}`);
    fs.fail(operation, failure, {
      matches: (call) =>
        target === "parent" ? isParentPath(call, filePath) : isTemporaryPath(call, filePath),
    });

    await expect(
      registry.issueToken({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ).rejects.toBe(failure);

    expect(await readFile(filePath, "utf8")).toBe(before);
    expect(audit.events.map((event) => event.action)).toEqual([
      "identity.credential.issue",
      "identity.credential.issue",
    ]);
    expect(invalidationRecorder.events).toEqual([]);
    const failedToken = formatPersonalAccessToken(TEST_CREDENTIAL_IDS[0]!, TEST_SECRETS[0]!);
    await expect(registry.authenticate(failedToken, node)).resolves.toBeNull();
    const restart = createTestRegistry({ filePath }).registry;
    await expect(restart.authenticate(failedToken, node)).resolves.toBeNull();
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect(fs.count("unlink", (call) => isTemporaryPath(call, filePath))).toBe(
      target === "temporary" && operation !== "open" ? 1 : 0,
    );
  });

  test.each([
    { operation: "issue" as const, auditAction: "identity.credential.issue" },
    { operation: "rotate" as const, auditAction: "identity.credential.rotate" },
    { operation: "revoke" as const, auditAction: "identity.credential.revoke" },
    { operation: "logout" as const, auditAction: "identity.logout_all" },
  ])(
    "$operation has no ghost credential, revocation, or invalidation after a pre-rename failure",
    async ({ operation, auditAction }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
      const filePath = path.join(root, "credentials.json");
      const fs = new FaultFs();
      const {
        registry,
        audit,
        invalidation: invalidationRecorder,
      } = createTestRegistry({
        filePath,
        fs,
      });
      const firstToken = formatPersonalAccessToken(TEST_CREDENTIAL_IDS[0]!, TEST_SECRETS[0]!);
      const secondToken = formatPersonalAccessToken(TEST_CREDENTIAL_IDS[1]!, TEST_SECRETS[1]!);
      const expectedStates: Array<{ token: string; authenticated: boolean }> = [];
      let action: () => Promise<unknown>;

      if (operation === "issue") {
        await registry.load();
        action = () =>
          registry.issueToken({
            actor,
            principalId: principal.principalId,
            organizationId: principal.organizationId,
          });
        expectedStates.push({ token: firstToken, authenticated: false });
      } else {
        await registry.issueToken({
          actor,
          principalId: principal.principalId,
          organizationId: principal.organizationId,
        });
        expectedStates.push({ token: firstToken, authenticated: true });
        if (operation === "rotate") {
          action = () => registry.rotateCredential(actor, TEST_CREDENTIAL_IDS[0]!);
          expectedStates.push({ token: secondToken, authenticated: false });
        } else if (operation === "revoke") {
          action = () => registry.revokeCredential(actor, TEST_CREDENTIAL_IDS[0]!);
        } else {
          await registry.issueToken({
            actor,
            principalId: principal.principalId,
            organizationId: principal.organizationId,
          });
          expectedStates.push({ token: secondToken, authenticated: true });
          action = () => registry.logoutAll(actor, principal.principalId, principal.organizationId);
        }
      }

      const before = await readFile(filePath, "utf8");
      const auditCount = audit.events.length;
      const failure = new Error(`injected-${operation}-write`);
      fs.fail("write", failure, {
        matches: (call) => isTemporaryPath(call, filePath),
      });

      await expect(action()).rejects.toBe(failure);

      expect(await readFile(filePath, "utf8")).toBe(before);
      expect(audit.events.slice(auditCount).map((event) => event.action)).toEqual([
        auditAction,
        auditAction,
      ]);
      expect(invalidationRecorder.events).toEqual([]);
      await expectTokenStates(registry, expectedStates);
      const restart = createTestRegistry({ filePath }).registry;
      await expectTokenStates(restart, expectedStates);
    },
  );

  test.each([
    { operation: "issue" as const },
    { operation: "rotate" as const },
    { operation: "revoke" as const },
    { operation: "logout" as const },
  ])(
    "$operation required-audit failure leaves memory and disk unchanged",
    async ({ operation }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
      const filePath = path.join(root, "credentials.json");
      const recordedAudit = memoryAudit();
      const auditError = new Error(`audit-${operation}-unavailable`);
      let rejectAudit = false;
      const audit = {
        events: recordedAudit.events,
        sink: {
          append: async (
            input: AuditEventInput,
            options: AuditAppendOptions,
          ): Promise<AuditEvent> => {
            if (rejectAudit) throw auditError;
            return recordedAudit.sink.append(input, options);
          },
        },
      };
      const invalidationRecorder = memoryInvalidation();
      const { registry } = createTestRegistry({
        filePath,
        audit,
        invalidation: invalidationRecorder,
      });
      const firstToken = formatPersonalAccessToken(TEST_CREDENTIAL_IDS[0]!, TEST_SECRETS[0]!);
      const secondToken = formatPersonalAccessToken(TEST_CREDENTIAL_IDS[1]!, TEST_SECRETS[1]!);
      const expectedStates: Array<{ token: string; authenticated: boolean }> = [];
      let action: () => Promise<unknown>;

      if (operation === "issue") {
        await registry.load();
        action = () =>
          registry.issueToken({
            actor,
            principalId: principal.principalId,
            organizationId: principal.organizationId,
          });
        expectedStates.push({ token: firstToken, authenticated: false });
      } else {
        await registry.issueToken({
          actor,
          principalId: principal.principalId,
          organizationId: principal.organizationId,
        });
        expectedStates.push({ token: firstToken, authenticated: true });
        if (operation === "rotate") {
          action = () => registry.rotateCredential(actor, TEST_CREDENTIAL_IDS[0]!);
          expectedStates.push({ token: secondToken, authenticated: false });
        } else if (operation === "revoke") {
          action = () => registry.revokeCredential(actor, TEST_CREDENTIAL_IDS[0]!);
        } else {
          await registry.issueToken({
            actor,
            principalId: principal.principalId,
            organizationId: principal.organizationId,
          });
          expectedStates.push({ token: secondToken, authenticated: true });
          action = () => registry.logoutAll(actor, principal.principalId, principal.organizationId);
        }
      }

      const before = await readFile(filePath, "utf8");
      const auditCount = audit.events.length;
      rejectAudit = true;
      await expect(action()).rejects.toBe(auditError);
      rejectAudit = false;

      expect(await readFile(filePath, "utf8")).toBe(before);
      expect(audit.events).toHaveLength(auditCount);
      expect(invalidationRecorder.events).toEqual([]);
      await expectTokenStates(registry, expectedStates);
      const restart = createTestRegistry({ filePath }).registry;
      await expectTokenStates(restart, expectedStates);
    },
  );

  test("returns the original post-rename error after durable rollback and restart reads the old snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const filePath = path.join(root, "credentials.json");
    const fs = new FaultFs();
    const {
      registry,
      audit,
      invalidation: invalidationRecorder,
    } = createTestRegistry({
      filePath,
      fs,
    });
    const first = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    const before = await readFile(filePath, "utf8");
    const primaryError = new Error("primary parent fsync failure");
    fs.fail("fsync", primaryError, {
      matches: (call) => isParentPath(call, filePath),
    });

    await expect(
      registry.issueToken({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ).rejects.toBe(primaryError);

    expect(await readFile(filePath, "utf8")).toBe(before);
    await expect(stat(`${filePath}.poison`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(audit.events.map((event) => event.action)).toEqual([
      "identity.credential.issue",
      "identity.credential.issue",
      "identity.credential.issue",
    ]);
    expect(invalidationRecorder.events).toEqual([]);
    const failedToken = formatPersonalAccessToken(TEST_CREDENTIAL_IDS[1]!, TEST_SECRETS[1]!);
    await expectTokenStates(registry, [
      { token: first.token, authenticated: true },
      { token: failedToken, authenticated: false },
    ]);
    const restart = createTestRegistry({ filePath }).registry;
    await expectTokenStates(restart, [
      { token: first.token, authenticated: true },
      { token: failedToken, authenticated: false },
    ]);
  });

  test("restores a missing initial snapshot through the injected unlink path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const filePath = path.join(root, "credentials.json");
    const fs = new FaultFs();
    const registry = createTestRegistry({ filePath, fs }).registry;
    const primaryError = new Error("initial parent fsync failure");
    fs.fail("fsync", primaryError, {
      matches: (call) => isParentPath(call, filePath),
    });

    await expect(registry.load()).rejects.toBe(primaryError);

    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${filePath}.poison`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fs.count("unlink", (call) => call.path === filePath)).toBe(1);
    await expect(registry.load()).resolves.toBeUndefined();
    expect(await readFile(filePath, "utf8")).toBe(validRegistryDocument());
  });

  test("durably poisons current and restarted registries when post-rename rollback fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const filePath = path.join(root, "credentials.json");
    const fs = new FaultFs();
    const {
      registry,
      audit,
      invalidation: invalidationRecorder,
    } = createTestRegistry({
      filePath,
      fs,
    });
    const issued = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    const primaryError = new Error("primary parent fsync failure");
    const rollbackError = new Error("rollback rename failure");
    fs.fail("fsync", primaryError, {
      matches: (call) => isParentPath(call, filePath),
    });
    fs.fail("rename", rollbackError, {
      occurrence: 2,
      matches: (call) => isTemporaryPath(call, filePath),
    });

    let failure: unknown;
    try {
      await registry.revokeCredential(actor, issued.credentialId);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      "Identity registry rollback failed; registry is poisoned",
    );
    expect((failure as AggregateError).errors).toEqual([primaryError, rollbackError]);
    expect((failure as AggregateError).cause).toBe(primaryError);
    expect(await readFile(`${filePath}.poison`, "utf8")).toBe("poisoned\n");
    expect((await stat(`${filePath}.poison`)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      version: 1,
      credentials: {
        [issued.credentialId]: expect.objectContaining({ revokedAt: TEST_NOW }),
      },
    });
    expect(audit.events.map((event) => event.action)).toEqual([
      "identity.credential.issue",
      "identity.credential.revoke",
      "identity.credential.revoke",
    ]);
    expect(invalidationRecorder.events).toEqual([]);
    await expectPoisonedPublicEntries(registry, issued.token, issued.credentialId);
    const restart = createTestRegistry({ filePath }).registry;
    await expectPoisonedPublicEntries(restart, issued.token, issued.credentialId);
  });

  test("surfaces primary, rollback, and marker failures as explicit P0 evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const filePath = path.join(root, "credentials.json");
    const fs = new FaultFs();
    const { registry, invalidation: invalidationRecorder } = createTestRegistry({ filePath, fs });
    const issued = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    const primaryError = new Error("primary parent fsync failure");
    const rollbackError = new Error("rollback rename failure");
    const markerError = new Error("poison marker write failure");
    fs.fail("fsync", primaryError, {
      matches: (call) => isParentPath(call, filePath),
    });
    fs.fail("rename", rollbackError, {
      occurrence: 2,
      matches: (call) => isTemporaryPath(call, filePath),
    });
    fs.fail("open", markerError, {
      matches: (call) => call.path === `${filePath}.poison`,
    });

    let failure: unknown;
    try {
      await registry.revokeCredential(actor, issued.credentialId);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      "Identity registry rollback and poison marker persistence failed",
    );
    expect((failure as AggregateError).errors).toEqual([primaryError, rollbackError, markerError]);
    expect((failure as AggregateError).cause).toBe(primaryError);
    await expect(stat(`${filePath}.poison`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(invalidationRecorder.events).toEqual([]);
    await expectPoisonedPublicEntries(registry, issued.token, issued.credentialId);
  });

  test("keeps committed revocation when invalidation delivery fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const filePath = path.join(root, "credentials.json");
    const deliveryError = new Error("invalidation unavailable");
    const invalidationEvents: CredentialInvalidation[] = [];
    const invalidationRecorder = {
      events: invalidationEvents,
      sink: {
        publish: async (event: CredentialInvalidation): Promise<void> => {
          invalidationEvents.push(event);
          throw deliveryError;
        },
      },
    };
    const { registry, audit } = createTestRegistry({
      filePath,
      invalidation: invalidationRecorder,
    });
    const issued = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });

    await expect(registry.revokeCredential(actor, issued.credentialId)).rejects.toMatchObject({
      committed: true,
      event: {
        kind: "credential.revoke",
        credentialIds: [issued.credentialId],
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      },
      cause: deliveryError,
    } satisfies Partial<CredentialInvalidationCommittedError>);

    expect(invalidationEvents).toHaveLength(1);
    expect(audit.events.map((event) => event.action)).toEqual([
      "identity.credential.issue",
      "identity.credential.revoke",
    ]);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      version: 1,
      credentials: {
        [issued.credentialId]: expect.objectContaining({ revokedAt: TEST_NOW }),
      },
    });
    await expect(registry.authenticate(issued.token, node)).resolves.toBeNull();
    await expect(
      createTestRegistry({ filePath }).registry.authenticate(issued.token, node),
    ).resolves.toBeNull();
  });

  test("publishes exact invalidations only after rotate, revoke, and logout commits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const filePath = path.join(root, "credentials.json");
    const invalidationRecorder = memoryInvalidation();
    const { registry, audit } = createTestRegistry({
      filePath,
      invalidation: invalidationRecorder,
    });
    const first = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    const rotated = await registry.rotateCredential(actor, first.credentialId);
    const revoked = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    await registry.revokeCredential(actor, revoked.credentialId);
    const loggedOut = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    await registry.logoutAll(actor, principal.principalId, principal.organizationId);

    expect(invalidationRecorder.events).toEqual([
      {
        kind: "credential.rotate",
        credentialIds: [first.credentialId],
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      },
      {
        kind: "credential.revoke",
        credentialIds: [revoked.credentialId],
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      },
      {
        kind: "principal.logout_all",
        credentialIds: [rotated!.credentialId, loggedOut.credentialId],
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      },
    ]);
    expect(audit.events.map((event) => event.action)).toEqual([
      "identity.credential.issue",
      "identity.credential.rotate",
      "identity.credential.issue",
      "identity.credential.revoke",
      "identity.credential.issue",
      "identity.logout_all",
    ]);
    await expectTokenStates(registry, [
      { token: first.token, authenticated: false },
      { token: rotated!.token, authenticated: false },
      { token: revoked.token, authenticated: false },
      { token: loggedOut.token, authenticated: false },
    ]);
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(Object.values(persisted.credentials)).toEqual([
      expect.objectContaining({ credentialId: first.credentialId, revokedAt: TEST_NOW }),
      expect.objectContaining({ credentialId: rotated!.credentialId, revokedAt: TEST_NOW }),
      expect.objectContaining({ credentialId: revoked.credentialId, revokedAt: TEST_NOW }),
      expect.objectContaining({ credentialId: loggedOut.credentialId, revokedAt: TEST_NOW }),
    ]);
    const restart = createTestRegistry({ filePath }).registry;
    await expectTokenStates(restart, [
      { token: first.token, authenticated: false },
      { token: rotated!.token, authenticated: false },
      { token: revoked.token, authenticated: false },
      { token: loggedOut.token, authenticated: false },
    ]);
  });

  test("coalesces concurrent load and serializes concurrent mutations without lost credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const filePath = path.join(root, "credentials.json");
    await writeFile(filePath, validRegistryDocument(), { mode: 0o600 });
    const fs = new FaultFs();
    const { registry, audit } = createTestRegistry({ filePath, fs });

    const [first, second] = await Promise.all([
      registry.issueToken({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
      registry.issueToken({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
      registry.load(),
      registry.load(),
    ]);

    expect(fs.count("read", (call) => call.path === filePath)).toBe(1);
    expect(Object.keys(JSON.parse(await readFile(filePath, "utf8")).credentials)).toEqual([
      first.credentialId,
      second.credentialId,
    ]);
    expect(audit.events.map((event) => event.action)).toEqual([
      "identity.credential.issue",
      "identity.credential.issue",
    ]);
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    const restart = createTestRegistry({ filePath }).registry;
    await expectTokenStates(restart, [
      { token: first.token, authenticated: true },
      { token: second.token, authenticated: true },
    ]);
  });

  test("rejects noncanonical PATs and format components", () => {
    const canonical = TEST_SECRETS[0]!;
    expect(parsePersonalAccessToken(`pso_u_${TEST_CREDENTIAL_IDS[0]}.${canonical}=`)).toBeNull();
    expect(
      parsePersonalAccessToken(`pso_u_${TEST_CREDENTIAL_IDS[0]}.${canonical.slice(0, 42)}`),
    ).toBeNull();
    expect(
      parsePersonalAccessToken(`pso_u_${TEST_CREDENTIAL_IDS[0]}.${canonical.slice(0, 42)}*`),
    ).toBeNull();
    expect(() => formatPersonalAccessToken(TEST_CREDENTIAL_IDS[0]!, `${canonical}=`)).toThrow();
    expect(() =>
      formatPersonalAccessToken(TEST_CREDENTIAL_IDS[0]!, canonical.slice(0, 42)),
    ).toThrow();
  });

  test("collision and malformed principal fail before side effects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const fs = new FaultFs();
    const audit = memoryAudit();
    const badSource = {
      resolvePrincipal: async () => ({
        ...principal,
        grants: [{ action: "bad", selector: { kind: "self" } }],
      }),
    };
    const { registry } = createTestRegistry({
      filePath: path.join(root, "credentials.json"),
      fs,
      audit: { sink: audit.sink, events: audit.events },
      credentialIds: [TEST_CREDENTIAL_IDS[0]!, TEST_CREDENTIAL_IDS[0]!],
    });
    await registry.load();
    await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    await expect(
      registry.issueToken({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ).rejects.toThrow("collision");
    const malformed = createTestRegistry({
      filePath: path.join(root, "bad.json"),
      principalSource: badSource,
      fs: new FaultFs(),
      audit: { sink: audit.sink, events: audit.events },
    }).registry;
    await expect(
      malformed.issueToken({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ).rejects.toThrow();
    expect(audit.events).toHaveLength(1);
  });

  test("current credential guard rejects cross-context and revoked credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const { registry } = createTestRegistry({ filePath: path.join(root, "credentials.json") });
    const issued = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    expect(await registry.isCurrentPrincipalContext(issued.principal)).toBe(true);
    expect(
      await registry.isCurrentPrincipalContext({
        ...issued.principal,
        organizationId: "org_aaaaaaaaaaaaaaaa",
      }),
    ).toBe(false);
    expect(
      await registry.isCurrentPrincipalContext({
        ...issued.principal,
        principalId: "usr_aaaaaaaaaaaaaaaa",
      }),
    ).toBe(false);
    expect(
      await registry.isCurrentPrincipalContext({ ...issued.principal, grantVersion: "other" }),
    ).toBe(false);
    await registry.revokeCredential(actor, issued.credentialId);
    expect(await registry.isCurrentPrincipalContext(issued.principal)).toBe(false);
  });

  test("clock invalid, rollback, single capture, and rotate expiry are fail-closed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    let calls = 0;
    const clock = { now: () => (++calls === 1 ? "not-a-date" : TEST_NOW) };
    const bad = createTestRegistry({ filePath: path.join(root, "bad.json"), clock }).registry;
    await expect(bad.load()).resolves.toBeUndefined();
    await expect(
      bad.issueToken({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ).rejects.toThrow("clock");
    const rollbackClock = {
      values: ["2026-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"],
      now() {
        return this.values.shift() ?? TEST_NOW;
      },
    };
    const reg = createTestRegistry({
      filePath: path.join(root, "rollback.json"),
      clock: rollbackClock,
    }).registry;
    await expect(
      reg.issueToken({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ).resolves.toBeTruthy();
    await expect(
      reg.issueToken({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ).rejects.toThrow("backwards");
    const exp = createTestRegistry({
      filePath: path.join(root, "exp.json"),
      clock: { now: () => "2026-01-02T00:00:00.000Z" },
    }).registry;
    const issued = await exp
      .issueToken({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
        expiresAt: "2026-01-01T00:00:00.000Z",
      })
      .catch(() => null);
    expect(issued).toBeNull();
  });

  test("rotate rejects collision with old and any existing credential without side effects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const audit = memoryAudit();
    const invalidationRecorder = memoryInvalidation();
    const { registry } = createTestRegistry({
      filePath: path.join(root, "r.json"),
      credentialIds: [TEST_CREDENTIAL_IDS[0]!, TEST_CREDENTIAL_IDS[1]!, TEST_CREDENTIAL_IDS[0]!],
      audit,
      invalidation: invalidationRecorder,
    });
    const first = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    const second = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    const before = audit.events.length;
    await expect(registry.rotateCredential(actor, first.credentialId)).rejects.toThrow("collision");
    expect(audit.events).toHaveLength(before);
    expect(invalidationRecorder.events).toHaveLength(0);
    await expect(registry.authenticate(first.token, node)).resolves.toBeTruthy();
    await expect(registry.authenticate(second.token, node)).resolves.toBeTruthy();
    const other = createTestRegistry({
      filePath: path.join(root, "other.json"),
      credentialIds: [TEST_CREDENTIAL_IDS[0]!, TEST_CREDENTIAL_IDS[1]!, TEST_CREDENTIAL_IDS[1]!],
    });
    const a = await other.registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    await other.registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    await expect(other.registry.rotateCredential(actor, a.credentialId)).rejects.toThrow(
      "collision",
    );
  });

  test("authenticate success followed by revoke is blocked by attach guard", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const { registry } = createTestRegistry({ filePath: path.join(root, "race.json") });
    const issued = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    const ctx = await registry.authenticate(issued.token, node);
    expect(ctx).toBeTruthy();
    await registry.revokeCredential(actor, issued.credentialId);
    expect(await registry.isCurrentPrincipalContext(ctx!)).toBe(false);
  });

  test("blocked principal source then revoke makes current guard false", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    let blocked = false;
    let gateOnce = true;
    let release!: () => void;
    const sourceGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: PrincipalGrantSource = {
      resolvePrincipal: async () => {
        if (blocked && gateOnce) {
          gateOnce = false;
          await sourceGate;
        }
        return { ...principal, credentialId: undefined as never };
      },
    };
    const { registry } = createTestRegistry({
      filePath: path.join(root, "gate.json"),
      principalSource: gated,
    });
    const issued = await registry.issueToken({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    blocked = true;
    const guard = registry.isCurrentPrincipalContext(issued.principal);
    await registry.revokeCredential(actor, issued.credentialId);
    release();
    await expect(guard).resolves.toBe(false);
  });

  test("queued mutation uses call-time snapshots while prior mutation is blocked", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockedSource: PrincipalGrantSource = {
      resolvePrincipal: async () => {
        await gate;
        return { ...principal, credentialId: undefined as never };
      },
    };
    const { registry } = createTestRegistry({
      filePath: path.join(root, "queued.json"),
      principalSource: blockedSource,
    });
    const input: { actor: PrincipalContext; principalId: string; organizationId: string } = {
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    };
    const pending = registry.issueToken(input);
    input.principalId = "usr_aaaaaaaaaaaaaaaa";
    release();
    await expect(pending).resolves.toMatchObject({
      principal: { principalId: principal.principalId },
    });
  });

  test("invalid node context rejects before verifier, audit, and storage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    const audit = memoryAudit();
    const fs = new FaultFs();
    let verifierCalls = 0;
    const { registry } = createTestRegistry({
      filePath: path.join(root, "node.json"),
      fs,
      audit,
      verifier: undefined,
    });
    await expect(registry.authenticate("bad", { nodeId: "bad" } as never)).rejects.toThrow();
    expect(verifierCalls).toBe(0);
    expect(audit.events).toHaveLength(0);
    expect(fs.count("read")).toBe(0);
  });

  test("failed audit AggregateError preserves primary then audit error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-identity-"));
    let n = 0;
    const primary = new Error("primary");
    const auditError = new Error("audit");
    const audit: IdentityAuditSink = {
      append: async () => {
        n++;
        if (n === 2) throw auditError;
        return {} as AuditEvent;
      },
    };
    const fs = new FaultFs();
    const { registry } = createTestRegistry({
      filePath: path.join(root, "x.json"),
      fs,
      audit: { sink: audit, events: [] },
    });
    await registry.load();
    fs.fail("write", primary, { matches: (c) => (c.path ?? "").endsWith(".tmp") });
    await expect(
      registry.issueToken({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof AggregateError &&
        e.errors[0] === primary &&
        e.errors[1] === auditError &&
        e.cause === primary,
    );
  });
  test("issueInitialCredential is idempotent within the registry transaction", async () => {
    const filePath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "paseo-initial-")),
      "credentials.json",
    );
    const { registry } = createTestRegistry({ filePath });
    await registry.load();
    const [first, second] = await Promise.all([
      registry.issueInitialCredential({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
      registry.issueInitialCredential({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual(["already_provisioned", "issued"]);
    expect(
      Object.keys(
        (registry as unknown as { document: { credentials: Record<string, unknown> } }).document
          .credentials,
      ),
    ).toHaveLength(1);
  });
  test("initial credential rejects foreign and unknown principals", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-initial-foreign-"));
    const { registry } = createTestRegistry({
      filePath: path.join(root, "credentials.json"),
    });
    await registry.load();
    await expect(
      registry.issueInitialCredential({
        actor,
        principalId: principal.principalId,
        organizationId: "org_bbbbbbbbbbbbbbbb",
      }),
    ).rejects.toThrow();
    await expect(
      registry.issueInitialCredential({
        actor,
        principalId: "usr_bbbbbbbbbbbbbbbb",
        organizationId: principal.organizationId,
      }),
    ).rejects.toThrow();
  });
  test("initial credential propagates storage failure", async () => {
    const fs = new FaultFs();
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-initial-failure-"));
    const filePath = path.join(root, "credentials.json");
    const { registry } = createTestRegistry({ filePath, fs });
    await registry.load();
    const failure = new Error("initial storage failure");
    fs.fail("write", failure, { matches: (call) => (call.path ?? "").endsWith(".tmp") });
    await expect(
      registry.issueInitialCredential({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ).rejects.toThrow();
  });
  test("initial credential serializes deferred hashing to one issued and one already", async () => {
    let enterHash!: () => void;
    let releaseHash!: () => void;
    const entered = new Promise<void>((resolve) => (enterHash = resolve));
    const gate = new Promise<void>((resolve) => (releaseHash = resolve));
    const hasher = {
      hash: vi.fn(async (secret: string) => {
        enterHash();
        await gate;
        return testDigest(secret);
      }),
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-initial-serial-"));
    const { registry, audit } = createTestRegistry({
      filePath: path.join(root, "credentials.json"),
      hasher,
    });
    await registry.load();
    const first = registry.issueInitialCredential({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    await entered;
    const second = registry.issueInitialCredential({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    releaseHash();
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.status === "issued")).toHaveLength(1);
    expect(results.filter((result) => result.status === "already_provisioned")).toHaveLength(1);
    expect(hasher.hash).toHaveBeenCalledOnce();
    expect(
      audit.events.filter((event) => event.action === "identity.credential.issue"),
    ).toHaveLength(1);
  });

  test("initial credential audit failure does not report already provisioned", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-initial-audit-"));
    const audit = memoryAudit();
    const auditError = new Error("initial audit failure");
    audit.sink.append = async () => {
      throw auditError;
    };
    const { registry } = createTestRegistry({
      filePath: path.join(root, "credentials.json"),
      audit,
    });
    await registry.load();
    await expect(
      registry.issueInitialCredential({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ).rejects.toBe(auditError);
    await expect(
      registry.issueInitialCredential({
        actor,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
      }),
    ).rejects.toBe(auditError);
  });
});
