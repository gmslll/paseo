import { randomBytes } from "node:crypto";
import { constants as fileConstants, fstatSync, type Stats } from "node:fs";
import nodePath from "node:path";
import {
  EnterpriseResourceOwnerSchema,
  type AuthorizedWorkspace,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import {
  ENTERPRISE_UPLOAD_CAPACITY_HARD_MAX,
  type EnterpriseUploadCapability,
  type EnterpriseUploadFinalizedTarget,
  type EnterpriseUploadSafeFsPort,
} from "./enterprise-upload-policy.js";
import { loadDarwinWorkspaceBinding, type DarwinWorkspaceBinding } from "./darwin-workspace-fs.js";

const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const FILE_TYPE_MASK = 0o170000;
const REGULAR_FILE_TYPE = 0o100000;
const DIRECTORY_TYPE = 0o040000;
const NATIVE_NAME_ATTEMPTS = 3;

const AuthorizedWorkspaceSchema = EnterpriseResourceOwnerSchema.extend({
  workspaceId: z.string().min(1),
}).strict();

export interface DarwinEnterpriseUploadFileSystemOptions {
  readonly addonPath?: string;
  readonly capacity: number;
  readonly resolveCanonicalRoot: (workspace: AuthorizedWorkspace) => string | Promise<string>;
}

interface NativeIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
}

interface DescriptorRef {
  readonly descriptor: number;
  closed: boolean;
}

interface DirectoryStep {
  readonly descriptor: DescriptorRef;
  readonly parentDescriptor: DescriptorRef;
  readonly name: string;
  readonly identity: NativeIdentity;
  readonly created: boolean;
}

interface DirectoryChain {
  readonly parent: DescriptorRef;
  readonly steps: readonly DirectoryStep[];
}

interface UploadRecord {
  readonly capability: EnterpriseUploadCapability;
  readonly root: DescriptorRef;
  readonly chain: DirectoryChain;
  readonly staging: DescriptorRef;
  readonly stagingName: string;
  readonly destinationName: string;
  readonly fileIdentity: NativeIdentity;
  state: "active" | "finalized" | "published";
  written: number;
}

interface PrepareSnapshot {
  readonly workspace: AuthorizedWorkspace;
  readonly path: readonly string[];
  readonly signal: AbortSignal;
}

interface AppendSnapshot {
  readonly offset: number;
  readonly bytes: Uint8Array;
  readonly signal: AbortSignal;
}

export class DarwinEnterpriseUploadFileSystem implements EnterpriseUploadSafeFsPort {
  public readonly releaseReady: boolean;
  public readonly supportsDirectoryRelativeOperations: boolean;
  private readonly binding: DarwinWorkspaceBinding | null;
  private readonly capacity: number;
  private readonly resolveCanonicalRoot: (
    workspace: AuthorizedWorkspace,
  ) => string | Promise<string>;
  private readonly records = new Map<string, UploadRecord>();
  private reservations = 0;

  public constructor(options: DarwinEnterpriseUploadFileSystemOptions) {
    const capacity = options.capacity;
    const addonPath = options.addonPath;
    const resolveCanonicalRoot = options.resolveCanonicalRoot;
    if (
      !Number.isSafeInteger(capacity) ||
      capacity <= 0 ||
      capacity > ENTERPRISE_UPLOAD_CAPACITY_HARD_MAX ||
      (addonPath !== undefined && (typeof addonPath !== "string" || addonPath.length === 0)) ||
      typeof resolveCanonicalRoot !== "function"
    ) {
      throw new Error("Invalid Darwin enterprise upload configuration");
    }
    this.capacity = capacity;
    this.resolveCanonicalRoot = resolveCanonicalRoot;
    this.binding = loadDarwinWorkspaceBinding(addonPath);
    this.releaseReady = this.binding !== null;
    this.supportsDirectoryRelativeOperations = this.releaseReady;
  }

