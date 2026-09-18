import {
  FileTransferOpcode,
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  GlobalResourceRefSchema,
  type AuthorizedWorkspace,
  type GlobalResourceRef,
  type PrincipalContext,
} from "@getpaseo/protocol/messages";
import {
  closeActiveDaemonPermission,
  isActiveDaemonPermissionCurrent,
  isSessionAuthorization,
  issueActiveDaemonPermission,
  type ActiveDaemonPermission,
  type SessionAuthorization,
} from "../../authorization/index.js";
import type {
  EnterpriseAdmissionAuthorizationHandle,
  EnterpriseAdmissionAuthorizationIssuer,
} from "../identity/admission-authorization.js";
import type { ProductionAuditCapability } from "../audit/production-audit-runtime.js";
import type { GrantStore } from "./grant-store.js";
import {
  getAuthoritativeAgent,
  getAuthoritativeWorkspace,
  isOwnerRegistry,
  type OwnerRegistry,
} from "./owner-registry.js";
import {
  resolveProductionAuthorizationAuthority,
  type ResolvedProductionAuthorizationAuthority,
} from "./production-authorization-authority.js";
import { ResourceAuthorizationService } from "./resource-authorization.js";

declare const canonicalFileTransferFrameBrand: unique symbol;
declare const activeFileDownloadStreamHandleBrand: unique symbol;
declare const authorizedFileBinaryEmissionBrand: unique symbol;

export interface CanonicalFileTransferFrame {
  readonly [canonicalFileTransferFrameBrand]: true;
}

export interface ActiveFileDownloadStreamHandle {
  readonly [activeFileDownloadStreamHandleBrand]: true;
}

export interface AuthorizedFileBinaryEmission {
  readonly [authorizedFileBinaryEmissionBrand]: true;
}

export type FileBinaryCloseReason =
  | "complete"
  | "cancel"
  | "read_failed"
  | "send_failed"
  | "revoked"
  | "permission_replaced"
  | "session_release"
  | "authorization_failed"
  | "limit_exceeded";

export const FILE_BINARY_MAX_ACTIVE_STREAMS = 64;

export interface FileBinaryOutboundAuthorizerDependencies {
  readonly admissionAuthorizationIssuer: EnterpriseAdmissionAuthorizationIssuer;
  readonly admissionAuthorizationHandle: EnterpriseAdmissionAuthorizationHandle;
  readonly grantStore: GrantStore;
  readonly audit: ProductionAuditCapability;
  readonly sessionAuthorization: SessionAuthorization;
  readonly owners: OwnerRegistry;
}

export interface OpenFileBinaryStreamInput {
  readonly resource: GlobalResourceRef;
  readonly frame: CanonicalFileTransferFrame;
}

export interface AuthorizeNextFileBinaryFrameInput {
  readonly stream: ActiveFileDownloadStreamHandle;
  readonly frame: CanonicalFileTransferFrame;
}

interface CanonicalFrameState {
  authorizer: FileBinaryOutboundAuthorizer | null;
  readonly frame: FileTransferFrame;
  readonly bytes: Uint8Array;
}

type StreamPhase =
  | "authorizing_begin"
  | "begin_pending"
  | "open"
  | "authorizing_chunk"
  | "chunk_pending"
  | "authorizing_end"
  | "end_pending"
  | "closed";

interface StreamState {
  readonly authorizer: FileBinaryOutboundAuthorizer;
  readonly stream: ActiveFileDownloadStreamHandle;
  readonly principal: PrincipalContext;
  readonly authority: ResolvedProductionAuthorizationAuthority;
  readonly permission: ActiveDaemonPermission;
  readonly resource: Extract<GlobalResourceRef, { resourceKind: "workspace" }>;
  readonly requestId: string;
  readonly declaredSize: number;
  authorizedWorkspace: AuthorizedWorkspace | null;
  deliveredSize: number;
  phase: StreamPhase;
}

interface EmissionState {
  readonly authorizer: FileBinaryOutboundAuthorizer;
  readonly streamState: StreamState;
  readonly frame: CanonicalFrameState;
  readonly phase: "begin_pending" | "chunk_pending" | "end_pending";
}

const canonicalFrames = new WeakMap<object, CanonicalFrameState>();
const streamStates = new WeakMap<object, StreamState>();
const emissionStates = new WeakMap<object, EmissionState>();

