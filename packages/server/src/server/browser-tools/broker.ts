import { randomUUID } from "node:crypto";
import {
  BROWSER_AUTOMATION_COMMAND_NAMES,
  BrowserAutomationCommandSchema,
  BrowserAutomationExecuteRequestSchema,
  BrowserAutomationExecuteResponseSchema,
  type BrowserAutomationCommand,
  type BrowserAutomationCommandName,
  type BrowserAutomationEnterpriseContext,
  type BrowserAutomationExecuteRequest,
  type BrowserAutomationExecuteResponse,
  type BrowserAutomationResult,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  BrowserProfileRecordSchema,
  EnterpriseResourceOwnerSchema,
  type AuthorizedWorkspace,
  type FencedLease,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { EnterpriseAgentContextHandle } from "../session/enterprise-agent-session-context-registry.js";
import type {
  BrowserProfileLeaseAccessInput,
  BrowserProfileLeaseAcquireInput,
  BrowserProfileLeaseAttachHostInput,
  BrowserProfileLeaseAuthorization,
} from "../enterprise/browser/lease-manager.js";
import { browserToolsFailure, type BrowserToolsResponsePayload } from "./errors.js";

export interface BrowserHostClient {
  /** Opaque server-assigned registration identity. Never sourced from a host payload. */
  id: string;
  hostKind: string;
  supportedCommands: readonly BrowserAutomationCommandName[];
  enterpriseProfiles?: { version: 1 };
  /** Trusted execution node from the authenticated Session context. */
  homeNodeId?: string;
  sendBrowserAutomationRequest(request: BrowserAutomationExecuteRequest): void | Promise<void>;
}

export interface BrowserToolsExecuteInput {
  command: BrowserAutomationCommand;
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
  requestId?: string;
  timeoutMs?: number;
}

export interface EnterpriseBrowserToolsExecuteInput {
  handle: EnterpriseAgentContextHandle;
  command: BrowserAutomationCommand;
}

export interface EnterpriseBrowserProfileHostBindingInput {
  handle: EnterpriseAgentContextHandle;
  hostClientId: string;
}

export interface EnterpriseBrowserProfileLeasePort {
  acquire(input: BrowserProfileLeaseAcquireInput): Promise<FencedLease>;
  attachHost(input: BrowserProfileLeaseAttachHostInput): Promise<void>;
  validateLease(input: BrowserProfileLeaseAccessInput): Promise<FencedLease>;
  releaseLease(input: BrowserProfileLeaseAccessInput): Promise<void>;
  invalidateHost(hostClientId: string): Promise<void>;
}

export interface EnterpriseBrowserToolsRuntime {
  isCurrentHandle(handle: EnterpriseAgentContextHandle): boolean;
  resolveAuthorization(
    handle: EnterpriseAgentContextHandle,
  ): BrowserProfileLeaseAuthorization | Promise<BrowserProfileLeaseAuthorization>;
  leases: EnterpriseBrowserProfileLeasePort;
  leaseTtlMs: number;
}

interface PendingBrowserToolsRequest {
  clientId: string;
  request: BrowserAutomationExecuteRequest;
  enterpriseAuthorization?: BrowserProfileLeaseAuthorization;
  rememberAffinity: boolean;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (payload: BrowserToolsResponsePayload) => void;
}

interface RegisteredBrowserHost {
  id: string;
  hostKind: string;
  sendBrowserAutomationRequest(request: BrowserAutomationExecuteRequest): void | Promise<void>;
  enterpriseProfiles?: Readonly<{ version: 1 }>;
  homeNodeId?: string;
  registeredAt: number;
  supportedCommands: ReadonlySet<BrowserAutomationCommandName>;
  ready: Promise<boolean>;
}

export interface BrowserToolsBrokerOptions {
  defaultTimeoutMs?: number;
  createRequestId?: () => string;
  enterprise?: EnterpriseBrowserToolsRuntime;
  onHostTeardownError?: (error: Error, hostClientId: string) => void;
}

interface EnterpriseRuntimeSnapshot {
  readonly isCurrentHandle: EnterpriseBrowserToolsRuntime["isCurrentHandle"];
  readonly resolveAuthorization: EnterpriseBrowserToolsRuntime["resolveAuthorization"];
  readonly acquire: EnterpriseBrowserProfileLeasePort["acquire"];
  readonly attachHost: EnterpriseBrowserProfileLeasePort["attachHost"];
  readonly validateLease: EnterpriseBrowserProfileLeasePort["validateLease"];
  readonly releaseLease: EnterpriseBrowserProfileLeasePort["releaseLease"];
  readonly invalidateHost: EnterpriseBrowserProfileLeasePort["invalidateHost"];
  readonly leaseTtlMs: number;
}

interface EnterpriseHandleAuthoritySnapshot {
  readonly agentId: string;
  readonly organizationId: string;
  readonly nodeId: string;
  readonly principalId: string;
}

const DEFAULT_BROWSER_TOOLS_TIMEOUT_MS = 15_000;
const MAX_REQUEST_ID_ALLOCATION_ATTEMPTS = 16;
const BROWSER_HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NODE_ID_PATTERN = /^nod_[0-9a-f]{16}$/;
const SUPPORTED_BROWSER_COMMANDS = new Set<BrowserAutomationCommandName>(
  BROWSER_AUTOMATION_COMMAND_NAMES,
);
const AuthorizedWorkspaceSchema = EnterpriseResourceOwnerSchema.extend({
  workspaceId: z.string().min(1),
}).strict();
const BrowserProfileLeaseAuthorizationSchema = z
  .object({
    workspace: AuthorizedWorkspaceSchema,
    agent: EnterpriseResourceOwnerSchema.extend({
      agentId: z.string().min(1),
      workspaceId: z.string().min(1),
    }).strict(),
    profile: BrowserProfileRecordSchema.strict(),
    bindingRevision: z.string().min(1),
  })
  .strict();

export class BrowserToolsBroker {
  private readonly defaultTimeoutMs: number;
  private readonly createRequestId: () => string;
  private readonly enterpriseRuntime: EnterpriseRuntimeSnapshot | null;
  private readonly onHostTeardownError: (error: Error, hostClientId: string) => void;
  private readonly clients = new Map<string, RegisteredBrowserHost>();
  private readonly pending = new Map<string, PendingBrowserToolsRequest>();
  private readonly browserHostByBrowserId = new Map<string, string>();
  private readonly strandedBrowserHostByBrowserId = new Map<string, string>();
  private readonly enterpriseBrowserHostByAffinity = new Map<string, string>();
  private readonly enterpriseBrowserHostByProfile = new Map<string, string>();
  private readonly liveRequestIds = new Set<string>();
  private readonly hostTeardownBarriers = new Map<string, Promise<void>>();
  private readonly readyHosts = new WeakSet<RegisteredBrowserHost>();
  private registrationSequence = 0;

  public constructor(options: BrowserToolsBrokerOptions) {
    const defaultTimeoutMs = options.defaultTimeoutMs;
    const createRequestId = options.createRequestId ?? (() => `browser_${randomUUID()}`);
    const enterprise = options.enterprise;
    const onHostTeardownError = options.onHostTeardownError;
    this.defaultTimeoutMs = defaultTimeoutMs ?? DEFAULT_BROWSER_TOOLS_TIMEOUT_MS;
    this.createRequestId = () => createRequestId();
    this.onHostTeardownError = onHostTeardownError ?? (() => {});
    const enterpriseLeaseTtlMs = enterprise?.leaseTtlMs;
    if (enterprise && (!Number.isSafeInteger(enterpriseLeaseTtlMs) || enterpriseLeaseTtlMs! <= 0)) {
      throw new Error("Enterprise Browser Profile lease TTL must be a positive safe integer.");
    }
    if (enterprise) {
      const isCurrentHandle = enterprise.isCurrentHandle.bind(enterprise);
      const resolveAuthorization = enterprise.resolveAuthorization.bind(enterprise);
      const leases = enterprise.leases;
      const acquire = leases.acquire.bind(leases);
      const attachHost = leases.attachHost.bind(leases);
      const validateLease = leases.validateLease.bind(leases);
      const releaseLease = leases.releaseLease.bind(leases);
      const invalidateHost = leases.invalidateHost.bind(leases);
      this.enterpriseRuntime = Object.freeze({
        isCurrentHandle: (handle: EnterpriseAgentContextHandle) => isCurrentHandle(handle),
        resolveAuthorization: (handle: EnterpriseAgentContextHandle) =>
          resolveAuthorization(handle),
        acquire,
        attachHost,
        validateLease,
        releaseLease,
        invalidateHost,
        leaseTtlMs: enterpriseLeaseTtlMs!,
      });
    } else {
      this.enterpriseRuntime = null;
    }
  }

  public registerClient(client: BrowserHostClient): () => void {
    const snapshot = snapshotBrowserHostClient(client);
    const existing = this.clients.get(snapshot.id);
    if (existing) {
      this.detachRegisteredClient(existing);
      this.beginHostTeardown(snapshot.id);
    }
    const teardownBarrier = this.hostTeardownBarriers.get(snapshot.id);
    const registeredAt = ++this.registrationSequence;
    let host!: RegisteredBrowserHost;
    const ready = teardownBarrier
      ? teardownBarrier.then(
          () => {
            if (this.clients.get(snapshot.id) !== host) {
              return false;
            }
            this.readyHosts.add(host);
            return true;
          },
          () => {
            if (this.clients.get(snapshot.id) === host) {
              this.clients.delete(snapshot.id);
            }
            return false;
          },
        )
      : Promise.resolve(true);
    host = Object.freeze({
      ...snapshot,
      registeredAt,
      ready,
    });
    this.clients.set(snapshot.id, host);
    if (!teardownBarrier) {
      this.readyHosts.add(host);
    }
    return () => this.unregisterClient(snapshot.id, registeredAt);
  }

  public unregisterClient(clientId: string, registeredAt?: number): void {
    const current = this.clients.get(clientId);
    if (!current || (registeredAt !== undefined && current.registeredAt !== registeredAt)) {
      return;
    }
    this.detachRegisteredClient(current);
    this.beginHostTeardown(clientId);
  }

  private detachRegisteredClient(current: RegisteredBrowserHost): void {
    const clientId = current.id;
    if (this.clients.get(clientId) === current) {
      this.clients.delete(clientId);
    }
    this.readyHosts.delete(current);

    for (const [browserId, ownerClientId] of this.browserHostByBrowserId) {
      if (ownerClientId !== clientId) {
        continue;
      }
      this.browserHostByBrowserId.delete(browserId);
      this.strandedBrowserHostByBrowserId.set(browserId, clientId);
    }

    for (const [affinityKey, ownerClientId] of this.enterpriseBrowserHostByAffinity) {
      if (ownerClientId === clientId) {
        this.enterpriseBrowserHostByAffinity.delete(affinityKey);
      }
    }
    for (const [profileKey, ownerClientId] of this.enterpriseBrowserHostByProfile) {
      if (ownerClientId === clientId) {
        this.enterpriseBrowserHostByProfile.delete(profileKey);
      }
    }

    for (const [requestId, pending] of this.pending) {
      if (pending.clientId !== clientId) {
        continue;
      }
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve(
        browserToolsFailure({
          requestId,
          code: "browser_no_host",
          message: "The browser automation host disconnected before responding.",
          retryable: true,
        }),
      );
    }
  }

  private beginHostTeardown(clientId: string): Promise<void> {
    if (!this.enterpriseRuntime) {
      return Promise.resolve();
    }
    const prior = this.hostTeardownBarriers.get(clientId) ?? Promise.resolve();
    const barrier = prior.then(() => this.enterpriseRuntime!.invalidateHost(clientId));
    this.hostTeardownBarriers.set(clientId, barrier);
    void barrier.then(
      () => {
        if (this.hostTeardownBarriers.get(clientId) === barrier) {
          this.hostTeardownBarriers.delete(clientId);
        }
        return undefined;
      },
      (error: unknown) => {
        this.onHostTeardownError(toError(error), clientId);
        return undefined;
      },
    );
    return barrier;
  }

  public getPendingRequestCount(): number {
    return this.pending.size;
  }

  public getRegisteredClientCount(): number {
    return this.clients.size;
  }

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    let requestId = "unknown";
    let claimedRequestId = false;
    try {
      const snapshot = snapshotBrowserToolsExecuteInput(input);
      if (snapshot.hasCallerOwnedAuthority) {
        return browserToolsFailure({
          requestId,
          code: "browser_denied",
          message: "Caller-owned Browser Profile authority is not accepted.",
        });
      }
      if (snapshot.requestId) {
        requestId = snapshot.requestId;
        this.claimRequestId(requestId);
      } else {
        requestId = this.allocateRequestId();
      }
      claimedRequestId = true;
      const request = BrowserAutomationExecuteRequestSchema.safeParse({
        type: "browser.automation.execute.request",
        requestId,
        ...(snapshot.agentId ? { agentId: snapshot.agentId } : {}),
        ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
        ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : {}),
        command: snapshot.command,
      });

      if (!request.success) {
        return browserToolsFailure({
          requestId,
          code: "browser_unknown_error",
          message: formatBrowserAutomationValidationError(request.error.issues[0]?.message),
        });
      }
      const frozenRequest = deepFreezeClone(request.data);
      const hostReadiness = this.getHostReadinessBarrier();
      if (hostReadiness) {
        await hostReadiness;
      }
      if (frozenRequest.command.command === "list_tabs") {
        return this.executeListTabs({
          request: frozenRequest,
          timeoutMs: snapshot.timeoutMs ?? this.defaultTimeoutMs,
        });
      }

      const host = this.selectHostForRequest(frozenRequest);
      if (!host.ok) {
        return host.payload;
      }

      const unsupported = this.unsupportedCommandFailure({
        host: host.value,
        commandName: frozenRequest.command.command,
        requestId,
      });
      if (unsupported) {
        return unsupported;
      }

      return this.sendRequest({
        host: host.value,
        request: frozenRequest,
        timeoutMs: snapshot.timeoutMs ?? this.defaultTimeoutMs,
      });
    } catch (error) {
      return browserToolsFailure({
        requestId,
        code: "browser_unknown_error",
        message: `Browser automation request failed closed: ${toError(error).message}`,
      });
    } finally {
      if (claimedRequestId) {
        this.liveRequestIds.delete(requestId);
      }
    }
  }

  public async executeEnterprise(
    input: EnterpriseBrowserToolsExecuteInput,
  ): Promise<BrowserToolsResponsePayload> {
    let requestId = "unknown";
    let claimedRequestId = false;
    let lease: FencedLease | null = null;
    let cleanupHandle: EnterpriseAgentContextHandle | null = null;
    let result: BrowserToolsResponsePayload = browserToolsFailure({
      requestId,
      code: "browser_denied",
      message: "Enterprise browser authorization failed closed.",
    });
    try {
      const runtime = this.enterpriseRuntime;
      const snapshot = snapshotEnterpriseExecuteInput(input);
      cleanupHandle = snapshot.handle;
      requestId = this.allocateRequestId();
      claimedRequestId = true;
      if (!runtime) {
        return browserToolsFailure({
          requestId,
          code: "browser_disabled",
          message: "Enterprise Browser Profiles are disabled on this daemon.",
        });
      }
      const handleAuthority = this.snapshotCurrentHandle(runtime, snapshot.handle);
      const authorization = await this.resolveCurrentAuthorization(
        runtime,
        snapshot.handle,
        handleAuthority,
      );

      lease = await runtime.acquire({
        handle: snapshot.handle,
        resourceId: authorization.profile.browserProfileId,
        mode: leaseModeForCommand(snapshot.command),
        ttlMs: runtime.leaseTtlMs,
      });
      await this.assertAuthorizationStillCurrent(
        runtime,
        snapshot.handle,
        handleAuthority,
        authorization,
      );
      const enterpriseContext = enterpriseContextFromLease(lease);
      const request = deepFreezeClone(
        BrowserAutomationExecuteRequestSchema.parse({
          type: "browser.automation.execute.request",
          requestId,
          agentId: authorization.agent.agentId,
          workspaceId: authorization.workspace.workspaceId,
          enterpriseContext,
          command: snapshot.command,
        }),
      );
      await this.assertAuthorizationStillCurrent(
        runtime,
        snapshot.handle,
        handleAuthority,
        authorization,
      );
      const selected = this.selectHostForRequest(request, authorization);
      if (!selected.ok) {
        result = selected.payload;
      } else {
        const unsupported = this.unsupportedCommandFailure({
          host: selected.value,
          commandName: request.command.command,
          requestId,
        });
        if (unsupported) {
          result = unsupported;
        } else {
          await runtime.attachHost({
            handle: snapshot.handle,
            lease,
            hostClientId: selected.value.id,
          });
          await this.assertAuthorizationStillCurrent(
            runtime,
            snapshot.handle,
            handleAuthority,
            authorization,
          );
          result = await this.sendRequest({
            host: selected.value,
            request,
            enterpriseAuthorization: authorization,
            rememberAffinity: false,
            timeoutMs: this.defaultTimeoutMs,
          });
          await runtime.validateLease({ handle: snapshot.handle, lease });
          await this.assertAuthorizationStillCurrent(
            runtime,
            snapshot.handle,
            handleAuthority,
            authorization,
          );
          if (
            result.ok &&
            this.clients.get(selected.value.id) === selected.value &&
            this.readyHosts.has(selected.value)
          ) {
            this.rememberBrowserHostForPayload(selected.value.id, result, request, authorization);
          } else if (result.ok) {
            result = this.noBrowserHostFailure(requestId);
          }
        }
      }
    } catch {
      result = browserToolsFailure({
        requestId,
        code: "browser_denied",
        message: "Enterprise browser authorization is no longer current.",
      });
    } finally {
      if (lease && cleanupHandle && this.enterpriseRuntime) {
        try {
          await this.enterpriseRuntime.releaseLease({ handle: cleanupHandle, lease });
        } catch {
          if (result.ok) {
            result = browserToolsFailure({
              requestId,
              code: "browser_denied",
              message: "Enterprise browser lease cleanup failed closed.",
            });
          }
        }
      }
      if (claimedRequestId) {
        this.liveRequestIds.delete(requestId);
      }
    }
    return result;
  }

  public async bindEnterpriseProfileHost(
    input: EnterpriseBrowserProfileHostBindingInput,
  ): Promise<boolean> {
    const runtime = this.enterpriseRuntime;
    let lease: FencedLease | null = null;
    let cleanupHandle: EnterpriseAgentContextHandle | null = null;
    let releaseAttempted = false;
    try {
      if (!runtime) {
        return false;
      }
      const snapshot = snapshotEnterpriseHostBindingInput(input);
      cleanupHandle = snapshot.handle;
      const handleAuthority = this.snapshotCurrentHandle(runtime, snapshot.handle);
      const authorization = await this.resolveCurrentAuthorization(
        runtime,
        snapshot.handle,
        handleAuthority,
      );
      const host = await this.getReadyHost(snapshot.hostClientId);
      if (!host || !this.isEnterpriseHostForNode(host, authorization.profile.homeNodeId)) {
        return false;
      }
      await this.assertAuthorizationStillCurrent(
        runtime,
        snapshot.handle,
        handleAuthority,
        authorization,
      );
      lease = await runtime.acquire({
        handle: snapshot.handle,
        resourceId: authorization.profile.browserProfileId,
        mode: "read",
        ttlMs: runtime.leaseTtlMs,
      });
      await this.assertAuthorizationStillCurrent(
        runtime,
        snapshot.handle,
        handleAuthority,
        authorization,
      );
      await runtime.attachHost({
        handle: snapshot.handle,
        lease,
        hostClientId: host.id,
      });
      await this.assertAuthorizationStillCurrent(
        runtime,
        snapshot.handle,
        handleAuthority,
        authorization,
      );
      await runtime.validateLease({ handle: snapshot.handle, lease });
      await this.assertAuthorizationStillCurrent(
        runtime,
        snapshot.handle,
        handleAuthority,
        authorization,
      );
      releaseAttempted = true;
      await runtime.releaseLease({ handle: snapshot.handle, lease });
      lease = null;
      await this.assertAuthorizationStillCurrent(
        runtime,
        snapshot.handle,
        handleAuthority,
        authorization,
      );
      if ((await this.getReadyHost(host.id)) !== host) {
        return false;
      }
      await this.assertAuthorizationStillCurrent(
        runtime,
        snapshot.handle,
        handleAuthority,
        authorization,
      );
      this.enterpriseBrowserHostByProfile.set(
        getEnterpriseBrowserProfileKey({
          authorization,
        }),
        host.id,
      );
      return true;
    } catch {
      return false;
    } finally {
      if (lease && cleanupHandle && runtime && !releaseAttempted) {
        releaseAttempted = true;
        try {
          await runtime.releaseLease({ handle: cleanupHandle, lease });
        } catch {
          // The binding is never published when proof-lease cleanup fails.
        }
      }
    }
  }

  private assertCurrentHandle(
    runtime: EnterpriseRuntimeSnapshot,
    handle: EnterpriseAgentContextHandle,
  ): void {
    if (!runtime.isCurrentHandle(handle)) {
      throw new Error("Enterprise Agent context is stale.");
    }
  }

  private snapshotCurrentHandle(
    runtime: EnterpriseRuntimeSnapshot,
    handle: EnterpriseAgentContextHandle,
  ): EnterpriseHandleAuthoritySnapshot {
    this.assertCurrentHandle(runtime, handle);
    return snapshotEnterpriseHandleAuthority(handle);
  }

  private async resolveCurrentAuthorization(
    runtime: EnterpriseRuntimeSnapshot,
    handle: EnterpriseAgentContextHandle,
    handleAuthority: EnterpriseHandleAuthoritySnapshot,
  ): Promise<BrowserProfileLeaseAuthorization> {
    this.assertCurrentHandle(runtime, handle);
    const unresolved = await runtime.resolveAuthorization(handle);
    this.assertCurrentHandle(runtime, handle);
    const authorization = snapshotBrowserProfileLeaseAuthorization(unresolved);
    assertBrowserAuthorizationMatchesHandle(handleAuthority, authorization);
    return authorization;
  }

  private async assertAuthorizationStillCurrent(
    runtime: EnterpriseRuntimeSnapshot,
    handle: EnterpriseAgentContextHandle,
    handleAuthority: EnterpriseHandleAuthoritySnapshot,
    expected: BrowserProfileLeaseAuthorization,
  ): Promise<void> {
    const current = await this.resolveCurrentAuthorization(runtime, handle, handleAuthority);
    if (!browserProfileLeaseAuthorizationsEqual(expected, current)) {
      throw new Error("Enterprise Browser Profile authorization changed during execution.");
    }
  }

  private getHostReadinessBarrier(): Promise<unknown> | null {
    const pendingHosts = Array.from(this.clients.values()).filter(
      (host) => !this.readyHosts.has(host),
    );
    return pendingHosts.length > 0 ? Promise.all(pendingHosts.map((host) => host.ready)) : null;
  }

  private async getReadyHost(clientId: string): Promise<RegisteredBrowserHost | null> {
    const host = this.clients.get(clientId);
    if (
      !host ||
      !(await host.ready) ||
      this.clients.get(clientId) !== host ||
      !this.readyHosts.has(host)
    ) {
      return null;
    }
    return host;
  }

  private claimRequestId(requestId: string): void {
    if (
      typeof requestId !== "string" ||
      !BROWSER_HOST_ID_PATTERN.test(requestId) ||
      this.liveRequestIds.has(requestId) ||
      this.pending.has(requestId)
    ) {
      throw new Error("Browser automation request ID is invalid or already active.");
    }
    this.liveRequestIds.add(requestId);
  }

  private allocateRequestId(): string {
    for (let attempt = 0; attempt < MAX_REQUEST_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
      const requestId = this.createRequestId();
      try {
        this.claimRequestId(requestId);
        return requestId;
      } catch {
        // Retry boundedly; malformed or colliding factories fail closed below.
      }
    }
    throw new Error("Unable to allocate a unique Browser automation request ID.");
  }

  private allocateDerivedRequestId(baseRequestId: string, hostClientId: string): string {
    for (let attempt = 0; attempt < MAX_REQUEST_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
      const suffix = attempt === 0 ? "" : `:${attempt}`;
      const requestId = `${baseRequestId}:${hostClientId}${suffix}`;
      try {
        this.claimRequestId(requestId);
        return requestId;
      } catch {
        // Try the next deterministic suffix without ever overwriting live state.
      }
    }
    throw new Error("Unable to allocate a unique Browser automation child request ID.");
  }

  public receiveResponse(senderId: string, response: BrowserAutomationExecuteResponse): boolean;
  /**
   * COMPAT(browserResponseSender): added in v0.9.0; remove after websocket hosts always pass
   * their server-side registration identity (after 2027-03-09). Enterprise responses never
   * use this overload.
   */
  public receiveResponse(response: BrowserAutomationExecuteResponse): boolean;
  public receiveResponse(
    senderOrResponse: string | BrowserAutomationExecuteResponse,
    responseFromSender?: BrowserAutomationExecuteResponse,
  ): boolean {
    const senderId = typeof senderOrResponse === "string" ? senderOrResponse : null;
    const response = typeof senderOrResponse === "string" ? responseFromSender : senderOrResponse;
    if (!response) {
      return false;
    }
    const parsed = BrowserAutomationExecuteResponseSchema.safeParse(response);
    if (!parsed.success) {
      const requestId = getBrowserAutomationResponseRequestId(response);
      if (!requestId) {
        return false;
      }

      const pending = this.pending.get(requestId);
      if (!pending) {
        return false;
      }
      if (!this.responseSenderMatches(pending, senderId)) {
        return false;
      }

      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve(
        browserToolsFailure({
          requestId,
          code: "browser_unknown_error",
          message: formatBrowserAutomationResponseValidationError(parsed.error.issues[0]?.message),
        }),
      );
      return true;
    }

    const pending = this.pending.get(parsed.data.payload.requestId);
    if (!pending) {
      return false;
    }
    if (!this.responseMatchesPendingRequest(pending, senderId, parsed.data)) {
      return false;
    }

    this.pending.delete(parsed.data.payload.requestId);
    clearTimeout(pending.timeout);
    if (pending.rememberAffinity) {
      this.rememberBrowserHostForPayload(
        pending.clientId,
        parsed.data.payload,
        pending.request,
        pending.enterpriseAuthorization,
      );
    }
    pending.resolve(parsed.data.payload);
    return true;
  }

  private async executeListTabs(params: {
    request: BrowserAutomationExecuteRequest;
    timeoutMs: number;
  }): Promise<BrowserToolsResponsePayload> {
    const hosts = params.request.enterpriseContext
      ? this.listEnterpriseHostsForNode(params.request.enterpriseContext.nodeId)
      : Array.from(this.clients.values()).filter((host) => this.readyHosts.has(host));
    if (hosts.length === 0) {
      return this.noBrowserHostFailure(params.request.requestId);
    }

    for (const host of hosts) {
      const unsupported = this.unsupportedCommandFailure({
        host,
        commandName: "list_tabs",
        requestId: params.request.requestId,
      });
      if (unsupported) {
        return unsupported;
      }
    }

    if (hosts.length === 1) {
      return this.sendRequest({
        host: hosts[0],
        request: params.request,
        timeoutMs: params.timeoutMs,
      });
    }

    const childRequestIds: string[] = [];
    let hostResponses: Array<{ host: RegisteredBrowserHost; payload: BrowserToolsResponsePayload }>;
    try {
      hostResponses = await Promise.all(
        hosts.map(async (host) => {
          const childRequestId = this.allocateDerivedRequestId(params.request.requestId, host.id);
          childRequestIds.push(childRequestId);
          return {
            host,
            payload: await this.sendRequest({
              host,
              request: deepFreezeClone({ ...params.request, requestId: childRequestId }),
              rememberAffinity: false,
              timeoutMs: params.timeoutMs,
            }),
          };
        }),
      );
    } finally {
      for (const childRequestId of childRequestIds) {
        this.liveRequestIds.delete(childRequestId);
      }
    }

    const failed = hostResponses.find(({ payload }) => !payload.ok);
    if (failed) {
      return withBrowserToolsRequestId(failed.payload, params.request.requestId);
    }

    for (const { host, payload } of hostResponses) {
      this.rememberBrowserHostForPayload(host.id, payload, params.request);
    }

    return {
      requestId: params.request.requestId,
      ok: true,
      result: {
        command: "list_tabs",
        tabs: hostResponses.flatMap(({ payload }) =>
          payload.ok && payload.result.command === "list_tabs" ? payload.result.tabs : [],
        ),
      },
    };
  }

  private selectHostForRequest(
    request: BrowserAutomationExecuteRequest,
    enterpriseAuthorization?: BrowserProfileLeaseAuthorization,
  ):
    | { ok: true; value: RegisteredBrowserHost }
    | { ok: false; payload: BrowserToolsResponsePayload } {
    const { command, requestId } = request;
    if (request.enterpriseContext) {
      return enterpriseAuthorization
        ? this.selectEnterpriseHostForRequest(request, enterpriseAuthorization)
        : {
            ok: false,
            payload: browserToolsFailure({
              requestId,
              code: "browser_denied",
              message: "Enterprise browser routing authority is unavailable.",
            }),
          };
    }

    if (command.command === "new_tab") {
      const host = this.selectMostRecentlyRegisteredHost();
      return host
        ? { ok: true, value: host }
        : { ok: false, payload: this.noBrowserHostFailure(requestId) };
    }

    const browserId = getBrowserIdForCommand(command);
    if (!browserId) {
      const host = this.selectMostRecentlyRegisteredHost();
      return host
        ? { ok: true, value: host }
        : { ok: false, payload: this.noBrowserHostFailure(requestId) };
    }

    const ownerClientId = this.browserHostByBrowserId.get(browserId);
    if (ownerClientId) {
      const host = this.clients.get(ownerClientId);
      if (host && this.readyHosts.has(host)) {
        return { ok: true, value: host };
      }
      return {
        ok: false,
        payload: this.strandedBrowserTabFailure({ requestId, browserId }),
      };
    }

    const strandedOwnerClientId = this.strandedBrowserHostByBrowserId.get(browserId);
    if (strandedOwnerClientId) {
      const reconnectedHost = this.clients.get(strandedOwnerClientId);
      if (reconnectedHost && this.readyHosts.has(reconnectedHost)) {
        this.strandedBrowserHostByBrowserId.delete(browserId);
        this.browserHostByBrowserId.set(browserId, strandedOwnerClientId);
        return { ok: true, value: reconnectedHost };
      }
      return {
        ok: false,
        payload: this.strandedBrowserTabFailure({ requestId, browserId }),
      };
    }

    const readyHosts = this.listReadyHosts();
    if (readyHosts.length === 1) {
      return { ok: true, value: readyHosts[0] };
    }

    if (readyHosts.length === 0) {
      return { ok: false, payload: this.noBrowserHostFailure(requestId) };
    }

    return {
      ok: false,
      payload: browserToolsFailure({
        requestId,
        code: "browser_tab_not_found",
        message: `Browser tab ${browserId} is not associated with a connected browser automation host. Call browser_list_tabs and use one of the returned browserId values.`,
      }),
    };
  }

  private selectEnterpriseHostForRequest(
    request: BrowserAutomationExecuteRequest,
    authorization: BrowserProfileLeaseAuthorization,
  ):
    | { ok: true; value: RegisteredBrowserHost }
    | { ok: false; payload: BrowserToolsResponsePayload } {
    const { command, enterpriseContext, requestId, workspaceId } = request;
    if (!enterpriseContext || !workspaceId) {
      return {
        ok: false,
        payload: browserToolsFailure({
          requestId,
          code: "browser_denied",
          message: "Enterprise browser automation requires an authorized workspace.",
        }),
      };
    }

    const homeNodeId = authorization.profile.homeNodeId;
    const eligibleHosts = this.listEnterpriseHostsForNode(homeNodeId);
    const profileKey = getEnterpriseBrowserProfileKey({ authorization });
    const profileOwnerClientId = this.enterpriseBrowserHostByProfile.get(profileKey);
    const routedHost = profileOwnerClientId ? this.clients.get(profileOwnerClientId) : undefined;
    if (routedHost && !this.isEnterpriseHostForNode(routedHost, homeNodeId)) {
      this.enterpriseBrowserHostByProfile.delete(profileKey);
    }
    if (command.command === "new_tab" || command.command === "list_tabs") {
      const host =
        routedHost && this.isEnterpriseHostForNode(routedHost, homeNodeId) ? routedHost : null;
      if (host) {
        return { ok: true, value: host };
      }
      if (eligibleHosts.length === 0) {
        return { ok: false, payload: this.noBrowserHostFailure(requestId) };
      }
      return {
        ok: false,
        payload: browserToolsFailure({
          requestId,
          code: "browser_denied",
          message: "This Browser Profile is not registered to an authorized Desktop host.",
        }),
      };
    }

    const browserId = getBrowserIdForCommand(command);
    if (!browserId) {
      return {
        ok: false,
        payload: browserToolsFailure({
          requestId,
          code: "browser_unknown_error",
          message: "Enterprise browser automation request has no browser target.",
        }),
      };
    }
    const affinityKey = getEnterpriseBrowserAffinityKey({ authorization, browserId });
    const ownerClientId = this.enterpriseBrowserHostByAffinity.get(affinityKey);
    const host = ownerClientId ? this.clients.get(ownerClientId) : undefined;
    if (host && this.isEnterpriseHostForNode(host, homeNodeId)) {
      return { ok: true, value: host };
    }
    this.enterpriseBrowserHostByAffinity.delete(affinityKey);

    if (eligibleHosts.length === 0) {
      return { ok: false, payload: this.noBrowserHostFailure(requestId) };
    }
    return {
      ok: false,
      payload: browserToolsFailure({
        requestId,
        code: "browser_tab_not_found",
        message: `Browser tab ${browserId} is not registered for this Browser Profile. Call browser_list_tabs and use one of the returned browserId values.`,
      }),
    };
  }

  private selectMostRecentlyRegisteredHost(): RegisteredBrowserHost | null {
    let selected: RegisteredBrowserHost | null = null;
    for (const host of this.clients.values()) {
      if (this.readyHosts.has(host)) {
        selected = host;
      }
    }
    return selected;
  }

  private listReadyHosts(): RegisteredBrowserHost[] {
    return Array.from(this.clients.values()).filter((host) => this.readyHosts.has(host));
  }

  private listEnterpriseHostsForNode(nodeId: string): RegisteredBrowserHost[] {
    return Array.from(this.clients.values()).filter(
      (host) => this.readyHosts.has(host) && this.isEnterpriseHostForNode(host, nodeId),
    );
  }

  private isEnterpriseHostForNode(host: RegisteredBrowserHost, nodeId: string): boolean {
    return (
      this.readyHosts.has(host) &&
      host.enterpriseProfiles?.version === 1 &&
      host.homeNodeId === nodeId
    );
  }

  private unsupportedCommandFailure(params: {
    host: RegisteredBrowserHost;
    commandName: BrowserAutomationCommandName;
    requestId: string;
  }): BrowserToolsResponsePayload | null {
    if (params.host.supportedCommands.has(params.commandName)) {
      return null;
    }
    return browserToolsFailure({
      requestId: params.requestId,
      code: "browser_unsupported",
      message: `Browser automation command "${params.commandName}" is not supported by the ${describeBrowserHost(params.host)}.`,
    });
  }

  private noBrowserHostFailure(requestId: string): BrowserToolsResponsePayload {
    return browserToolsFailure({
      requestId,
      code: "browser_no_host",
      message: "No browser automation host is connected.",
      retryable: true,
    });
  }

  private strandedBrowserTabFailure(params: {
    requestId: string;
    browserId: string;
  }): BrowserToolsResponsePayload {
    return browserToolsFailure({
      requestId: params.requestId,
      code: "browser_no_host",
      message: `The app hosting browser tab ${params.browserId} disconnected.`,
      retryable: true,
    });
  }

  private rememberBrowserHostForPayload(
    clientId: string,
    payload: BrowserToolsResponsePayload,
    request: BrowserAutomationExecuteRequest,
    enterpriseAuthorization?: BrowserProfileLeaseAuthorization,
  ): void {
    if (!payload.ok) {
      return;
    }

    if (request.enterpriseContext) {
      if (!request.workspaceId || !enterpriseAuthorization) {
        return;
      }
      this.rememberEnterpriseBrowserHostForPayload(clientId, payload, enterpriseAuthorization);
      return;
    }

    if (payload.result.command === "list_tabs") {
      for (const tab of payload.result.tabs) {
        this.browserHostByBrowserId.set(tab.browserId, clientId);
        this.strandedBrowserHostByBrowserId.delete(tab.browserId);
      }
      return;
    }

    if (payload.result.command === "close_tab") {
      this.browserHostByBrowserId.delete(payload.result.browserId);
      this.strandedBrowserHostByBrowserId.delete(payload.result.browserId);
      return;
    }

    if ("browserId" in payload.result) {
      this.browserHostByBrowserId.set(payload.result.browserId, clientId);
      this.strandedBrowserHostByBrowserId.delete(payload.result.browserId);
    }
  }

  private rememberEnterpriseBrowserHostForPayload(
    clientId: string,
    payload: Extract<BrowserToolsResponsePayload, { ok: true }>,
    authorization: BrowserProfileLeaseAuthorization,
  ): void {
    this.enterpriseBrowserHostByProfile.set(
      getEnterpriseBrowserProfileKey({ authorization }),
      clientId,
    );
    const affinityKey = (browserId: string): string =>
      getEnterpriseBrowserAffinityKey({ authorization, browserId });

    if (payload.result.command === "list_tabs") {
      for (const tab of payload.result.tabs) {
        this.enterpriseBrowserHostByAffinity.set(affinityKey(tab.browserId), clientId);
      }
      return;
    }
    if (payload.result.command === "close_tab") {
      this.enterpriseBrowserHostByAffinity.delete(affinityKey(payload.result.browserId));
      return;
    }
    if ("browserId" in payload.result) {
      this.enterpriseBrowserHostByAffinity.set(affinityKey(payload.result.browserId), clientId);
    }
  }

  private responseSenderMatches(
    pending: PendingBrowserToolsRequest,
    senderId: string | null,
  ): boolean {
    if (senderId !== null) {
      return senderId === pending.clientId;
    }
    return pending.request.enterpriseContext === undefined;
  }

  private responseMatchesPendingRequest(
    pending: PendingBrowserToolsRequest,
    senderId: string | null,
    response: BrowserAutomationExecuteResponse,
  ): boolean {
    if (!this.responseSenderMatches(pending, senderId)) {
      return false;
    }
    const expectedContext = pending.request.enterpriseContext;
    const actualContext = response.payload.enterpriseContext;
    if (!expectedContext) {
      return actualContext === undefined;
    }
    if (!actualContext || !browserEnterpriseContextsEqual(expectedContext, actualContext)) {
      return false;
    }
    if (!response.payload.ok) {
      return true;
    }
    return browserResultMatchesEnterpriseRequest(pending.request, response.payload.result);
  }

  private sendRequest(params: {
    host: RegisteredBrowserHost;
    request: BrowserAutomationExecuteRequest;
    enterpriseAuthorization?: BrowserProfileLeaseAuthorization;
    rememberAffinity?: boolean;
    timeoutMs: number;
  }): Promise<BrowserToolsResponsePayload> {
    const { host, request, timeoutMs } = params;
    if (this.clients.get(host.id) !== host || !this.readyHosts.has(host)) {
      return Promise.resolve(this.noBrowserHostFailure(request.requestId));
    }
    return new Promise<BrowserToolsResponsePayload>((resolve) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(request.requestId)) {
          return;
        }
        resolve(
          browserToolsFailure({
            requestId: request.requestId,
            code: "browser_timeout",
            message: `Browser automation timed out after ${timeoutMs}ms.`,
            retryable: true,
          }),
        );
      }, timeoutMs);

      this.pending.set(request.requestId, {
        clientId: host.id,
        request,
        ...(params.enterpriseAuthorization
          ? { enterpriseAuthorization: params.enterpriseAuthorization }
          : {}),
        rememberAffinity: params.rememberAffinity ?? true,
        timeout,
        resolve,
      });

      try {
        Promise.resolve(host.sendBrowserAutomationRequest(request)).catch((error: unknown) => {
          resolveSendFailure({
            requestId: request.requestId,
            pending: this.pending,
            timeout,
            resolve,
            error,
          });
        });
      } catch (error) {
        resolveSendFailure({
          requestId: request.requestId,
          pending: this.pending,
          timeout,
          resolve,
          error,
        });
      }
    });
  }
}