  public async prepare(input: {
    readonly workspace: AuthorizedWorkspace;
    readonly relativePath: string;
    readonly signal: AbortSignal;
  }): Promise<EnterpriseUploadCapability> {
    const request = snapshotPrepare(input);
    this.assertAvailable();
    assertNotAborted(request.signal);
    if (this.records.size + this.reservations >= this.capacity) {
      throw new Error("Enterprise upload capacity is exhausted");
    }
    this.reservations += 1;
    try {
      const rootPath = await this.resolveCanonicalRoot(request.workspace);
      assertNotAborted(request.signal);
      assertCanonicalRoot(rootPath);
      return this.prepareAtRoot(request, rootPath);
    } finally {
      this.reservations -= 1;
    }
  }

  public async append(
    capability: EnterpriseUploadCapability,
    input: {
      readonly offset: number;
      readonly bytes: Uint8Array;
      readonly signal: AbortSignal;
    },
  ): Promise<void> {
    const capabilitySnapshot = snapshotCapability(capability);
    const request = snapshotAppend(input);
    const record = this.requireRecord(capabilitySnapshot, "active");
    assertNotAborted(request.signal);
    if (request.offset !== record.written) throw new Error("Enterprise upload offset is invalid");
    if (!Number.isSafeInteger(request.offset + request.bytes.byteLength)) {
      throw new Error("Enterprise upload offset is invalid");
    }
    this.verifyRecord(record, record.stagingName);
    let written = 0;
    while (written < request.bytes.byteLength) {
      assertNotAborted(request.signal);
      const remaining = request.bytes.subarray(written);
      const count = this.bindingRequired().writeAt(
        record.staging.descriptor,
        remaining,
        request.offset + written,
      );
      if (!Number.isSafeInteger(count) || count <= 0 || count > remaining.byteLength) {
        throw new Error("Enterprise upload write made no forward progress");
      }
      written += count;
    }
    assertNotAborted(request.signal);
    const current = identityFromStats(fstatSync(record.staging.descriptor));
    assertRegularFile(current);
    assertSameEntry(current, record.fileIdentity);
    assertSameEntry(
      parseNativeIdentity(
        this.bindingRequired().statAt(record.chain.parent.descriptor, record.stagingName),
      ),
      record.fileIdentity,
    );
    const expectedSize = request.offset + request.bytes.byteLength;
    if (current.size !== expectedSize) throw new Error("Enterprise upload size changed");
    record.written = expectedSize;
  }

  public async finalize(
    capability: EnterpriseUploadCapability,
    options: { readonly signal: AbortSignal },
  ): Promise<EnterpriseUploadFinalizedTarget> {
    const capabilitySnapshot = snapshotCapability(capability);
    const signal = snapshotSignalOptions(options);
    const record = this.requireRecord(capabilitySnapshot, "active");
    assertNotAborted(signal);
    this.verifyRecord(record, record.stagingName);
    const binding = this.bindingRequired();
    binding.fsync(record.staging.descriptor);
    assertNotAborted(signal);
    this.verifyRecord(record, record.stagingName);
    record.state = "finalized";
    const finalIdentity = identityFromStats(fstatSync(record.staging.descriptor));
    assertRegularFile(finalIdentity);
    assertSameEntry(finalIdentity, record.fileIdentity);
    if (finalIdentity.size !== record.written) throw new Error("Enterprise upload size changed");
    return freezeFinalizedTarget(record.capability, finalIdentity);
  }

  public commit(capability: EnterpriseUploadCapability): true {
    const capabilitySnapshot = snapshotCapability(capability);
    const record = this.requireRecord(capabilitySnapshot, "finalized");
    this.verifyRecord(record, record.stagingName);
    const binding = this.bindingRequired();
    binding.renameAt(
      record.chain.parent.descriptor,
      record.stagingName,
      record.chain.parent.descriptor,
      record.destinationName,
      1,
    );
    record.state = "published";
    assertSameEntry(
      parseNativeIdentity(binding.statAt(record.chain.parent.descriptor, record.destinationName)),
      record.fileIdentity,
    );
    binding.fsync(record.chain.parent.descriptor);
    this.records.delete(record.capability.capabilityId);
    const failures = closeRecord(binding, record, false);
    throwFailures(failures, "Enterprise upload commit close failed");
    return true;
  }

