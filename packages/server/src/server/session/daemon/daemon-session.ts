import type pino from "pino";
import type { ManagedRuntimeControl } from "../../managed-runtimes/runtime-manager.js";
import type { LocalPlaneAccess } from "../../local-planes/local-plane-access.js";
import type { DataPlaneDocHandler } from "../../local-planes/data-plane-access.js";
import type { OrchestrationOperationControl } from "../../orchestration/operation-service.js";
import { OperationStatusSchema } from "../../orchestration/operation-store.js";
import { toOrchestrationOperationSummary } from "../../orchestration/operation-summary.js";
import type { ProviderAvailability } from "../../agent/agent-manager.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { getPidLockInfo } from "../../pid-lock.js";
import { generateLocalPairingOffer } from "../../pairing-offer.js";
import {
  collectDaemonDiagnostics,
  type DaemonWebSocketRuntimeDiagnosticSnapshot,
} from "./diagnostics.js";
import { DaemonSelfUpdateSessionController } from "./daemon-self-update-session-controller.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../../workspace-registry.js";
import type { HubRelationshipManagement } from "../../hub/relationship-controller.js";
import type { DaemonConfigReloadResult } from "../../daemon-config-store.js";

const MANAGED_RUNTIMES_UNAVAILABLE = "Managed Agent runtimes are unavailable on this daemon";
const ORCHESTRATION_UNAVAILABLE = "Delegation operations are unavailable on this daemon";
const DEFAULT_LISTED_OPERATIONS = 50;

export type OrchestrationOperationRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "orchestration.operation.list.request"
      | "orchestration.operation.get.request"
      | "orchestration.operation.cancel.request";
  }
>;

function orchestrationOperationResponse(
  orchestration: OrchestrationOperationControl,
  msg: OrchestrationOperationRequest,
): SessionOutboundMessage {
  switch (msg.type) {
    case "orchestration.operation.list.request":
      return {
        type: "orchestration.operation.list.response",
        payload: {
          requestId: msg.requestId,
          operations: orchestration
            .listOperations({
              requesterAgentId: msg.requesterAgentId,
              status:
                msg.status === undefined ? undefined : OperationStatusSchema.parse(msg.status),
              limit: msg.limit ?? DEFAULT_LISTED_OPERATIONS,
            })
            .map(toOrchestrationOperationSummary),
        },
      };
    case "orchestration.operation.get.request": {
      const operation = orchestration.getOperation(msg);
      return {
        type: "orchestration.operation.get.response",
        payload: {
          requestId: msg.requestId,
          operation: operation ? toOrchestrationOperationSummary(operation) : null,
        },
      };
    }
    case "orchestration.operation.cancel.request":
      return {
        type: "orchestration.operation.cancel.response",
        payload: {
          requestId: msg.requestId,
          operation: toOrchestrationOperationSummary(orchestration.cancel(msg)),
        },
      };
  }
}

export interface DaemonRuntimeConfig {
  listen: string | null;
  worktreesRoot?: string;
  appBaseUrl?: string;
  desktopManaged?: boolean;
  managedRuntimes?: ManagedRuntimeControl;
  orchestration?: OrchestrationOperationControl;
  /** Whether the local control plane is accepting Sessions (ADR-0038). */
  localPlanes?: () => boolean;
  /** Attach tokens and the endpoint for the terminal plane, while it is listening (ADR-0038). */
  terminalPlane?: LocalPlaneAccess;
  /** The same for the data plane, which listens only when a document handler is configured. */
  dataPlane?: LocalPlaneAccess;
  dataPlaneDocHandler?: DataPlaneDocHandler;
  getRelayConfig(): {
    enabled: boolean;
    endpoint: string;
    publicEndpoint: string;
    useTls: boolean;
    publicUseTls: boolean;
  } | null;
}

export interface DaemonSessionHost {
  emit(msg: SessionOutboundMessage): void;
  emitLifecycleIntent(intent: {
    type: "restart";
    clientId: string;
    requestId: string;
    reason: string;
  }): void;
}

export interface DaemonSessionOptions {
  host: DaemonSessionHost;
  clientId: string;
  paseoHome: string;
  serverId: string | undefined;
  daemonVersion: string | undefined;
  daemonRuntimeConfig: DaemonRuntimeConfig | undefined;
  listAgents: () => ManagedAgent[];
  listProjects: () => Promise<PersistedProjectRecord[]>;
  listWorkspaces: () => Promise<PersistedWorkspaceRecord[]>;
  listProviderAvailability: () => Promise<ProviderAvailability[]>;
  getWebSocketRuntimeMetrics?: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
  logger: pino.Logger;
  hubRelationships?: HubRelationshipManagement;
  reloadConfig: () => DaemonConfigReloadResult;
}

/**
 * A client's read surface for the daemon process itself: its runtime status
 * (pid-lock start time, listen address, relay config, provider availability) and
 * a fresh local pairing offer for connecting a new client. Owns the `daemon.*`
 * RPCs. Reaches no state beyond the never-mutated runtime values injected at
 * construction and the outbound channel.
 */