const DEPENDENCY_KEYS = new Set([
  "admissionAuthorizationIssuer",
  "admissionAuthorizationHandle",
  "grantStore",
  "audit",
  "sessionAuthorization",
  "owners",
]);
const OPEN_INPUT_KEYS = new Set(["resource", "frame"]);
const NEXT_INPUT_KEYS = new Set(["stream", "frame"]);
const RESOURCE_KEYS = new Set(["organizationId", "nodeId", "resourceKind", "localResourceId"]);

const CLOSE_REASONS = new Set<FileBinaryCloseReason>([
  "complete",
  "cancel",
  "read_failed",
  "send_failed",
  "revoked",
  "permission_replaced",
  "session_release",
  "authorization_failed",
  "limit_exceeded",
]);

export function canonicalizeFileTransferFrame(
  encoded: Uint8Array,
): CanonicalFileTransferFrame | null {
  try {
    if (!(encoded instanceof Uint8Array)) return null;
    const bytes = new Uint8Array(encoded);
    const frame = decodeFileTransferFrame(bytes);
    if (!frame) return null;
    const canonical = reencode(frame);
    if (!sameBytes(bytes, canonical)) return null;
    const token = Object.freeze(Object.create(null)) as CanonicalFileTransferFrame;
    canonicalFrames.set(token as object, {
      authorizer: null,
      frame: cloneFrame(frame),
      bytes: new Uint8Array(canonical),
    });
    return token;
  } catch {
    return null;
  }
}

export class FileBinaryOutboundAuthorizer {
  private readonly authority: ResolvedProductionAuthorizationAuthority;
  private readonly sessionAuthorization: SessionAuthorization;
  private readonly owners: OwnerRegistry;
  private readonly resourceAuthorization: ResourceAuthorizationService;
  private readonly activeStreams = new Set<StreamState>();
  #closed = false;

  private constructor(
    authority: ResolvedProductionAuthorizationAuthority,
    sessionAuthorization: SessionAuthorization,
    owners: OwnerRegistry,
    resourceAuthorization: ResourceAuthorizationService,
  ) {
    this.authority = authority;
    this.sessionAuthorization = sessionAuthorization;
    this.owners = owners;
    this.resourceAuthorization = resourceAuthorization;
    Object.freeze(this);
  }

  static async create(
    input: FileBinaryOutboundAuthorizerDependencies,
  ): Promise<FileBinaryOutboundAuthorizer | null> {
    try {
      if (!hasOnlyDataProperties(input, DEPENDENCY_KEYS)) return null;
      const dependencies = Object.freeze({
        admissionAuthorizationIssuer: dataProperty(
          input,
          "admissionAuthorizationIssuer",
        ) as EnterpriseAdmissionAuthorizationIssuer,
        admissionAuthorizationHandle: dataProperty(
          input,
          "admissionAuthorizationHandle",
        ) as EnterpriseAdmissionAuthorizationHandle,
        grantStore: dataProperty(input, "grantStore") as GrantStore,
        audit: dataProperty(input, "audit") as ProductionAuditCapability,
        sessionAuthorization: dataProperty(input, "sessionAuthorization") as SessionAuthorization,
        owners: dataProperty(input, "owners") as OwnerRegistry,
      });
      if (
        !isSessionAuthorization(dependencies.sessionAuthorization) ||
        !isOwnerRegistry(dependencies.owners)
      ) {
        return null;
      }
      const authority = await resolveProductionAuthorizationAuthority({
        admissionAuthorizationIssuer: dependencies.admissionAuthorizationIssuer,
        admissionAuthorizationHandle: dependencies.admissionAuthorizationHandle,
        grantStore: dependencies.grantStore,
        audit: dependencies.audit,
      });
      if (!authority?.grantVersionGuard.isCurrent(authority.principal)) return null;
      const resourceAuthorization = new ResourceAuthorizationService({
        owners: Object.freeze({
          getWorkspace: (workspaceId: string) =>
            getAuthoritativeWorkspace(dependencies.owners, workspaceId),
          getAgent: (agentId: string) => getAuthoritativeAgent(dependencies.owners, agentId),
        }),
        nodeId: authority.node.nodeId,
        grantVersionGuard: authority.grantVersionGuard,
      });
      return new FileBinaryOutboundAuthorizer(
        authority,
        dependencies.sessionAuthorization,
        dependencies.owners,
        resourceAuthorization,
      );
    } catch {
      return null;
    }
  }