function getBrowserIdForCommand(command: BrowserAutomationCommand): string | null {
  if (command.command === "list_tabs" || command.command === "new_tab") {
    return null;
  }
  return command.args.browserId;
}

function getEnterpriseBrowserAffinityKey(input: {
  authorization: BrowserProfileLeaseAuthorization;
  browserId: string;
}): string {
  const { authorization } = input;
  return JSON.stringify([
    authorization.workspace.organizationId,
    authorization.profile.homeNodeId,
    authorization.workspace.workspaceId,
    authorization.profile.browserProfileId,
    authorization.bindingRevision,
    authorization.workspace.ownerPrincipalId,
    input.browserId,
  ]);
}

function getEnterpriseBrowserProfileKey(input: {
  authorization: BrowserProfileLeaseAuthorization;
}): string {
  const { authorization } = input;
  return JSON.stringify([
    authorization.workspace.organizationId,
    authorization.profile.homeNodeId,
    authorization.workspace.workspaceId,
    authorization.profile.browserProfileId,
    authorization.bindingRevision,
    authorization.workspace.ownerPrincipalId,
  ]);
}

function snapshotBrowserToolsExecuteInput(input: BrowserToolsExecuteInput): {
  command: BrowserAutomationCommand;
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
  requestId?: string;
  timeoutMs?: number;
  hasCallerOwnedAuthority: boolean;
} {
  const values = readOwnDataRecord(input, "Browser automation execution input");
  const authorityKeys = new Set([
    "browserProfileId",
    "enterpriseContext",
    "fencingToken",
    "lease",
    "leaseId",
    "partition",
    "partitionKey",
    "pid",
    "processId",
  ]);
  const allowedKeys = new Set([
    "agentId",
    "command",
    "cwd",
    "requestId",
    "timeoutMs",
    "workspaceId",
  ]);
  const keys = Object.keys(values);
  const hasCallerOwnedAuthority = keys.some((key) => authorityKeys.has(key));
  if (keys.some((key) => !allowedKeys.has(key) && !authorityKeys.has(key))) {
    throw new Error("Browser automation execution input has unknown fields.");
  }
  return {
    command: deepFreezeClone(values.command) as BrowserAutomationCommand,
    ...(values.agentId !== undefined ? { agentId: values.agentId as string } : {}),
    ...(values.cwd !== undefined ? { cwd: values.cwd as string } : {}),
    ...(values.workspaceId !== undefined ? { workspaceId: values.workspaceId as string } : {}),
    ...(values.requestId !== undefined ? { requestId: values.requestId as string } : {}),
    ...(values.timeoutMs !== undefined ? { timeoutMs: values.timeoutMs as number } : {}),
    hasCallerOwnedAuthority,
  };
}