export class DaemonSession {
  private readonly host: DaemonSessionHost;
  private readonly clientId: string;
  private readonly paseoHome: string;
  private readonly serverId: string | undefined;
  private readonly daemonVersion: string | undefined;
  private readonly daemonRuntimeConfig: DaemonRuntimeConfig | undefined;
  private readonly listAgents: () => ManagedAgent[];
  private readonly listProjects: () => Promise<PersistedProjectRecord[]>;
  private readonly listWorkspaces: () => Promise<PersistedWorkspaceRecord[]>;
  private readonly listProviderAvailability: () => Promise<ProviderAvailability[]>;
  private readonly getWebSocketRuntimeMetrics: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
  private readonly logger: pino.Logger;
  private readonly selfUpdate: DaemonSelfUpdateSessionController;
  private readonly hubRelationships: HubRelationshipManagement | null;
  private readonly reloadConfig: () => DaemonConfigReloadResult;

  constructor(options: DaemonSessionOptions) {
    this.host = options.host;
    this.clientId = options.clientId;
    this.paseoHome = options.paseoHome;
    this.serverId = options.serverId;
    this.daemonVersion = options.daemonVersion;
    this.daemonRuntimeConfig = options.daemonRuntimeConfig;
    this.listAgents = options.listAgents;
    this.listProjects = options.listProjects;
    this.listWorkspaces = options.listWorkspaces;
    this.listProviderAvailability = options.listProviderAvailability;
    this.getWebSocketRuntimeMetrics = options.getWebSocketRuntimeMetrics ?? (() => null);
    this.logger = options.logger;
    this.hubRelationships = options.hubRelationships ?? null;
    this.reloadConfig = options.reloadConfig;
    this.selfUpdate = new DaemonSelfUpdateSessionController({
      clientId: this.clientId,
      daemonVersion: this.daemonVersion ?? null,
      desktopManaged: this.daemonRuntimeConfig?.desktopManaged === true,
      emit: (msg) => this.host.emit(msg),
      emitLifecycleIntent: (intent) => this.host.emitLifecycleIntent(intent),
      sessionLogger: this.logger,
    });
  }