  public async abort(capability: EnterpriseUploadCapability): Promise<void> {
    const capabilitySnapshot = snapshotCapability(capability);
    const record = this.records.get(capabilitySnapshot.capabilityId);
    if (!record) return;
    assertCapability(record.capability, capabilitySnapshot);
    this.records.delete(record.capability.capabilityId);
    const failures = closeRecord(this.bindingRequired(), record, true);
    throwFailures(failures, "Enterprise upload abort failed");
  }

  private prepareAtRoot(request: PrepareSnapshot, rootPath: string): EnterpriseUploadCapability {
    const binding = this.bindingRequired();
    const root = descriptorRef(binding.openRoot(rootPath));
    let chain: DirectoryChain | null = null;
    let staging: DescriptorRef | null = null;
    let stagingName = "";
    let stagingIdentity: NativeIdentity | null = null;
    let primary: unknown;
    try {
      const rootIdentity = identityFromStats(fstatSync(root.descriptor));
      assertDirectory(rootIdentity);
      assertNotAborted(request.signal);
      const parentPath = request.path.slice(0, -1);
      const destinationName = request.path.at(-1);
      if (!destinationName) throw new Error("Enterprise upload destination is invalid");
      chain = openDirectoryChain(binding, root, parentPath, request.signal);
      assertDestinationAbsent(binding, chain.parent, destinationName);
      const opened = createStagingFile(binding, chain.parent);
      staging = opened.descriptor;
      stagingName = opened.name;
      stagingIdentity = opened.identity;
      assertNotAborted(request.signal);
      const directoryIdentity = identityFromStats(fstatSync(chain.parent.descriptor));
      assertDirectory(directoryIdentity);
      const capability = freezeCapability({
        capabilityId: createCapabilityId(this.records),
        organizationId: request.workspace.organizationId,
        nodeId: request.workspace.nodeId,
        workspaceId: request.workspace.workspaceId,
        relativePath: request.path.join("/"),
        directoryIdentity: { dev: directoryIdentity.dev, ino: directoryIdentity.ino },
      });
      const record: UploadRecord = {
        capability,
        root,
        chain,
        staging,
        stagingName,
        destinationName,
        fileIdentity: stagingIdentity,
        state: "active",
        written: 0,
      };
      this.records.set(capability.capabilityId, record);
      return capability;
    } catch (error) {
      primary = error;
    }
    const failures = cleanupPartial(binding, root, chain, staging, stagingName, stagingIdentity);
    throwAggregate(primary, failures, "Enterprise upload preparation failed");
    throw new Error("Enterprise upload preparation failed");
  }

  private requireRecord(
    capability: EnterpriseUploadCapability,
    state: UploadRecord["state"],
  ): UploadRecord {
    this.assertAvailable();
    const record = this.records.get(capability.capabilityId);
    if (!record || record.state !== state)
      throw new Error("Enterprise upload capability is invalid");
    assertCapability(record.capability, capability);
    return record;
  }

  private verifyRecord(record: UploadRecord, entryName: string): void {
    verifyDirectoryChain(this.bindingRequired(), record.chain);
    const opened = identityFromStats(fstatSync(record.staging.descriptor));
    assertRegularFile(opened);
    assertSameEntry(opened, record.fileIdentity);
    const linked = parseNativeIdentity(
      this.bindingRequired().statAt(record.chain.parent.descriptor, entryName),
    );
    assertSameEntry(linked, record.fileIdentity);
  }

  private assertAvailable(): void {
    if (!this.binding) throw new Error("Darwin enterprise upload safe-FS is unavailable");
  }