function snapshotEnterpriseExecuteInput(input: EnterpriseBrowserToolsExecuteInput): {
  handle: EnterpriseAgentContextHandle;
  command: BrowserAutomationCommand;
} {
  const values = readExactOwnDataRecord(
    input,
    ["command", "handle"],
    "Enterprise Browser execution input",
  );
  return {
    handle: values.handle as EnterpriseAgentContextHandle,
    command: snapshotBrowserAutomationCommand(values.command),
  };
}

function snapshotEnterpriseHostBindingInput(input: EnterpriseBrowserProfileHostBindingInput): {
  handle: EnterpriseAgentContextHandle;
  hostClientId: string;
} {
  const values = readExactOwnDataRecord(
    input,
    ["handle", "hostClientId"],
    "Enterprise Browser host binding input",
  );
  if (
    typeof values.hostClientId !== "string" ||
    !BROWSER_HOST_ID_PATTERN.test(values.hostClientId)
  ) {
    throw new Error("Invalid Enterprise Browser host registration ID.");
  }
  return {
    handle: values.handle as EnterpriseAgentContextHandle,
    hostClientId: values.hostClientId,
  };
}

function snapshotBrowserAutomationCommand(input: unknown): BrowserAutomationCommand {
  return deepFreezeClone(BrowserAutomationCommandSchema.parse(clonePlainData(input)));
}