  async handleHubRelationshipRequest(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "hub.management.daemon.connect.request"
          | "hub.management.daemon.get_status.request"
          | "hub.management.daemon.disconnect.request"
          | "hub.management.daemon.permissions.update.request";
      }
    >,
  ): Promise<void> {
    try {
      if (!this.hubRelationships) throw new Error("Hub relationship management is unavailable");
      if (msg.type === "hub.management.daemon.connect.request") {
        const status = await this.hubRelationships.connect({
          hubUrl: msg.hubUrl,
          token: msg.token,
          permissions: msg.permissions,
        });
        this.host.emit({
          type: "hub.management.daemon.connect.response",
          payload: { requestId: msg.requestId, status },
        });
        return;
      }
      if (msg.type === "hub.management.daemon.permissions.update.request") {
        const status = await this.hubRelationships.updatePermissions({
          grant: msg.grant,
          revoke: msg.revoke,
        });
        this.host.emit({
          type: "hub.management.daemon.permissions.update.response",
          payload: { requestId: msg.requestId, status },
        });
        return;
      }
      if (msg.type === "hub.management.daemon.disconnect.request") {
        const result = await this.hubRelationships.disconnect({ force: msg.force ?? false });
        this.host.emit({
          type: "hub.management.daemon.disconnect.response",
          payload: { requestId: msg.requestId, ...result },
        });
        return;
      }
      this.host.emit({
        type: "hub.management.daemon.get_status.response",
        payload: { requestId: msg.requestId, status: this.hubRelationships.status() },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle Hub relationship request");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error instanceof Error ? error.message : String(error),
          code: "handler_error",
        },
      });
    }
  }

  async handleGetStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.get_status.request" }>,
  ): Promise<void> {
    try {
      const pidInfo = await getPidLockInfo(this.paseoHome);
      const providers = (await this.listProviderAvailability()).map((p) => ({
        provider: p.provider,
        available: p.available,
        error: p.error ?? null,
      }));
      this.host.emit({
        type: "daemon.get_status.response",
        payload: {
          requestId: msg.requestId,
          serverId: this.serverId ?? "",
          version: this.daemonVersion ?? null,
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: pidInfo?.startedAt ?? null,
          listen: this.daemonRuntimeConfig?.listen ?? null,
          relay: this.daemonRuntimeConfig?.getRelayConfig() ?? null,
          providers,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle daemon status request");
      this.host.emit({
        type: "daemon.get_status.response",
        payload: {
          requestId: msg.requestId,
          serverId: this.serverId ?? "",
          version: this.daemonVersion ?? null,
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: null,
          listen: null,
          relay: null,
          providers: [],
        },
      });
    }
  }

  async handleRuntimeStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.runtime.get_status.request" }>,
  ): Promise<void> {
    await this.respondWithService(
      msg,
      this.daemonRuntimeConfig?.managedRuntimes,
      MANAGED_RUNTIMES_UNAVAILABLE,
      async (runtimes) => ({
        type: "daemon.runtime.get_status.response",
        payload: { requestId: msg.requestId, runtimes: await runtimes.status() },
      }),
    );
  }

  async handleRuntimeInstallRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.runtime.install.request" }>,
  ): Promise<void> {
    await this.respondWithService(
      msg,
      this.daemonRuntimeConfig?.managedRuntimes,
      MANAGED_RUNTIMES_UNAVAILABLE,
      async (runtimes) => ({
        type: "daemon.runtime.install.response",
        payload: { requestId: msg.requestId, runtime: await runtimes.install(msg.runtimeName) },
      }),
    );
  }

  async handleOrchestrationOperationRequest(msg: OrchestrationOperationRequest): Promise<void> {
    this.host.emit(await this.buildOrchestrationOperationResponse(msg));
  }

  /** Builds the response, or a correlated rpc_error, without emitting it. */
  buildOrchestrationOperationResponse(
    msg: OrchestrationOperationRequest,
  ): Promise<SessionOutboundMessage> {
    return this.buildServiceResponse(
      msg,
      this.daemonRuntimeConfig?.orchestration,
      ORCHESTRATION_UNAVAILABLE,
      async (orchestration) => orchestrationOperationResponse(orchestration, msg),
    );
  }

  private async respondWithService<T>(
    msg: { type: string; requestId: string },
    service: T | undefined,
    unavailableMessage: string,
    respond: (service: T) => Promise<SessionOutboundMessage>,
  ): Promise<void> {
    this.host.emit(await this.buildServiceResponse(msg, service, unavailableMessage, respond));
  }

  private async buildServiceResponse<T>(
    msg: { type: string; requestId: string },
    service: T | undefined,
    unavailableMessage: string,
    respond: (service: T) => Promise<SessionOutboundMessage>,
  ): Promise<SessionOutboundMessage> {
    try {
      if (!service) {
        throw new Error(unavailableMessage);
      }
      return await respond(service);
    } catch (error) {
      this.logger.error(
        { err: error, requestType: msg.type },
        "Failed to handle daemon service request",
      );
      return {
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error instanceof Error ? error.message : String(error),
          code: "handler_error",
        },
      };
    }
  }

  async handleGetPairingOfferRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.get_pairing_offer.request" }>,
  ): Promise<void> {
    try {
      const relay = this.daemonRuntimeConfig?.getRelayConfig();
      const pairing = await generateLocalPairingOffer({
        paseoHome: this.paseoHome,
        relayEnabled: relay?.enabled ?? false,
        relayEndpoint: relay?.endpoint,
        relayPublicEndpoint: relay?.publicEndpoint,
        relayUseTls: relay?.useTls,
        relayPublicUseTls: relay?.publicUseTls,
        appBaseUrl: this.daemonRuntimeConfig?.appBaseUrl,
        includeQr: true,
        logger: this.logger,
      });
      this.host.emit({
        type: "daemon.get_pairing_offer.response",
        payload: {
          requestId: msg.requestId,
          url: pairing.url ?? "",
          qr: pairing.qr ?? null,
          relayEnabled: pairing.relayEnabled,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle daemon pairing offer request");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: "daemon.get_pairing_offer.request",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  handleConfigReloadRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.config.reload.request" }>,
  ): void {
    try {
      this.host.emit({
        type: "daemon.config.reload.response",
        payload: { requestId: msg.requestId, ...this.reloadConfig() },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to reload daemon config");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error instanceof Error ? error.message : String(error),
          code: "handler_error",
        },
      });
    }
  }

  async handleDiagnosticsRequest(
    msg: Extract<SessionInboundMessage, { type: "diagnostics.request" }>,
  ): Promise<void> {
    try {
      const diagnostic = await collectDaemonDiagnostics({
        paseoHome: this.paseoHome,
        serverId: this.serverId,
        daemonVersion: this.daemonVersion,
        daemonRuntimeConfig: this.daemonRuntimeConfig,
        listAgents: this.listAgents,
        listProjects: this.listProjects,
        listWorkspaces: this.listWorkspaces,
        listProviderAvailability: this.listProviderAvailability,
        getWebSocketRuntimeMetrics: this.getWebSocketRuntimeMetrics,
        logger: this.logger,
      });
      this.host.emit({
        type: "diagnostics.response",
        payload: {
          requestId: msg.requestId,
          diagnostic,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle diagnostics request");
      this.host.emit({
        type: "diagnostics.response",
        payload: {
          requestId: msg.requestId,
          diagnostic: `Paseo diagnostics\n  Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
  }

  async handleUpdateRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.update.request" }>,
  ): Promise<void> {
    await this.selfUpdate.dispatch(msg);
  }
}