  canonicalizeFrame(encoded: Uint8Array): CanonicalFileTransferFrame | null {
    if (this.#closed || !this.isAuthorityCurrent()) return null;
    return canonicalizeFileTransferFrame(encoded);
  }

  async open(input: OpenFileBinaryStreamInput): Promise<{
    readonly stream: ActiveFileDownloadStreamHandle;
    readonly emission: AuthorizedFileBinaryEmission;
  } | null> {
    let frame: CanonicalFrameState | null = null;
    let state: StreamState | null = null;
    try {
      frame = this.claimFrame(dataProperty(input, "frame") as CanonicalFileTransferFrame);
      if (!hasOnlyDataProperties(input, OPEN_INPUT_KEYS)) return null;
      if (!frame || frame.frame.opcode !== FileTransferOpcode.FileBegin) return null;
      const resource = canonicalWorkspaceResource(dataProperty(input, "resource"));
      if (!resource || this.#closed || this.activeStreams.size >= FILE_BINARY_MAX_ACTIVE_STREAMS) {
        return null;
      }
      if (!Number.isSafeInteger(frame.frame.metadata.size)) return null;
      const permission = issueActiveDaemonPermission(this.sessionAuthorization, "workspace.read");
      if (!permission || !this.isAuthorityCurrent()) {
        if (permission) {
          closeActiveDaemonPermission(this.sessionAuthorization, permission);
        }
        return null;
      }
      const stream = Object.freeze(Object.create(null)) as ActiveFileDownloadStreamHandle;
      state = {
        authorizer: this,
        stream,
        principal: this.authority.principal,
        authority: this.authority,
        permission,
        resource,
        requestId: frame.frame.requestId,
        declaredSize: frame.frame.metadata.size,
        authorizedWorkspace: null,
        deliveredSize: 0,
        phase: "authorizing_begin",
      };
      streamStates.set(stream as object, state);
      this.activeStreams.add(state);
      if (!(await this.authorizeWorkspace(state, "authorizing_begin"))) return null;
      state.phase = "begin_pending";
      return deepFreeze({ stream, emission: this.issueEmission(state, frame, "begin_pending") });
    } catch {
      if (state) this.closeState(state);
      return null;
    }
  }

  authorizeNext(
    input: AuthorizeNextFileBinaryFrameInput,
  ): Promise<AuthorizedFileBinaryEmission | null> {
    let frame: CanonicalFrameState | null;
    let stream: ActiveFileDownloadStreamHandle;
    try {
      frame = this.claimFrame(dataProperty(input, "frame") as CanonicalFileTransferFrame);
      if (!hasOnlyDataProperties(input, NEXT_INPUT_KEYS)) return Promise.resolve(null);
      stream = dataProperty(input, "stream") as ActiveFileDownloadStreamHandle;
    } catch {
      return Promise.resolve(null);
    }
    const state = this.lookupStream(stream);
    if (!state || !frame) {
      if (state) this.closeState(state);
      return Promise.resolve(null);
    }
    if (state.phase !== "open") return Promise.resolve(null);
    if (
      frame.authorizer !== this ||
      frame.frame.requestId !== state.requestId ||
      (frame.frame.opcode !== FileTransferOpcode.FileChunk &&
        frame.frame.opcode !== FileTransferOpcode.FileEnd) ||
      !this.isStreamCurrent(state)
    ) {
      this.closeState(state);
      return Promise.resolve(null);
    }
    if (
      frame.frame.opcode === FileTransferOpcode.FileChunk &&
      state.deliveredSize + frame.frame.payload.byteLength > state.declaredSize
    ) {
      this.closeState(state);
      return Promise.resolve(null);
    }
    if (
      frame.frame.opcode === FileTransferOpcode.FileEnd &&
      state.deliveredSize !== state.declaredSize
    ) {
      this.closeState(state);
      return Promise.resolve(null);
    }
    state.phase =
      frame.frame.opcode === FileTransferOpcode.FileChunk ? "authorizing_chunk" : "authorizing_end";
    return this.authorizeNextSerial(state, frame);
  }

  consumeForDelivery(
    stream: ActiveFileDownloadStreamHandle,
    emission: AuthorizedFileBinaryEmission,
  ): Uint8Array | null {
    let issued: EmissionState | undefined;
    try {
      if ((typeof emission !== "object" && typeof emission !== "function") || emission === null) {
        return null;
      }
      issued = emissionStates.get(emission as object);
      if (!issued) return null;
      emissionStates.delete(emission as object);
      if (
        issued.authorizer !== this ||
        issued.streamState.stream !== stream ||
        issued.streamState.phase !== issued.phase ||
        !this.isDeliveryCurrent(issued.streamState)
      ) {
        this.closeState(issued.streamState);
        return null;
      }
      const state = issued.streamState;
      const output = new Uint8Array(issued.frame.bytes);
      if (issued.phase === "begin_pending") {
        state.phase = "open";
      } else if (issued.phase === "chunk_pending") {
        state.deliveredSize += issued.frame.frame.payload.byteLength;
        state.phase = "open";
      } else {
        this.closeState(state);
      }
      return output;
    } catch {
      if (issued) this.closeState(issued.streamState);
      return null;
    }
  }

  close(stream: ActiveFileDownloadStreamHandle, reason: FileBinaryCloseReason): boolean {
    try {
      if (!CLOSE_REASONS.has(reason)) return false;
      const state = this.lookupStream(stream);
      if (!state) return false;
      this.closeState(state);
      return true;
    } catch {
      return false;
    }
  }

  closeAll(reason: Extract<FileBinaryCloseReason, "revoked" | "session_release">): void {
    if (reason !== "revoked" && reason !== "session_release") return;
    this.#closed = true;
    for (const state of this.activeStreams) this.closeState(state);
  }

  private async authorizeNextSerial(
    state: StreamState,
    frame: CanonicalFrameState,
  ): Promise<AuthorizedFileBinaryEmission | null> {
    try {
      const authorizingPhase =
        frame.frame.opcode === FileTransferOpcode.FileChunk
          ? "authorizing_chunk"
          : "authorizing_end";
      if (!(await this.authorizeWorkspace(state, authorizingPhase))) return null;
      const pendingPhase =
        frame.frame.opcode === FileTransferOpcode.FileChunk ? "chunk_pending" : "end_pending";
      state.phase = pendingPhase;
      return this.issueEmission(state, frame, pendingPhase);
    } catch {
      this.closeState(state);
      return null;
    }
  }

  private async authorizeWorkspace(
    state: StreamState,
    expectedPhase: StreamPhase,
  ): Promise<boolean> {
    if (state.phase !== expectedPhase || !this.isStreamCurrent(state)) {
      this.closeState(state);
      return false;
    }
    const authorized = await ResourceAuthorizationService.prototype.assertWorkspace.call(
      this.resourceAuthorization,
      state.principal,
      "workspace.content.read",
      state.resource.localResourceId,
    );
    const current = getAuthoritativeWorkspace(this.owners, state.resource.localResourceId);
    if (
      state.phase !== expectedPhase ||
      !this.isStreamCurrent(state) ||
      !current ||
      !workspaceMatchesResource(authorized, state.resource) ||
      !workspaceMatchesResource(current, state.resource) ||
      !workspaceIdentityMatches(authorized, current)
    ) {
      this.closeState(state);
      return false;
    }
    state.authorizedWorkspace = freezeWorkspace(current);
    return true;
  }

  private issueEmission(
    state: StreamState,
    frame: CanonicalFrameState,
    phase: EmissionState["phase"],
  ): AuthorizedFileBinaryEmission {
    const emission = Object.freeze(Object.create(null)) as AuthorizedFileBinaryEmission;
    emissionStates.set(emission as object, { authorizer: this, streamState: state, frame, phase });
    return emission;
  }

  private claimFrame(frame: CanonicalFileTransferFrame): CanonicalFrameState | null {
    try {
      if ((typeof frame !== "object" && typeof frame !== "function") || frame === null) {
        return null;
      }
      const issued = canonicalFrames.get(frame as object);
      if (!issued) return null;
      canonicalFrames.delete(frame as object);
      if (issued.authorizer !== null && issued.authorizer !== this) return null;
      issued.authorizer = this;
      return issued;
    } catch {
      return null;
    }
  }

  private lookupStream(stream: ActiveFileDownloadStreamHandle): StreamState | null {
    try {
      if ((typeof stream !== "object" && typeof stream !== "function") || stream === null) {
        return null;
      }
      const state = streamStates.get(stream as object);
      return state?.authorizer === this ? state : null;
    } catch {
      return null;
    }
  }

  private isAuthorityCurrent(): boolean {
    return this.authority.grantVersionGuard.isCurrent(this.authority.principal);
  }

  private isStreamCurrent(state: StreamState): boolean {
    return (
      !this.#closed &&
      state.phase !== "closed" &&
      this.isAuthorityCurrent() &&
      isActiveDaemonPermissionCurrent(this.sessionAuthorization, state.permission, "workspace.read")
    );
  }

  private isDeliveryCurrent(state: StreamState): boolean {
    if (!this.isStreamCurrent(state) || !state.authorizedWorkspace) return false;
    const current = getAuthoritativeWorkspace(this.owners, state.resource.localResourceId);
    return Boolean(
      current &&
      workspaceMatchesResource(current, state.resource) &&
      workspaceIdentityMatches(state.authorizedWorkspace, current),
    );
  }

  private closeState(state: StreamState): void {
    if (state.authorizer !== this) {
      state.authorizer.closeState(state);
      return;
    }
    if (state.phase === "closed") return;
    state.phase = "closed";
    this.activeStreams.delete(state);
    streamStates.delete(state.stream as object);
    closeActiveDaemonPermission(this.sessionAuthorization, state.permission);
  }
}

function workspaceMatchesResource(
  workspace: AuthorizedWorkspace,
  resource: Extract<GlobalResourceRef, { resourceKind: "workspace" }>,
): boolean {
  return (
    workspace.workspaceId === resource.localResourceId &&
    workspace.organizationId === resource.organizationId &&
    workspace.nodeId === resource.nodeId
  );
}

function workspaceIdentityMatches(left: AuthorizedWorkspace, right: AuthorizedWorkspace): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.organizationId === right.organizationId &&
    left.nodeId === right.nodeId &&
    left.ownerPrincipalId === right.ownerPrincipalId &&
    left.createdByPrincipalId === right.createdByPrincipalId
  );
}