function snapshotEnterpriseHandleAuthority(
  handle: EnterpriseAgentContextHandle,
): EnterpriseHandleAuthoritySnapshot {
  const handleValues = readOwnDataRecord(handle, "Enterprise Agent context handle", {
    allowSymbols: true,
  });
  const context = readExactOwnDataRecord(
    handleValues.context,
    ["node", "principal", "sessionBindingGeneration"],
    "Enterprise Agent context",
  );
  const principal = readOwnDataRecord(context.principal, "Enterprise Principal context");
  const node = readOwnDataRecord(context.node, "Enterprise Node context");
  const values = {
    agentId: handleValues.agentId,
    organizationId: principal.organizationId,
    nodeId: node.nodeId,
    principalId: principal.principalId,
  };
  if (Object.values(values).some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Invalid Enterprise Agent context authority.");
  }
  return Object.freeze(values) as EnterpriseHandleAuthoritySnapshot;
}

function snapshotBrowserProfileLeaseAuthorization(
  input: unknown,
): BrowserProfileLeaseAuthorization {
  return deepFreezeClone(BrowserProfileLeaseAuthorizationSchema.parse(clonePlainData(input)));
}

function assertBrowserAuthorizationMatchesHandle(
  handle: EnterpriseHandleAuthoritySnapshot,
  authorization: BrowserProfileLeaseAuthorization,
): void {
  const { workspace } = authorization;
  if (
    workspace.organizationId !== handle.organizationId ||
    workspace.nodeId !== handle.nodeId ||
    workspace.ownerPrincipalId !== handle.principalId ||
    authorization.agent.agentId !== handle.agentId ||
    authorization.agent.workspaceId !== workspace.workspaceId ||
    !authorizedResourceOwnersEqual(authorization.agent, workspace) ||
    authorization.profile.organizationId !== workspace.organizationId ||
    authorization.profile.homeNodeId !== workspace.nodeId ||
    authorization.profile.ownerPrincipalId !== workspace.ownerPrincipalId
  ) {
    throw new Error("Resolved Browser Profile authorization does not match its canonical tuple.");
  }
}

