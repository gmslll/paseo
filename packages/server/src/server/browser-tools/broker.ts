import { randomUUID } from "node:crypto";
import {
  BrowserAutomationExecuteRequestSchema,
  BrowserAutomationExecuteResponseSchema,
  type BrowserAutomationCommand,
  type BrowserAutomationCommandName,
  type BrowserAutomationEnterpriseContext,
  type BrowserAutomationExecuteRequest,
  type BrowserAutomationExecuteResponse,
  type BrowserAutomationResult,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
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
  enterpriseContext?: BrowserAutomationEnterpriseContext;
  requestId?: string;
  timeoutMs?: number;
}

interface PendingBrowserToolsRequest {
  clientId: string;
  request: BrowserAutomationExecuteRequest;
  rememberAffinity: boolean;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (payload: BrowserToolsResponsePayload) => void;
}

interface RegisteredBrowserHost {
  client: BrowserHostClient;
  registeredAt: number;
  supportedCommands: ReadonlySet<BrowserAutomationCommandName>;
}

export interface BrowserToolsBrokerOptions {
  defaultTimeoutMs?: number;
  createRequestId?: () => string;
}

const DEFAULT_BROWSER_TOOLS_TIMEOUT_MS = 15_000;

export class BrowserToolsBroker {
  private readonly defaultTimeoutMs: number;
  private readonly createRequestId: () => string;
  private readonly clients = new Map<string, RegisteredBrowserHost>();
  private readonly pending = new Map<string, PendingBrowserToolsRequest>();
  private readonly browserHostByBrowserId = new Map<string, string>();
  private readonly strandedBrowserHostByBrowserId = new Map<string, string>();
  private readonly enterpriseBrowserHostByAffinity = new Map<string, string>();
  private registrationSequence = 0;