  private bindingRequired(): DarwinWorkspaceBinding {
    const binding = this.binding;
    if (!binding) throw new Error("Darwin enterprise upload safe-FS is unavailable");
    return binding;
  }
}

function snapshotPrepare(input: {
  readonly workspace: AuthorizedWorkspace;
  readonly relativePath: string;
  readonly signal: AbortSignal;
}): PrepareSnapshot {
  const values = snapshotRecord(input, ["workspace", "relativePath", "signal"]);
  const workspaceValues = snapshotRecord(values.workspace, [
    "workspaceId",
    "organizationId",
    "nodeId",
    "ownerPrincipalId",
    "createdByPrincipalId",
  ]);
  const workspace = freezeWorkspace(AuthorizedWorkspaceSchema.parse(workspaceValues));
  const path = parseRelativePath(values.relativePath);
  const signal = requireAbortSignal(values.signal);
  return Object.freeze({ workspace, path, signal });
}

function snapshotAppend(input: {
  readonly offset: number;
  readonly bytes: Uint8Array;
  readonly signal: AbortSignal;
}): AppendSnapshot {
  const values = snapshotRecord(input, ["offset", "bytes", "signal"]);
  if (!Number.isSafeInteger(values.offset) || Number(values.offset) < 0) {
    throw new Error("Enterprise upload offset is invalid");
  }
  let bytes: Uint8Array;
  try {
    if (!(values.bytes instanceof Uint8Array)) throw new Error();
    bytes = Uint8Array.prototype.slice.call(values.bytes);
  } catch {
    throw new Error("Enterprise upload bytes are invalid");
  }
  if (bytes.byteLength > MAX_UPLOAD_CHUNK_BYTES) {
    throw new Error("Enterprise upload bytes are invalid");
  }
  return Object.freeze({
    offset: Number(values.offset),
    bytes,
    signal: requireAbortSignal(values.signal),
  });
}

function snapshotSignalOptions(options: { readonly signal: AbortSignal }): AbortSignal {
  return requireAbortSignal(snapshotRecord(options, ["signal"]).signal);
}

function snapshotCapability(input: EnterpriseUploadCapability): EnterpriseUploadCapability {
  const values = snapshotRecord(input, [
    "capabilityId",
    "organizationId",
    "nodeId",
    "workspaceId",
    "relativePath",
    "directoryIdentity",
  ]);
  const directory = snapshotRecord(values.directoryIdentity, ["dev", "ino"]);
  const strings = [
    values.capabilityId,
    values.organizationId,
    values.nodeId,
    values.workspaceId,
    values.relativePath,
  ];
  if (strings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Enterprise upload capability is invalid");
  }
  if (
    !Number.isSafeInteger(directory.dev) ||
    Number(directory.dev) < 0 ||
    !Number.isSafeInteger(directory.ino) ||
    Number(directory.ino) < 0
  ) {
    throw new Error("Enterprise upload capability is invalid");
  }
  return freezeCapability({
    capabilityId: String(values.capabilityId),
    organizationId: String(values.organizationId),
    nodeId: String(values.nodeId),
    workspaceId: String(values.workspaceId),
    relativePath: String(values.relativePath),
    directoryIdentity: { dev: Number(directory.dev), ino: Number(directory.ino) },
  });
}

function snapshotRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Invalid enterprise upload input");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new Error("Invalid enterprise upload input");
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const property = Reflect.getOwnPropertyDescriptor(value, key);
    if (!property || !property.enumerable || !("value" in property)) {
      throw new Error("Invalid enterprise upload input");
    }
    snapshot[key] = property.value;
  }
  return Object.freeze(snapshot);
}

function parseRelativePath(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")) {
    throw new Error("Enterprise upload path is invalid");
  }
  const components = value.split("/");
  if (components.some((component) => !isEntryName(component))) {
    throw new Error("Enterprise upload path is invalid");
  }
  return Object.freeze(components);
}

function isEntryName(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function requireAbortSignal(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal)) throw new Error("Enterprise upload signal is invalid");
  return value;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Enterprise upload operation was aborted");
}