function authorizedResourceOwnersEqual(
  left: AuthorizedWorkspace,
  right: AuthorizedWorkspace,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.nodeId === right.nodeId &&
    left.workspaceId === right.workspaceId &&
    left.ownerPrincipalId === right.ownerPrincipalId &&
    left.createdByPrincipalId === right.createdByPrincipalId
  );
}

function browserProfileLeaseAuthorizationsEqual(
  left: BrowserProfileLeaseAuthorization,
  right: BrowserProfileLeaseAuthorization,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function enterpriseContextFromLease(lease: FencedLease): BrowserAutomationEnterpriseContext {
  if (lease.resourceKind !== "browser_profile") {
    throw new Error("Browser automation received a non-Browser Profile lease.");
  }
  return {
    browserProfileId: lease.resourceId,
    nodeId: lease.nodeId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    leaseRevision: lease.leaseRevision,
  };
}

function leaseModeForCommand(command: BrowserAutomationCommand): "read" | "write" {
  switch (command.command) {
    case "list_tabs":
    case "snapshot":
    case "screenshot":
    case "logs":
    case "wait":
      return "read";
    default:
      return "write";
  }
}

function browserEnterpriseContextsEqual(
  expected: BrowserAutomationEnterpriseContext,
  actual: BrowserAutomationEnterpriseContext,
): boolean {
  return (
    actual.browserProfileId === expected.browserProfileId &&
    actual.nodeId === expected.nodeId &&
    actual.leaseId === expected.leaseId &&
    actual.fencingToken === expected.fencingToken &&
    actual.leaseRevision === expected.leaseRevision
  );
}

function browserResultMatchesEnterpriseRequest(
  request: BrowserAutomationExecuteRequest,
  result: BrowserAutomationResult,
): boolean {
  if (result.command !== request.command.command || !request.enterpriseContext) {
    return false;
  }
  const expectedBrowserId = getBrowserIdForCommand(request.command);
  if (expectedBrowserId && (!("browserId" in result) || result.browserId !== expectedBrowserId)) {
    return false;
  }
  if (result.command === "list_tabs") {
    return result.tabs.every(
      (tab) =>
        tab.workspaceId === request.workspaceId &&
        tab.enterpriseContext !== undefined &&
        browserEnterpriseContextsEqual(request.enterpriseContext!, tab.enterpriseContext),
    );
  }
  if ("workspaceId" in result && result.workspaceId !== undefined) {
    return result.workspaceId === request.workspaceId;
  }
  return true;
}

function describeBrowserHost(host: RegisteredBrowserHost): string {
  const hostKind = host.hostKind;
  return hostKind || "browser host";
}

function withBrowserToolsRequestId(
  payload: BrowserToolsResponsePayload,
  requestId: string,
): BrowserToolsResponsePayload {
  return { ...payload, requestId } as BrowserToolsResponsePayload;
}

function resolveSendFailure(params: {
  requestId: string;
  pending: Map<string, PendingBrowserToolsRequest>;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (payload: BrowserToolsResponsePayload) => void;
  error: unknown;
}): void {
  if (!params.pending.delete(params.requestId)) {
    return;
  }
  clearTimeout(params.timeout);
  params.resolve(
    browserToolsFailure({
      requestId: params.requestId,
      code: "browser_unknown_error",
      message: formatBrowserAutomationSendError(params.error),
    }),
  );
}

function formatBrowserAutomationValidationError(message: string | undefined): string {
  if (!message) {
    return "Browser automation request is invalid.";
  }
  return `Browser automation request is invalid: ${message}.`;
}

function formatBrowserAutomationResponseValidationError(message: string | undefined): string {
  if (!message) {
    return "Browser automation response is invalid.";
  }
  return `Browser automation response is invalid: ${message}.`;
}

function formatBrowserAutomationSendError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `Browser automation request failed to send: ${error.message}`;
  }
  return `Browser automation request failed to send: ${String(error)}`;
}