function freezeWorkspace(workspace: AuthorizedWorkspace): AuthorizedWorkspace {
  return Object.freeze({
    workspaceId: workspace.workspaceId,
    organizationId: workspace.organizationId,
    nodeId: workspace.nodeId,
    ownerPrincipalId: workspace.ownerPrincipalId,
    createdByPrincipalId: workspace.createdByPrincipalId,
  });
}

function canonicalWorkspaceResource(
  input: unknown,
): Extract<GlobalResourceRef, { resourceKind: "workspace" }> | null {
  try {
    if (!hasOnlyDataProperties(input, RESOURCE_KEYS)) return null;
    const parsed = GlobalResourceRefSchema.parse({
      organizationId: dataProperty(input, "organizationId"),
      nodeId: dataProperty(input, "nodeId"),
      resourceKind: dataProperty(input, "resourceKind"),
      localResourceId: dataProperty(input, "localResourceId"),
    });
    if (parsed.resourceKind !== "workspace") return null;
    return deepFreeze({ ...parsed });
  } catch {
    return null;
  }
}

function cloneFrame(frame: FileTransferFrame): FileTransferFrame {
  if (frame.opcode === FileTransferOpcode.FileBegin) {
    return {
      opcode: frame.opcode,
      requestId: frame.requestId,
      metadata: deepFreeze({ ...frame.metadata }),
      payload: new Uint8Array(),
    };
  }
  return {
    opcode: frame.opcode,
    requestId: frame.requestId,
    payload: new Uint8Array(frame.payload),
  };
}

function reencode(frame: FileTransferFrame): Uint8Array {
  if (frame.opcode === FileTransferOpcode.FileBegin) {
    return encodeFileTransferFrame({
      opcode: frame.opcode,
      requestId: frame.requestId,
      metadata: frame.metadata,
    });
  }
  if (frame.opcode === FileTransferOpcode.FileChunk) {
    return encodeFileTransferFrame({
      opcode: frame.opcode,
      requestId: frame.requestId,
      payload: frame.payload,
    });
  }
  return encodeFileTransferFrame({ opcode: frame.opcode, requestId: frame.requestId });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function hasOnlyDataProperties(input: unknown, allowed: ReadonlySet<string>): input is object {
  try {
    if (typeof input !== "object" || input === null) return false;
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return false;
    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function dataProperty(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new Error("binary dependencies must use enumerable data properties");
  }
  return descriptor.value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) {
      if (!(child instanceof Uint8Array)) deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