function assertCanonicalRoot(root: unknown): asserts root is string {
  if (
    typeof root !== "string" ||
    !nodePath.isAbsolute(root) ||
    nodePath.normalize(root) !== root ||
    nodePath.parse(root).root === root ||
    root.includes("\0")
  ) {
    throw new Error("Enterprise workspace root is invalid");
  }
}

function openDirectoryChain(
  binding: DarwinWorkspaceBinding,
  root: DescriptorRef,
  path: readonly string[],
  signal: AbortSignal,
): DirectoryChain {
  const steps: DirectoryStep[] = [];
  let current = root;
  try {
    for (const name of path) {
      assertNotAborted(signal);
      const opened = openOrCreateDirectory(binding, current, name);
      const openedRef = descriptorRef(opened.descriptor);
      const identity = identityFromStats(fstatSync(openedRef.descriptor));
      assertDirectory(identity);
      assertSameEntry(parseNativeIdentity(binding.statAt(current.descriptor, name)), identity);
      const step = {
        descriptor: openedRef,
        parentDescriptor: current,
        name,
        identity,
        created: opened.created,
      };
      steps.push(step);
      if (opened.created) {
        binding.fsync(openedRef.descriptor);
        binding.fsync(current.descriptor);
      }
      current = openedRef;
    }
    return Object.freeze({ parent: current, steps: Object.freeze(steps) });
  } catch (error) {
    const chain = { parent: current, steps };
    const failures = closeDirectoryChain(binding, chain, true);
    throwAggregate(error, failures, "Enterprise upload directory traversal failed");
    throw error;
  }
}