function getBrowserAutomationResponseRequestId(response: unknown): string | null {
  if (!isRecord(response)) {
    return null;
  }
  const payload = response.payload;
  if (!isRecord(payload) || typeof payload.requestId !== "string") {
    return null;
  }
  return payload.requestId;
}

function snapshotBrowserHostClient(
  input: BrowserHostClient,
): Omit<RegisteredBrowserHost, "ready" | "registeredAt"> {
  const values = readSelectedOwnDataProperties(
    input,
    [
      "enterpriseProfiles",
      "homeNodeId",
      "hostKind",
      "id",
      "sendBrowserAutomationRequest",
      "supportedCommands",
    ],
    ["hostKind", "id", "sendBrowserAutomationRequest", "supportedCommands"],
    "Browser host registration",
  );
  const {
    id,
    hostKind,
    supportedCommands,
    enterpriseProfiles,
    homeNodeId,
    sendBrowserAutomationRequest,
  } = values;
  if (typeof id !== "string" || !BROWSER_HOST_ID_PATTERN.test(id)) {
    throw new Error("Invalid Browser host registration ID.");
  }
  if (typeof hostKind !== "string" || hostKind.trim().length === 0) {
    throw new Error("Invalid Browser host kind.");
  }
  const commandValues = clonePlainData(supportedCommands);
  if (!Array.isArray(commandValues)) {
    throw new Error("Invalid Browser host command capability.");
  }
  const commands = commandValues.map((command) => {
    if (
      typeof command !== "string" ||
      !SUPPORTED_BROWSER_COMMANDS.has(command as BrowserAutomationCommandName)
    ) {
      throw new Error("Invalid Browser host command capability.");
    }
    return command as BrowserAutomationCommandName;
  });
  if (new Set(commands).size !== commands.length) {
    throw new Error("Duplicate Browser host command capability.");
  }
  if (typeof sendBrowserAutomationRequest !== "function") {
    throw new Error("Invalid Browser host send method.");
  }

  let enterpriseCapability: Readonly<{ version: 1 }> | undefined;
  if (enterpriseProfiles !== undefined) {
    const capability = readExactOwnDataRecord(
      enterpriseProfiles,
      ["version"],
      "Enterprise Browser host capability",
    );
    if (capability.version !== 1) {
      throw new Error("Invalid Enterprise Browser host capability version.");
    }
    enterpriseCapability = Object.freeze({ version: 1 });
    if (typeof homeNodeId !== "string" || !NODE_ID_PATTERN.test(homeNodeId)) {
      throw new Error("Enterprise Browser host requires a valid trusted home node ID.");
    }
  } else if (homeNodeId !== undefined) {
    throw new Error("A legacy Browser host cannot claim an Enterprise home node.");
  }
  const send = sendBrowserAutomationRequest as (
    request: BrowserAutomationExecuteRequest,
  ) => void | Promise<void>;
  const receiver = Object.freeze({
    id,
    hostKind: hostKind.trim(),
    supportedCommands: Object.freeze([...commands]),
    sendBrowserAutomationRequest: send,
    ...(enterpriseCapability ? { enterpriseProfiles: enterpriseCapability, homeNodeId } : {}),
  });
  return Object.freeze({
    id,
    hostKind: hostKind.trim(),
    supportedCommands: new Set(commands),
    sendBrowserAutomationRequest: (request: BrowserAutomationExecuteRequest) =>
      Reflect.apply(send, receiver, [request]),
    ...(enterpriseCapability ? { enterpriseProfiles: enterpriseCapability, homeNodeId } : {}),
  });
}

