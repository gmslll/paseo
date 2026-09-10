import type {
  EnterpriseAction,
  GlobalResourceRef,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { PermissionRequirement } from "../../authorization/operation-permissions.js";
import { INBOUND_PERMISSION } from "../../authorization/operation-permissions.js";

export interface OutboundResourceActionPolicy {
  readonly workspace: readonly EnterpriseAction[];
  readonly agent: readonly EnterpriseAction[];
  readonly browser_profile: readonly EnterpriseAction[];
  readonly app_slot: readonly EnterpriseAction[];
}

interface OutboundResourceActionGroup {
  readonly events: readonly SessionOutboundMessage["type"][];
  readonly policy: OutboundResourceActionPolicy;
}

export interface OutboundAuthorityReceiptPolicy {
  readonly event: SessionOutboundMessage["type"];
  readonly status?: "restart_requested" | "shutdown_requested";
  readonly requestType: SessionInboundMessage["type"];
  readonly daemonPermission: PermissionRequirement;
  readonly enterpriseActions: readonly EnterpriseAction[];
  readonly emission: "repeatable" | "terminal";
}

function authorityReceiptPolicy(
  event: SessionOutboundMessage["type"],
  requestType: SessionInboundMessage["type"],
  enterpriseActions: readonly EnterpriseAction[] = noActions,
  emission: OutboundAuthorityReceiptPolicy["emission"] = "terminal",
): OutboundAuthorityReceiptPolicy {
  return Object.freeze({
    event,
    requestType,
    daemonPermission: clonePermissionRequirement(INBOUND_PERMISSION[requestType]),
    enterpriseActions: Object.freeze([...enterpriseActions]),
    emission,
  });
}

const noActions = Object.freeze([]) as readonly [];

function workspacePolicy(...actions: EnterpriseAction[]): OutboundResourceActionPolicy {
  return {
    workspace: actions,
    agent: actions,
    browser_profile: noActions,
    app_slot: noActions,
  };
}

const browserUsePolicy: OutboundResourceActionPolicy = {
  workspace: ["browser.use"],
  agent: ["browser.use"],
  browser_profile: ["browser.use"],
  app_slot: noActions,
};

const browserManagePolicy: OutboundResourceActionPolicy = {
  workspace: ["browser.profile.manage"],
  agent: ["browser.profile.manage"],
  browser_profile: ["browser.profile.manage"],
  app_slot: noActions,
};
const browserListProfilesPolicy: OutboundResourceActionPolicy = {
  workspace: ["workspace.metadata.read"],
  agent: noActions,
  browser_profile: ["browser.use", "browser.profile.manage"],
  app_slot: noActions,
};

const executionResourcePolicy: OutboundResourceActionPolicy = {
  workspace: ["browser.use", "app.use"],
  agent: ["browser.use", "app.use"],
  browser_profile: ["browser.use"],
  app_slot: ["app.use"],
};

const organizationResourcePolicy: OutboundResourceActionPolicy = {
  workspace: ["workspace.metadata.read"],
  agent: ["workspace.metadata.read"],
  browser_profile: ["workspace.metadata.read"],
  app_slot: ["workspace.metadata.read"],
};

export const INBOUND_ENTERPRISE_ACTION_OVERRIDES: Partial<
  Record<SessionInboundMessage["type"], readonly EnterpriseAction[]>
> = {
  "browser.automation.execute.response": ["browser.use"],
  capture_terminal_request: ["terminal.use"],
  client_heartbeat: ["workspace.metadata.read"],
  create_terminal_request: ["terminal.use"],
  "enterprise.access.list_grants.request": ["identity.manage"],
  "enterprise.access.update_grants.request": ["identity.manage"],
  "enterprise.audit.list_events.request": ["audit.read"],
  "enterprise.browser.bind_profile.request": ["browser.profile.manage"],
  "enterprise.browser.list_profiles.request": ["workspace.metadata.read"],
  "enterprise.browser.page_identity.observe.request": [],
  "enterprise.identity.list_principals.request": ["identity.manage"],
  "enterprise.organization.list_resources.request": ["workspace.metadata.read"],
  "enterprise.placement.resolve_workspace.request": ["workspace.metadata.read"],
  "enterprise.workspace.content.read.request": ["workspace.content.read"],
  "enterprise.agent.content.read.request": ["workspace.content.read"],
  "enterprise.browser_profile.content.read.request": ["browser.use"],
  "enterprise.app_slot.content.read.request": ["app.use"],
  "enterprise.resource.acquire_lease.request": ["browser.use", "app.use"],
  "enterprise.resource.release_lease.request": ["browser.use", "app.use"],
  "enterprise.resource.renew_lease.request": ["browser.use", "app.use"],
  "enterprise.resource.ownership.transfer.request": ["workspace.manage"],
  fetch_recent_provider_sessions_request: ["provider.history.read"],
  fetch_workspaces_request: ["workspace.metadata.read"],
  import_agent_request: ["provider.history.import"],
  kill_terminal_request: ["terminal.use"],
  list_available_editors_request: ["workspace.editor.open"],
  list_provider_features_request: ["workspace.metadata.read"],
  list_provider_models_request: ["workspace.metadata.read"],
  list_provider_modes_request: ["workspace.metadata.read"],
  list_terminals_request: ["terminal.use"],
  open_in_editor_request: ["workspace.editor.open"],
  paseo_worktree_list_request: ["workspace.metadata.read"],
  "project.list.request": ["workspace.metadata.read"],
  read_project_config_request: ["workspace.script.configure"],
  "session.events.set_subscription.request": ["workspace.metadata.read"],
  start_workspace_script_request: ["workspace.script.execute"],
  subscribe_terminal_request: ["terminal.use"],
  subscribe_terminals_request: ["terminal.use"],
  "terminal.rename.request": ["terminal.use"],
  terminal_input: ["terminal.use"],
  unsubscribe_terminal_request: ["terminal.use"],
  unsubscribe_terminals_request: ["terminal.use"],
  "workspace.label.list.request": ["workspace.metadata.read"],
  "workspace.script.list.request": ["workspace.script.configure"],
  "workspace.script.start.request": ["workspace.script.execute"],
  "workspace.script.stop.request": ["workspace.script.execute"],
  "workspace.setup.run.request": ["workspace.script.execute"],
  workspace_setup_status_request: ["workspace.script.execute"],
  write_project_config_request: ["workspace.script.configure"],
};

export const OUTBOUND_RESOURCE_ACTION_GROUPS: readonly OutboundResourceActionGroup[] = [
  {
    policy: {
      workspace: ["workspace.content.read"],
      agent: ["workspace.content.read"],
      browser_profile: ["browser.use"],
      app_slot: ["app.use"],
    },
    events: [
      "enterprise.workspace.content.read.response",
      "enterprise.agent.content.read.response",
      "enterprise.browser_profile.content.read.response",
      "enterprise.app_slot.content.read.response",
    ],
  },
  {
    policy: workspacePolicy("workspace.metadata.read"),
    events: [
      "agent_status",
      "agent_update",
      "agent_attention_required",
      "agent_archived",
      "agent_deleted",
      "fetch_workspaces_response",
      "project.update",
      "project.list.response",
      "workspace.label.list.response",
      "workspace.label.update",
      "workspace.label.delete.inspect.response",
      "workspace_update",
      "enterprise.placement.resolve_workspace.response",
      "session.events.set_subscription.response",
      "agent.timeline.set_subscription.response",
      "list_provider_models_response",
      "list_provider_modes_response",
      "list_provider_features_response",
      "get_providers_snapshot_response",
      "providers_snapshot_update",
      "refresh_providers_snapshot_response",
    ],
  },
  {
    policy: workspacePolicy("workspace.content.read"),
    events: [
      "activity_log",
      "agent.fork_context.response",
      "agent.provider_subagents.list.response",
      "agent.provider_subagents.timeline.get.response",
      "agent.provider_subagents.update",
      "agent.timeline.list_prompts.response",
      "agent.timeline.replacement",
      "agent_permission_request",
      "agent_stream",
      "artifact",
      "assistant_chunk",
      "audio_output",
      "branch_suggestions_response",
      "chat/inspect/response",
      "chat/list/response",
      "chat/read/response",
      "chat/wait/response",
      "checkout.commits.file_diff.response",
      "checkout.commits.list.response",
      "checkout.forge.get_check_details.response",
      "checkout.github.get_check_details.response",
      "checkout.refresh.response",
      "checkout_diff_update",
      "checkout_pr_status_response",
      "checkout_status_response",
      "checkout_status_update",
      "directory_suggestions_response",
      "fetch_agent_history_response",
      "fetch_agent_response",
      "fetch_agent_timeline_response",
      "fetch_agents_response",
      "file_download_token_response",
      "file_explorer_response",
      "forge.search.response",
      "fs.file.subscribe.response",
      "fs.file.unsubscribe.response",
      "fs.file.update",
      "github_search_response",
      "list_commands_response",
      "project.icon.get.response",
      "project_icon_response",
      "pull_request_timeline_response",
      "stash_list_response",
      "subscribe_checkout_diff_response",
      "transcription_result",
      "validate_branch_response",
      "wait_for_finish_response",
      "workspace.github.search_repositories.response",
      "workspace.recovery.inspect.response",
    ],
  },
  {
    policy: workspacePolicy("workspace.write"),
    events: [
      "agent.config.apply.response",
      "agent.detach.response",
      "agent.rewind.response",
      "agent.timeline.append.response",
      "agent_permission_resolved",
      "cancel_agent_response",
      "chat/create/response",
      "chat/delete/response",
      "chat/post/response",
      "checkout.discard_changes.response",
      "checkout.forge.set_auto_merge.response",
      "checkout.github.set_auto_merge.response",
      "checkout.rename_branch.response",
      "checkout_commit_response",
      "checkout_merge_from_base_response",
      "checkout_merge_response",
      "checkout_pr_create_response",
      "checkout_pr_merge_response",
      "checkout_pull_response",
      "checkout_push_response",
      "checkout_switch_branch_response",
      "clear_agent_attention_response",
      "file.upload.response",
      "fs.entry.create.response",
      "fs.entry.delete.response",
      "fs.entry.duplicate.response",
      "fs.entry.rename.response",
      "fs.file.write.response",
      "hub.execution.agent.create.response",
      "hub.execution.agent.validate.response",
      "hub.execution.control.response",
      "send_agent_message_response",
      "set_agent_feature_response",
      "set_agent_mode_response",
      "set_agent_model_response",
      "set_agent_thinking_response",
      "set_voice_mode_response",
      "stash_pop_response",
      "stash_save_response",
      "update_agent_response",
      "dictation_stream_ack",
      "dictation_stream_error",
      "dictation_stream_final",
      "dictation_stream_finish_accepted",
      "dictation_stream_partial",
      "voice_input_state",
      "workspace.clear_attention.response",
      "workspace.mark_unread.response",
    ],
  },
  {
    policy: workspacePolicy("workspace.manage"),
    events: [
      "archive_workspace_response",
      "close_items_response",
      "create_paseo_worktree_response",
      "loop/inspect/response",
      "loop/list/response",
      "loop/logs/response",
      "loop/run/response",
      "loop/stop/response",
      "open_project_response",
      "paseo_worktree_archive_response",
      "paseo_worktree_list_response",
      "project.add.response",
      "project.create_directory.response",
      "project.github.clone.response",
      "project.icon.set.response",
      "project.remove.response",
      "project.rename.response",
      "schedule/create/response",
      "schedule/delete/response",
      "schedule/inspect/response",
      "schedule/list/response",
      "schedule/logs/response",
      "schedule/pause/response",
      "schedule/resume/response",
      "schedule/run-once/response",
      "schedule/update/response",
      "workspace.create.response",
      "workspace.label.assignment.set.response",
      "workspace.label.delete.response",
      "workspace.label.update.response",
      "workspace.pin.set.response",
      "workspace.recovery.restore.response",
      "workspace.title.set.response",
    ],
  },
  {
    policy: workspacePolicy("terminal.use"),
    events: [
      "capture_terminal_response",
      "create_terminal_response",
      "kill_terminal_response",
      "list_terminals_response",
      "subscribe_terminal_response",
      "terminal.rename.response",
      "terminal_attention_required",
      "terminal_stream_exit",
      "terminals_changed",
    ],
  },
  {
    policy: workspacePolicy("provider.history.read"),
    events: ["fetch_recent_provider_sessions_response"],
  },
  {
    policy: workspacePolicy("workspace.script.execute"),
    events: [
      "script_status_update",
      "start_workspace_script_response",
      "workspace.script.start.response",
      "workspace.script.stop.response",
      "workspace.setup.run.response",
      "workspace_setup_progress",
      "workspace_setup_status_response",
    ],
  },
  {
    policy: workspacePolicy("workspace.script.configure"),
    events: [
      "read_project_config_response",
      "workspace.script.list.response",
      "write_project_config_response",
    ],
  },
  {
    policy: workspacePolicy("workspace.editor.open"),
    events: ["list_available_editors_response", "open_in_editor_response"],
  },
  {
    policy: browserUsePolicy,
    events: ["browser.automation.execute.request"],
  },
  {
    policy: browserListProfilesPolicy,
    events: ["enterprise.browser.list_profiles.response"],
  },
  {
    policy: browserManagePolicy,
    events: ["enterprise.browser.bind_profile.response"],
  },
  {
    policy: executionResourcePolicy,
    events: [
      "enterprise.resource.acquire_lease.response",
      "enterprise.resource.release_lease.response",
      "enterprise.resource.renew_lease.response",
      "enterprise.resource.status",
      "enterprise.resource.waiting",
    ],
  },
  {
    policy: organizationResourcePolicy,
    events: ["enterprise.organization.list_resources.response"],
  },
  {
    policy: workspacePolicy("workspace.content.read"),
    events: ["hub.execution.agent.stream"],
  },
  {
    policy: workspacePolicy("workspace.metadata.read"),
    events: ["hub.execution.agent.update"],
  },
];

/**
 * `status` is an open envelope. Only its Agent subtypes are resource-scoped;
 * `server_info` is transport control and every daemon/plugin/unknown subtype
 * must fail closed at ResourceAuthorization.
 */
export const OUTBOUND_DYNAMIC_RESOURCE_POLICY_EVENTS = [
  "status",
] as const satisfies readonly SessionOutboundMessage["type"][];

export const OUTBOUND_TRANSPORT_CONTROL_ONLY_EVENTS = [
  "pong",
] as const satisfies readonly SessionOutboundMessage["type"][];

export const OUTBOUND_AUTHORITY_RECEIPT_POLICIES = Object.freeze([
  authorityReceiptPolicy("agent.skills.get_status.response", "agent.skills.get_status.request"),
  authorityReceiptPolicy(
    "enterprise.resource.ownership.transfer.response",
    "enterprise.resource.ownership.transfer.request",
    ["workspace.manage"],
  ),
  authorityReceiptPolicy(
    "agent.skills.import_legacy_selection.response",
    "agent.skills.import_legacy_selection.request",
  ),
  authorityReceiptPolicy("agent.skills.reconcile.response", "agent.skills.reconcile.request"),
  authorityReceiptPolicy(
    "agent.skills.save_selection.response",
    "agent.skills.save_selection.request",
  ),
  authorityReceiptPolicy("agent.skills.uninstall.response", "agent.skills.uninstall.request"),
  authorityReceiptPolicy("daemon.config.reload.response", "daemon.config.reload.request"),
  authorityReceiptPolicy("daemon.get_pairing_offer.response", "daemon.get_pairing_offer.request"),
  authorityReceiptPolicy("daemon.get_status.response", "daemon.get_status.request"),
  authorityReceiptPolicy(
    "daemon.update.progress",
    "daemon.update.request",
    noActions,
    "repeatable",
  ),
  authorityReceiptPolicy("daemon.update.response", "daemon.update.request"),
  authorityReceiptPolicy("diagnostics.response", "diagnostics.request"),
  authorityReceiptPolicy(
    "enterprise.access.list_grants.response",
    "enterprise.access.list_grants.request",
    ["identity.manage"],
  ),
  authorityReceiptPolicy(
    "enterprise.access.update_grants.response",
    "enterprise.access.update_grants.request",
    ["identity.manage"],
  ),
  authorityReceiptPolicy(
    "enterprise.audit.list_events.response",
    "enterprise.audit.list_events.request",
    ["audit.read"],
  ),
  authorityReceiptPolicy(
    "enterprise.identity.list_principals.response",
    "enterprise.identity.list_principals.request",
    ["identity.manage"],
  ),
  authorityReceiptPolicy(
    "enterprise.identity.get_current.response",
    "enterprise.identity.get_current.request",
    noActions,
  ),
  authorityReceiptPolicy(
    "enterprise.identity.logout_all.response",
    "enterprise.identity.logout_all.request",
    noActions,
  ),
  authorityReceiptPolicy(
    "enterprise.node.list_nodes.response",
    "enterprise.node.list_nodes.request",
  ),
  authorityReceiptPolicy("enterprise.node.set_drain.response", "enterprise.node.set_drain.request"),
  authorityReceiptPolicy("get_daemon_config_response", "get_daemon_config_request"),
  authorityReceiptPolicy(
    "hub.management.daemon.connect.response",
    "hub.management.daemon.connect.request",
  ),
  authorityReceiptPolicy(
    "hub.management.daemon.disconnect.response",
    "hub.management.daemon.disconnect.request",
  ),
  authorityReceiptPolicy(
    "hub.management.daemon.get_status.response",
    "hub.management.daemon.get_status.request",
  ),
  authorityReceiptPolicy(
    "hub.management.daemon.permissions.update.response",
    "hub.management.daemon.permissions.update.request",
  ),
  authorityReceiptPolicy("list_available_providers_response", "list_available_providers_request"),
  authorityReceiptPolicy("plugin.catalog.get.response", "plugin.catalog.get.request"),
  authorityReceiptPolicy("plugin.directory.inspect.response", "plugin.directory.inspect.request"),
  authorityReceiptPolicy("plugin.directory.install.response", "plugin.directory.install.request"),
  authorityReceiptPolicy("plugin.disable.response", "plugin.disable.request"),
  authorityReceiptPolicy("plugin.enable.response", "plugin.enable.request"),
  authorityReceiptPolicy("plugin.list.response", "plugin.list.request"),
  authorityReceiptPolicy("plugin.logs.get.response", "plugin.logs.get.request"),
  authorityReceiptPolicy("plugin.reload.response", "plugin.reload.request"),
  authorityReceiptPolicy("plugin.remove.response", "plugin.remove.request"),
  authorityReceiptPolicy("plugin.rpc.invoke.response", "plugin.rpc.invoke.request"),
  authorityReceiptPolicy("plugin.source.install.response", "plugin.source.install.request"),
  authorityReceiptPolicy("plugin.source.status.response", "plugin.source.status.request"),
  authorityReceiptPolicy("plugin.source.update.response", "plugin.source.update.request"),
  authorityReceiptPolicy("provider.usage.list.response", "provider.usage.list.request"),
  authorityReceiptPolicy("provider_diagnostic_response", "provider_diagnostic_request"),
  authorityReceiptPolicy("push.unregister.response", "push.unregister.request"),
  authorityReceiptPolicy("set_daemon_config_response", "set_daemon_config_request"),
] as const satisfies readonly OutboundAuthorityReceiptPolicy[]);

export const OUTBOUND_STATUS_AUTHORITY_RECEIPT_POLICIES = Object.freeze([
  Object.freeze({
    event: "status",
    status: "restart_requested",
    requestType: "restart_server_request",
    daemonPermission: clonePermissionRequirement(INBOUND_PERMISSION.restart_server_request),
    enterpriseActions: noActions,
    emission: "terminal",
  }),
  Object.freeze({
    event: "status",
    status: "shutdown_requested",
    requestType: "shutdown_server_request",
    daemonPermission: clonePermissionRequirement(INBOUND_PERMISSION.shutdown_server_request),
    enterpriseActions: noActions,
    emission: "terminal",
  }),
] as const satisfies readonly OutboundAuthorityReceiptPolicy[]);

export const ALL_OUTBOUND_AUTHORITY_RECEIPT_POLICIES = Object.freeze([
  ...OUTBOUND_AUTHORITY_RECEIPT_POLICIES,
  ...OUTBOUND_STATUS_AUTHORITY_RECEIPT_POLICIES,
] as const satisfies readonly OutboundAuthorityReceiptPolicy[]);

export const OUTBOUND_SELF_LIFECYCLE_EVENTS = [
  "enterprise.identity.credential_revoked",
  "enterprise.identity.scope_refreshed",
] as const satisfies readonly SessionOutboundMessage["type"][];

export const OUTBOUND_INHERITED_CONTEXT_EVENTS = [
  "rpc_error",
  "enterprise.browser.page_identity.observe.response",
] as const satisfies readonly SessionOutboundMessage["type"][];

export const OUTBOUND_EVENTS_WITHOUT_RESOURCE_POLICY = [
  ...OUTBOUND_AUTHORITY_RECEIPT_POLICIES.map((policy) => policy.event),
  ...OUTBOUND_SELF_LIFECYCLE_EVENTS,
  ...OUTBOUND_INHERITED_CONTEXT_EVENTS,
] as const satisfies readonly SessionOutboundMessage["type"][];

const outboundResourceActionMap = new Map<
  SessionOutboundMessage["type"],
  OutboundResourceActionPolicy
>();
for (const group of OUTBOUND_RESOURCE_ACTION_GROUPS) {
  for (const event of group.events) {
    if (outboundResourceActionMap.has(event)) {
      throw new Error(`Duplicate outbound resource action policy for ${event}`);
    }
    outboundResourceActionMap.set(event, group.policy);
  }
}

export const OUTBOUND_RESOURCE_ACTION_MAP: ReadonlyMap<
  SessionOutboundMessage["type"],
  OutboundResourceActionPolicy
> = outboundResourceActionMap;

const outboundAuthorityReceiptPolicyMap = new Map(
  OUTBOUND_AUTHORITY_RECEIPT_POLICIES.map((policy) => [policy.event, policy] as const),
);
const outboundAuthorityReceiptPolicyByRequestType = new Map<
  SessionInboundMessage["type"],
  OutboundAuthorityReceiptPolicy
>();
for (const policy of ALL_OUTBOUND_AUTHORITY_RECEIPT_POLICIES) {
  const existing = outboundAuthorityReceiptPolicyByRequestType.get(policy.requestType);
  if (
    existing &&
    (!samePermissionRequirement(existing.daemonPermission, policy.daemonPermission) ||
      !sameUniqueStrings(existing.enterpriseActions, policy.enterpriseActions))
  ) {
    throw new Error(`Conflicting authority receipt policy for ${policy.requestType}`);
  }
  if (!existing) outboundAuthorityReceiptPolicyByRequestType.set(policy.requestType, policy);
}

export function authorityReceiptPolicyForRequestType(
  requestType: string,
): OutboundAuthorityReceiptPolicy | null {
  if (!Object.hasOwn(INBOUND_PERMISSION, requestType)) return null;
  return (
    outboundAuthorityReceiptPolicyByRequestType.get(requestType as SessionInboundMessage["type"]) ??
    null
  );
}

export function authorityReceiptPolicyForEvent(
  event: SessionOutboundMessage,
): OutboundAuthorityReceiptPolicy | null {
  if (event.type === "rpc_error") {
    if (!event.payload.requestType) return null;
    const requestPolicy = outboundAuthorityReceiptPolicyByRequestType.get(
      event.payload.requestType as SessionInboundMessage["type"],
    );
    return requestPolicy
      ? Object.freeze({ ...requestPolicy, event: "rpc_error", emission: "terminal" })
      : null;
  }
  if (event.type === "status") {
    const status = event.payload.status;
    return (
      OUTBOUND_STATUS_AUTHORITY_RECEIPT_POLICIES.find((policy) => policy.status === status) ?? null
    );
  }
  return outboundAuthorityReceiptPolicyMap.get(event.type) ?? null;
}

export function outboundActionsFor(
  event: SessionOutboundMessage,
  resourceKind: GlobalResourceRef["resourceKind"],
): readonly EnterpriseAction[] {
  if (event.type === "rpc_error") {
    const actions = event.payload.requestType
      ? inboundActionsForRequestType(event.payload.requestType)
      : null;
    return actions?.filter((action) => actionAppliesToResource(action, resourceKind)) ?? noActions;
  }
  if (event.type === "status") {
    if (
      event.payload.status === "agent_created" ||
      event.payload.status === "agent_create_failed" ||
      event.payload.status === "agent_resumed" ||
      event.payload.status === "agent_refreshed"
    ) {
      return resourceKind === "workspace" || resourceKind === "agent"
        ? (["workspace.write"] as const)
        : noActions;
    }
    return noActions;
  }
  return OUTBOUND_RESOURCE_ACTION_MAP.get(event.type)?.[resourceKind] ?? noActions;
}

export function inboundActionsForRequestType(
  requestType: string,
): readonly EnterpriseAction[] | null {
  if (!Object.hasOwn(INBOUND_PERMISSION, requestType)) return null;
  const entry = requestType as SessionInboundMessage["type"];
  const override = INBOUND_ENTERPRISE_ACTION_OVERRIDES[entry];
  if (override) return override;
  const permission = INBOUND_PERMISSION[entry];
  let permissions: readonly string[] = noActions;
  if (typeof permission === "string") permissions = [permission];
  else if (permission) permissions = permission;
  if (permissions.includes("workspace.manage")) return ["workspace.manage"];
  if (permissions.includes("workspace.write")) return ["workspace.write"];
  if (permissions.includes("workspace.read")) return ["workspace.content.read"];
  if (permissions.includes("automation.manage")) return ["workspace.manage"];
  if (permissions.includes("hub.execute")) return ["workspace.write"];
  return noActions;
}

function actionAppliesToResource(
  action: EnterpriseAction,
  resourceKind: GlobalResourceRef["resourceKind"],
): boolean {
  if (action === "identity.manage" || action === "audit.read") return false;
  if (action === "browser.use" || action === "browser.profile.manage")
    return resourceKind !== "app_slot";
  if (action === "app.use") return resourceKind !== "browser_profile";
  return resourceKind === "workspace" || resourceKind === "agent";
}

export function isMatchingTransportControl(
  event: SessionOutboundMessage,
  control: "pong" | "server_info",
): boolean {
  if (control === "pong") return event.type === "pong";
  return event.type === "status" && event.payload.status === "server_info";
}

function clonePermissionRequirement(requirement: PermissionRequirement): PermissionRequirement {
  return Array.isArray(requirement) ? Object.freeze([...requirement]) : requirement;
}

function samePermissionRequirement(
  left: PermissionRequirement,
  right: PermissionRequirement,
): boolean {
  if (left === null || right === null) return left === right;
  const leftValues = typeof left === "string" ? [left] : [...left];
  const rightValues = typeof right === "string" ? [right] : [...right];
  return sameUniqueStrings(leftValues, rightValues);
}

function sameUniqueStrings(left: readonly string[], right: readonly string[]): boolean {
  if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}