function openOrCreateDirectory(
  binding: DarwinWorkspaceBinding,
  parent: DescriptorRef,
  name: string,
): { readonly descriptor: number; readonly created: boolean } {
  try {
    return Object.freeze({
      descriptor: openDirectory(binding, parent, name),
      created: false,
    });
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  let created = false;
  try {
    binding.mkdirAt(parent.descriptor, name, 0o700);
    created = true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  return Object.freeze({
    descriptor: openDirectory(binding, parent, name),
    created,
  });
}

function openDirectory(
  binding: DarwinWorkspaceBinding,
  parent: DescriptorRef,
  name: string,
): number {
  return binding.openAt(
    parent.descriptor,
    name,
    fileConstants.O_RDONLY | fileConstants.O_DIRECTORY,
    0,
  );
}

function assertDestinationAbsent(
  binding: DarwinWorkspaceBinding,
  parent: DescriptorRef,
  name: string,
): void {
  try {
    binding.statAt(parent.descriptor, name);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  throw new Error("Enterprise upload destination already exists");
}

function createStagingFile(
  binding: DarwinWorkspaceBinding,
  parent: DescriptorRef,
): {
  readonly descriptor: DescriptorRef;
  readonly name: string;
  readonly identity: NativeIdentity;
} {
  for (let attempt = 0; attempt < NATIVE_NAME_ATTEMPTS; attempt += 1) {
    const name = `.paseo-upload-${randomBytes(16).toString("hex")}.part`;
    try {
      const opened = descriptorRef(
        binding.openAt(
          parent.descriptor,
          name,
          fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_RDWR,
          0o600,
        ),
      );
      try {
        const identity = identityFromStats(fstatSync(opened.descriptor));
        assertRegularFile(identity);
        assertSameEntry(parseNativeIdentity(binding.statAt(parent.descriptor, name)), identity);
        return Object.freeze({ descriptor: opened, name, identity });
      } catch (error) {
        const failures: unknown[] = [];
        try {
          binding.unlinkAt(parent.descriptor, name, false);
          binding.fsync(parent.descriptor);
        } catch (unlinkError) {
          failures.push(unlinkError);
        }
        appendFailure(failures, closeDescriptor(binding, opened));
        throwAggregate(error, failures, "Upload open failed");
        throw error;
      }
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
  throw new Error("Enterprise upload staging name collision");
}

function verifyDirectoryChain(binding: DarwinWorkspaceBinding, chain: DirectoryChain): void {
  for (const step of chain.steps) {
    const linked = parseNativeIdentity(binding.statAt(step.parentDescriptor.descriptor, step.name));
    assertDirectory(linked);
    assertSameEntry(linked, step.identity);
  }
}

function cleanupPartial(
  binding: DarwinWorkspaceBinding,
  root: DescriptorRef,
  chain: DirectoryChain | null,
  staging: DescriptorRef | null,
  stagingName: string,
  stagingIdentity: NativeIdentity | null,
): unknown[] {
  const failures: unknown[] = [];
  if (chain && staging && stagingIdentity) {
    failures.push(...unlinkEntry(binding, chain.parent, stagingName, stagingIdentity));
  }
  if (staging) appendFailure(failures, closeDescriptor(binding, staging));
  if (chain) failures.push(...closeDirectoryChain(binding, chain, true));
  appendFailure(failures, closeDescriptor(binding, root));
  return failures;
}

function closeRecord(
  binding: DarwinWorkspaceBinding,
  record: UploadRecord,
  removeEntry: boolean,
): unknown[] {
  const failures: unknown[] = [];
  if (removeEntry) {
    const name = record.state === "published" ? record.destinationName : record.stagingName;
    failures.push(...unlinkEntry(binding, record.chain.parent, name, record.fileIdentity));
  }
  appendFailure(failures, closeDescriptor(binding, record.staging));
  failures.push(...closeDirectoryChain(binding, record.chain, removeEntry));
  appendFailure(failures, closeDescriptor(binding, record.root));
  return failures;
}

function unlinkEntry(
  binding: DarwinWorkspaceBinding,
  parent: DescriptorRef,
  name: string,
  expected: NativeIdentity,
): unknown[] {
  try {
    const current = parseNativeIdentity(binding.statAt(parent.descriptor, name));
    assertSameEntry(current, expected);
    binding.unlinkAt(parent.descriptor, name, false);
    binding.fsync(parent.descriptor);
    return [];
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    return [error];
  }
}

function closeDirectoryChain(
  binding: DarwinWorkspaceBinding,
  chain: DirectoryChain,
  removeCreated: boolean,
): unknown[] {
  const failures: unknown[] = [];
  for (let index = chain.steps.length - 1; index >= 0; index -= 1) {
    const step = chain.steps[index];
    if (!step) continue;
    appendFailure(failures, closeDescriptor(binding, step.descriptor));
    if (!removeCreated || !step.created) continue;
    try {
      const current = parseNativeIdentity(
        binding.statAt(step.parentDescriptor.descriptor, step.name),
      );
      assertSameEntry(current, step.identity);
      binding.unlinkAt(step.parentDescriptor.descriptor, step.name, true);
      binding.fsync(step.parentDescriptor.descriptor);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) failures.push(error);
    }
  }
  return failures;
}

function descriptorRef(value: number): DescriptorRef {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Darwin upload binding returned an invalid descriptor");
  }
  return { descriptor: value, closed: false };
}

function closeDescriptor(binding: DarwinWorkspaceBinding, reference: DescriptorRef): unknown {
  if (reference.closed) return undefined;
  reference.closed = true;
  try {
    binding.close(reference.descriptor);
    return undefined;
  } catch (error) {
    return error;
  }
}

function parseNativeIdentity(value: unknown): NativeIdentity {
  const record = snapshotRecord(value, ["dev", "ino", "mode", "size", "mtimeMs"]);
  const identity = {
    dev: Number(record.dev),
    ino: Number(record.ino),
    mode: Number(record.mode),
    size: Number(record.size),
    mtimeMs: Number(record.mtimeMs),
  };
  if (
    !Number.isSafeInteger(identity.dev) ||
    identity.dev < 0 ||
    !Number.isSafeInteger(identity.ino) ||
    identity.ino < 0 ||
    !Number.isSafeInteger(identity.mode) ||
    identity.mode < 0 ||
    !Number.isSafeInteger(identity.size) ||
    identity.size < 0 ||
    !Number.isFinite(identity.mtimeMs) ||
    identity.mtimeMs < 0
  ) {
    throw new Error("Darwin upload binding returned invalid identity");
  }
  return Object.freeze(identity);
}

function identityFromStats(stat: Stats): NativeIdentity {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
}

function assertRegularFile(identity: NativeIdentity): void {
  if ((identity.mode & FILE_TYPE_MASK) !== REGULAR_FILE_TYPE) {
    throw new Error("Enterprise upload entry is not a regular file");
  }
}

function assertDirectory(identity: NativeIdentity): void {
  if ((identity.mode & FILE_TYPE_MASK) !== DIRECTORY_TYPE) {
    throw new Error("Enterprise upload path is not a directory");
  }
}

function assertSameEntry(actual: NativeIdentity, expected: NativeIdentity): void {
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    (actual.mode & FILE_TYPE_MASK) !== (expected.mode & FILE_TYPE_MASK)
  ) {
    throw new Error("Enterprise upload entry identity changed");
  }
}

function assertCapability(
  expected: EnterpriseUploadCapability,
  actual: EnterpriseUploadCapability,
): void {
  if (
    expected.capabilityId !== actual.capabilityId ||
    expected.organizationId !== actual.organizationId ||
    expected.nodeId !== actual.nodeId ||
    expected.workspaceId !== actual.workspaceId ||
    expected.relativePath !== actual.relativePath ||
    expected.directoryIdentity.dev !== actual.directoryIdentity.dev ||
    expected.directoryIdentity.ino !== actual.directoryIdentity.ino
  ) {
    throw new Error("Enterprise upload capability is invalid");
  }
}

function createCapabilityId(records: ReadonlyMap<string, UploadRecord>): string {
  for (let attempt = 0; attempt < NATIVE_NAME_ATTEMPTS; attempt += 1) {
    const capabilityId = randomBytes(32).toString("base64url");
    if (!records.has(capabilityId)) return capabilityId;
  }
  throw new Error("Enterprise upload capability collision");
}

function freezeWorkspace(value: AuthorizedWorkspace): AuthorizedWorkspace {
  return Object.freeze({
    workspaceId: value.workspaceId,
    organizationId: value.organizationId,
    nodeId: value.nodeId,
    ownerPrincipalId: value.ownerPrincipalId,
    createdByPrincipalId: value.createdByPrincipalId,
  });
}

function freezeCapability(value: EnterpriseUploadCapability): EnterpriseUploadCapability {
  return Object.freeze({
    capabilityId: value.capabilityId,
    organizationId: value.organizationId,
    nodeId: value.nodeId,
    workspaceId: value.workspaceId,
    relativePath: value.relativePath,
    directoryIdentity: Object.freeze({
      dev: value.directoryIdentity.dev,
      ino: value.directoryIdentity.ino,
    }),
  });
}

function freezeFinalizedTarget(
  capability: EnterpriseUploadCapability,
  identity: NativeIdentity,
): EnterpriseUploadFinalizedTarget {
  return Object.freeze({
    ...freezeCapability(capability),
    fileIdentity: Object.freeze({
      dev: identity.dev,
      ino: identity.ino,
      size: identity.size,
      mtimeMs: identity.mtimeMs,
    }),
  });
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function appendFailure(failures: unknown[], failure: unknown): void {
  if (failure !== undefined) failures.push(failure);
}

function throwFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, message, { cause: failures[0] });
  }
}

function throwAggregate(primary: unknown, failures: readonly unknown[], message: string): void {
  if (primary !== undefined && failures.length === 0) throw primary;
  if (primary !== undefined) {
    throw new AggregateError([primary, ...failures], message, { cause: primary });
  }
  throwFailures(failures, message);
}