  public constructor(options: BrowserToolsBrokerOptions) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_BROWSER_TOOLS_TIMEOUT_MS;
    this.createRequestId = options.createRequestId ?? (() => `browser_${randomUUID()}`);
  }

  public registerClient(client: BrowserHostClient): () => void {
    this.unregisterClient(client.id);
    const registeredAt = ++this.registrationSequence;
    this.clients.set(client.id, {
      client,
      registeredAt,
      supportedCommands: new Set(client.supportedCommands),
    });
    return () => this.unregisterClient(client.id, registeredAt);
  }

  public unregisterClient(clientId: string, registeredAt?: number): void {
    const current = this.clients.get(clientId);
    if (!current || (registeredAt !== undefined && current.registeredAt !== registeredAt)) {
      return;
    }
    this.clients.delete(clientId);

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

  public getPendingRequestCount(): number {
    return this.pending.size;
  }

  public getRegisteredClientCount(): number {
    return this.clients.size;
  }

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    const requestId = input.requestId ?? this.createRequestId();

    const request = BrowserAutomationExecuteRequestSchema.safeParse({
      type: "browser.automation.execute.request",
      requestId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.enterpriseContext ? { enterpriseContext: input.enterpriseContext } : {}),
      command: input.command,
    });

    if (!request.success) {
      return browserToolsFailure({
        requestId,
        code: "browser_unknown_error",
        message: formatBrowserAutomationValidationError(request.error.issues[0]?.message),
      });
    }

    if (request.data.command.command === "list_tabs") {
      return this.executeListTabs({
        request: request.data,
        timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
      });
    }

    const host = this.selectHostForRequest(request.data);
    if (!host.ok) {
      return host.payload;
    }

    const unsupported = this.unsupportedCommandFailure({
      host: host.value,
      commandName: request.data.command.command,
      requestId,
    });
    if (unsupported) {
      return unsupported;
    }

    return this.sendRequest({
      host: host.value,
      request: request.data,
      timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
    });
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
      this.rememberBrowserHostForPayload(pending.clientId, parsed.data.payload, pending.request);
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
      : Array.from(this.clients.values());
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

    const hostResponses = await Promise.all(
      hosts.map(async (host) => ({
        host,
        payload: await this.sendRequest({
          host,
          request: {
            ...params.request,
            requestId: `${params.request.requestId}:${host.client.id}`,
          },
          rememberAffinity: false,
          timeoutMs: params.timeoutMs,
        }),
      })),
    );

    const failed = hostResponses.find(({ payload }) => !payload.ok);
    if (failed) {
      return withBrowserToolsRequestId(failed.payload, params.request.requestId);
    }

    for (const { host, payload } of hostResponses) {
      this.rememberBrowserHostForPayload(host.client.id, payload, params.request);
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
  ):
    | { ok: true; value: RegisteredBrowserHost }
    | { ok: false; payload: BrowserToolsResponsePayload } {
    const { command, requestId } = request;
    if (request.enterpriseContext) {
      return this.selectEnterpriseHostForRequest(request);
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
      if (host) {
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
      if (reconnectedHost) {
        this.strandedBrowserHostByBrowserId.delete(browserId);
        this.browserHostByBrowserId.set(browserId, strandedOwnerClientId);
        return { ok: true, value: reconnectedHost };
      }
      return {
        ok: false,
        payload: this.strandedBrowserTabFailure({ requestId, browserId }),
      };
    }

    if (this.clients.size === 1) {
      const host = this.selectMostRecentlyRegisteredHost();
      if (host) {
        return { ok: true, value: host };
      }
    }

    if (this.clients.size === 0) {
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

    const eligibleHosts = this.listEnterpriseHostsForNode(enterpriseContext.nodeId);
    if (command.command === "new_tab") {
      const host = eligibleHosts.at(-1);
      return host
        ? { ok: true, value: host }
        : { ok: false, payload: this.noBrowserHostFailure(requestId) };
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
    const affinityKey = getEnterpriseBrowserAffinityKey({
      workspaceId,
      browserProfileId: enterpriseContext.browserProfileId,
      browserId,
      homeNodeId: enterpriseContext.nodeId,
    });
    const ownerClientId = this.enterpriseBrowserHostByAffinity.get(affinityKey);
    const host = ownerClientId ? this.clients.get(ownerClientId) : undefined;
    if (host && this.isEnterpriseHostForNode(host, enterpriseContext.nodeId)) {
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
      selected = host;
    }
    return selected;
  }

  private listEnterpriseHostsForNode(nodeId: string): RegisteredBrowserHost[] {
    return Array.from(this.clients.values()).filter((host) =>
      this.isEnterpriseHostForNode(host, nodeId),
    );
  }

  private isEnterpriseHostForNode(host: RegisteredBrowserHost, nodeId: string): boolean {
    return host.client.enterpriseProfiles?.version === 1 && host.client.homeNodeId === nodeId;
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
  ): void {
    if (!payload.ok) {
      return;
    }

    if (request.enterpriseContext && request.workspaceId) {
      this.rememberEnterpriseBrowserHostForPayload(clientId, payload, {
        ...request,
        enterpriseContext: request.enterpriseContext,
        workspaceId: request.workspaceId,
      });
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
    request: BrowserAutomationExecuteRequest & {
      enterpriseContext: BrowserAutomationEnterpriseContext;
      workspaceId: string;
    },
  ): void {
    const affinityKey = (browserId: string): string =>
      getEnterpriseBrowserAffinityKey({
        workspaceId: request.workspaceId,
        browserProfileId: request.enterpriseContext.browserProfileId,
        browserId,
        homeNodeId: request.enterpriseContext.nodeId,
      });

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
    rememberAffinity?: boolean;
    timeoutMs: number;
  }): Promise<BrowserToolsResponsePayload> {
    const { host, request, timeoutMs } = params;
    const client = host.client;

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
        clientId: client.id,
        request,
        rememberAffinity: params.rememberAffinity ?? true,
        timeout,
        resolve,
      });

      try {
        Promise.resolve(client.sendBrowserAutomationRequest(request)).catch((error: unknown) => {
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
  workspaceId: string;
  browserProfileId: string;
  browserId: string;
  homeNodeId: string;
}): string {
  return JSON.stringify([
    input.workspaceId,
    input.browserProfileId,
    input.browserId,
    input.homeNodeId,
  ]);
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
  const hostKind = host.client.hostKind.trim();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