function readSelectedOwnDataProperties(
  input: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch (error) {
    throw new Error(`${label} cannot be inspected: ${toError(error).message}`, {
      cause: error,
    });
  }
  for (const key of requiredKeys) {
    if (!(key in descriptors)) {
      throw new Error(`${label}.${key} is required.`);
    }
  }
  const output: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor) {
      continue;
    }
    if (descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be a stable data property.`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function readExactOwnDataRecord(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = readOwnDataRecord(input, label);
  const keys = Object.keys(record).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${label} has invalid fields.`);
  }
  return record;
}

function readOwnDataRecord(
  input: unknown,
  label: string,
  options: { allowSymbols?: boolean } = {},
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  let descriptors: PropertyDescriptorMap;
  let symbols: symbol[];
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
    symbols = Object.getOwnPropertySymbols(input);
  } catch (error) {
    throw new Error(`${label} cannot be inspected: ${toError(error).message}`, {
      cause: error,
    });
  }
  if (!options.allowSymbols && symbols.length > 0) {
    throw new Error(`${label} has invalid symbol fields.`);
  }
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be a stable data property.`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function clonePlainData(input: unknown, depth = 0): unknown {
  if (depth > 32) {
    throw new Error("Browser data nesting is too deep.");
  }
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean" ||
    input === undefined
  ) {
    return input;
  }
  if (Array.isArray(input)) {
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(input) as unknown as PropertyDescriptorMap;
    } catch (error) {
      throw new Error(`Browser array cannot be inspected: ${toError(error).message}`, {
        cause: error,
      });
    }
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error("Invalid Browser array length.");
    }
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (keys.length !== length) {
      throw new Error("Sparse or decorated Browser arrays are not accepted.");
    }
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw new Error("Browser array entries must be stable data properties.");
      }
      return clonePlainData(descriptor.value, depth + 1);
    });
  }
  if (typeof input !== "object") {
    throw new Error("Browser data contains a non-data value.");
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(input);
  } catch (error) {
    throw new Error(`Browser object prototype cannot be inspected: ${toError(error).message}`, {
      cause: error,
    });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Browser data must use plain objects.");
  }
  const values = readOwnDataRecord(input, "Browser data");
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, clonePlainData(value, depth + 1)]),
  );
}

function deepFreezeClone<T>(input: T): T {
  return deepFreeze(clonePlainData(input)) as T;
}

function deepFreeze<T>(input: T): T {
  if (input && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) {
      deepFreeze(value);
    }
    Object.freeze(input);
  }
  return input;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
