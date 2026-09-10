import type {
  EnterpriseAction,
  GlobalResourceRef,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import {
  INBOUND_PERMISSION,
  OUTBOUND_PERMISSION,
  type PermissionRequirement,
} from "../../authorization/operation-permissions.js";
import {
  OUTBOUND_AUTHORITY_RECEIPT_POLICIES,
  OUTBOUND_DYNAMIC_RESOURCE_POLICY_EVENTS,
  OUTBOUND_INHERITED_CONTEXT_EVENTS,
  OUTBOUND_RESOURCE_ACTION_MAP,
  OUTBOUND_SELF_LIFECYCLE_EVENTS,
  OUTBOUND_TRANSPORT_CONTROL_ONLY_EVENTS,
  inboundActionsForRequestType,
} from "./event-action-map.js";

export type EnterpriseEntrySurface =
  | "session_inbound"
  | "session_outbound"
  | "file_binary"
  | "terminal_binary"
  | "http_download"
  | "push"
  | "browser_broker"
  | "websocket_direct_notification";

export type EnterpriseEntryAuthorizationLayer =
  | "operation_permission"
  | "resource_authorization"
  | "transport_control"
  | "authority_receipt";

export type EnterpriseEntryAuthoritySource =
  | "request_workspace_id"
  | "server_binding"
  | "principal_scope"
  | "outbound_resource_context"
  | "transport_control"
  | "authority_receipt"
  | "upload_id"
  | "download_token";

export interface EnterpriseEntryInventoryItem {
  readonly surface: EnterpriseEntrySurface;
  readonly entry: string;
  readonly direction: "inbound" | "outbound" | "bidirectional";
  readonly transport:
    | "session_json"
    | "file_binary"
    | "terminal_binary"
    | "http"
    | "push"
    | "browser_broker"
    | "websocket_direct";
  readonly daemonPermissions: readonly string[];
  readonly enterpriseActions: readonly EnterpriseAction[];
  readonly resourceKinds: readonly GlobalResourceRef["resourceKind"][];
  readonly authoritySource: EnterpriseEntryAuthoritySource;
  readonly workspaceIdPolicy:
    | "required_in_enterprise"
    | "server_resolved"
    | "not_applicable"
    | "contract_blocked";
  readonly authorizationLayers: readonly EnterpriseEntryAuthorizationLayer[];
  readonly wiringOwner: "W1" | "W3" | "W4" | "integration";
  readonly wiringGap:
    | "none"
    | "runtime_call_site"
    | "resource_correlation"
    | "binary_context"
    | "notification_context";
}

export const ENTERPRISE_ENTRY_INVENTORY_FIELDS = [
  "surface",
  "entry",
  "direction",
  "transport",
  "daemonPermissions",
  "enterpriseActions",
  "resourceKinds",
  "authoritySource",
  "workspaceIdPolicy",
  "authorizationLayers",
  "wiringOwner",
  "wiringGap",
] as const satisfies readonly (keyof EnterpriseEntryInventoryItem)[];

type InboundEntry = SessionInboundMessage["type"];
type OutboundEntry = SessionOutboundMessage["type"];

/** A new wire entry must receive an explicit review before exhaustiveness passes. */
export const REVIEWED_INBOUND_ENTRIES = [
  "abort_request",
  "agent.config.apply.request",
  "agent.detach.request",
  "agent.fork_context.request",
  "agent.provider_subagents.list.request",
  "agent.provider_subagents.timeline.get.request",
  "agent.rewind.request",
  "agent.skills.get_status.request",
  "agent.skills.import_legacy_selection.request",
  "agent.skills.reconcile.request",
  "agent.skills.save_selection.request",
  "agent.skills.uninstall.request",
  "agent.timeline.list_prompts.request",
  "agent.timeline.append.request",
  "session.events.set_subscription.request",
  "agent.timeline.set_subscription.request",
  "agent_permission_response",
  "archive_agent_request",
  "archive_workspace_request",
  "audio_played",
  "branch_suggestions_request",
  "browser.automation.execute.response",
  "cancel_agent_request",
  "capture_terminal_request",
  "chat/create",
  "chat/delete",
  "chat/inspect",
  "chat/list",
  "chat/post",
  "chat/read",
  "chat/wait",
  "checkout.commits.file_diff.request",
  "checkout.commits.list.request",
  "checkout.discard_changes.request",
  "checkout.forge.get_check_details.request",
  "checkout.forge.set_auto_merge.request",
  "checkout.github.get_check_details.request",
  "checkout.github.set_auto_merge.request",
  "checkout.refresh.request",
  "checkout.rename_branch.request",
  "checkout_commit_request",
  "checkout_merge_from_base_request",
  "checkout_merge_request",
  "checkout_pr_create_request",
  "checkout_pr_merge_request",
  "checkout_pr_status_request",
  "checkout_pull_request",
  "checkout_push_request",
  "checkout_status_request",
  "checkout_switch_branch_request",
  "clear_agent_attention",
  "client_heartbeat",
  "close_items_request",
  "create_agent_request",
  "create_paseo_worktree_request",
  "create_terminal_request",
  "daemon.config.reload.request",
  "daemon.get_pairing_offer.request",
  "daemon.get_status.request",
  "daemon.update.request",
  "delete_agent_request",
  "diagnostics.request",
  "dictation_stream_cancel",
  "dictation_stream_chunk",
  "dictation_stream_finish",
  "dictation_stream_start",
  "directory_suggestions_request",
  "enterprise.access.list_grants.request",
  "enterprise.access.update_grants.request",
  "enterprise.agent.content.read.request",
  "enterprise.app_slot.content.read.request",
  "enterprise.audit.list_events.request",
  "enterprise.browser.bind_profile.request",
  "enterprise.browser.list_profiles.request",
  "enterprise.browser.page_identity.observe.request",
  "enterprise.browser_profile.content.read.request",
  "enterprise.identity.get_current.request",
  "enterprise.identity.list_principals.request",
  "enterprise.identity.logout_all.request",
  "enterprise.node.list_nodes.request",
  "enterprise.node.set_drain.request",
  "enterprise.organization.list_resources.request",
  "enterprise.placement.resolve_workspace.request",
  "enterprise.resource.acquire_lease.request",
  "enterprise.resource.release_lease.request",
  "enterprise.resource.renew_lease.request",
  "enterprise.resource.ownership.transfer.request",
  "enterprise.workspace.content.read.request",
  "fetch_agent_history_request",
  "fetch_agent_request",
  "fetch_agent_timeline_request",
  "fetch_agents_request",
  "fetch_recent_provider_sessions_request",
  "fetch_workspaces_request",
  "file.upload.request",
  "file_download_token_request",
  "file_explorer_request",
  "forge.search.request",
  "fs.entry.create.request",
  "fs.entry.delete.request",
  "fs.entry.duplicate.request",
  "fs.entry.rename.request",
  "fs.file.subscribe.request",
  "fs.file.unsubscribe.request",
  "fs.file.write.request",
  "get_daemon_config_request",
  "get_providers_snapshot_request",
  "github_search_request",
  "hub.execution.agent.create.request",
  "hub.execution.agent.validate.request",
  "hub.execution.control.request",
  "hub.management.daemon.connect.request",
  "hub.management.daemon.disconnect.request",
  "hub.management.daemon.get_status.request",
  "hub.management.daemon.permissions.update.request",
  "import_agent_request",
  "kill_terminal_request",
  "list_available_editors_request",
  "list_available_providers_request",
  "list_commands_request",
  "list_provider_features_request",
  "list_provider_models_request",
  "list_provider_modes_request",
  "list_terminals_request",
  "loop/inspect",
  "loop/list",
  "loop/logs",
  "loop/run",
  "loop/stop",
  "open_in_editor_request",
  "open_project_request",
  "paseo_worktree_archive_request",
  "paseo_worktree_list_request",
  "ping",
  "plugin.catalog.get.request",
  "plugin.directory.inspect.request",
  "plugin.directory.install.request",
  "plugin.disable.request",
  "plugin.enable.request",
  "plugin.list.request",
  "plugin.logs.get.request",
  "plugin.reload.request",
  "plugin.remove.request",
  "plugin.rpc.invoke.request",
  "plugin.source.install.request",
  "plugin.source.status.request",
  "plugin.source.update.request",
  "project.add.request",
  "project.create_directory.request",
  "project.github.clone.request",
  "project.icon.get.request",
  "project.icon.set.request",
  "project.list.request",
  "project.remove.request",
  "project.rename.request",
  "project_icon_request",
  "provider.usage.list.request",
  "provider_diagnostic_request",
  "pull_request_timeline_request",
  "push.unregister.request",
  "read_project_config_request",
  "refresh_agent_request",
  "refresh_providers_snapshot_request",
  "register_push_token",
  "restart_server_request",
  "resume_agent_request",
  "schedule/create",
  "schedule/delete",
  "schedule/inspect",
  "schedule/list",
  "schedule/logs",
  "schedule/pause",
  "schedule/resume",
  "schedule/run-once",
  "schedule/update",
  "send_agent_message_request",
  "set_agent_feature_request",
  "set_agent_mode_request",
  "set_agent_model_request",
  "set_agent_thinking_request",
  "set_daemon_config_request",
  "set_voice_mode",
  "shutdown_server_request",
  "start_workspace_script_request",
  "stash_list_request",
  "stash_pop_request",
  "stash_save_request",
  "subscribe_checkout_diff_request",
  "subscribe_terminal_request",
  "subscribe_terminals_request",
  "terminal.rename.request",
  "terminal_input",
  "unsubscribe_checkout_diff_request",
  "unsubscribe_terminal_request",
  "unsubscribe_terminals_request",
  "update_agent_request",
  "validate_branch_request",
  "voice_audio_chunk",
  "wait_for_finish_request",
  "workspace.clear_attention.request",
  "workspace.mark_unread.request",
  "workspace.create.request",
  "workspace.github.search_repositories.request",
  "workspace.label.assignment.set.request",
  "workspace.label.delete.inspect.request",
  "workspace.label.delete.request",
  "workspace.label.list.request",
  "workspace.label.update.request",
  "workspace.pin.set.request",
  "workspace.recovery.inspect.request",
  "workspace.recovery.restore.request",
  "workspace.script.list.request",
  "workspace.script.start.request",
  "workspace.script.stop.request",
  "workspace.title.set.request",
  "workspace_setup_status_request",
  "workspace.setup.run.request",
  "write_project_config_request",
] as const satisfies readonly InboundEntry[];

const requestWorkspaceIdEntries = new Set<InboundEntry>([
  "chat/create",
  "create_agent_request",
  "directory_suggestions_request",
  "fetch_recent_provider_sessions_request",
  "file.upload.request",
  "file_download_token_request",
  "file_explorer_request",
  "fs.entry.create.request",
  "fs.entry.delete.request",
  "fs.entry.duplicate.request",
  "fs.entry.rename.request",
  "fs.file.subscribe.request",
  "fs.file.unsubscribe.request",
  "fs.file.write.request",
  "get_providers_snapshot_request",
  "list_provider_features_request",
  "list_provider_models_request",
  "list_provider_modes_request",
  "loop/run",
  "project.icon.get.request",
  "project.icon.set.request",
  "project_icon_request",
  "read_project_config_request",
  "refresh_providers_snapshot_request",
  "schedule/create",
  "schedule/run-once",
  "schedule/update",
  "write_project_config_request",
]);

const principalScopeEntries = new Set<InboundEntry>([
  "fetch_agents_request",
  "fetch_workspaces_request",
  "loop/list",
  "open_project_request",
  "project.add.request",
  "project.create_directory.request",
  "project.github.clone.request",
  "project.list.request",
  "schedule/list",
  "session.events.set_subscription.request",
  "workspace.create.request",
  "workspace.label.delete.inspect.request",
  "workspace.label.delete.request",
  "workspace.label.list.request",
  "workspace.label.update.request",
]);

const unresolvedResourceEntries = new Set<InboundEntry>([
  "dictation_stream_cancel",
  "dictation_stream_chunk",
  "dictation_stream_finish",
  "dictation_stream_start",
  "register_push_token",
  "voice_audio_chunk",
]);

const authorityReceiptPolicyByEvent = new Map(
  OUTBOUND_AUTHORITY_RECEIPT_POLICIES.map((policy) => [policy.event, policy] as const),
);

function normalizePermissions(permission: PermissionRequirement): readonly string[] {
  if (permission === null) return [];
  return typeof permission === "string" ? [permission] : permission;
}

function resourceKindsForActions(
  actions: readonly EnterpriseAction[],
  entry?: InboundEntry,
): readonly GlobalResourceRef["resourceKind"][] {
  if (entry === "enterprise.organization.list_resources.request")
    return ["workspace", "agent", "browser_profile", "app_slot"];
  if (actions.includes("browser.profile.manage") || actions.includes("browser.use"))
    return ["workspace", "agent", "browser_profile"];
  if (actions.includes("app.use")) return ["workspace", "agent", "app_slot"];
  if (actions.some((action) => action === "identity.manage" || action === "audit.read")) return [];
  return actions.length > 0 ? ["workspace", "agent"] : [];
}

function inventoryItem(item: EnterpriseEntryInventoryItem): EnterpriseEntryInventoryItem {
  return item;
}

function inboundAuthoritySource(
  entry: InboundEntry,
  unresolved: boolean,
  hasResourcePolicy: boolean,
): EnterpriseEntryAuthoritySource {
  if (entry === "ping") return "transport_control";
  if (unresolved) return "server_binding";
  if (requestWorkspaceIdEntries.has(entry)) return "request_workspace_id";
  if (principalScopeEntries.has(entry) || !hasResourcePolicy) return "principal_scope";
  return "server_binding";
}

function inboundWorkspaceIdPolicy(
  authoritySource: EnterpriseEntryAuthoritySource,
  unresolved: boolean,
  hasResourcePolicy: boolean,
): EnterpriseEntryInventoryItem["workspaceIdPolicy"] {
  if (unresolved) return "contract_blocked";
  if (authoritySource === "request_workspace_id") return "required_in_enterprise";
  return hasResourcePolicy ? "server_resolved" : "not_applicable";
}

function inboundAuthorizationLayers(
  entry: InboundEntry,
  hasResourcePolicy: boolean,
): readonly EnterpriseEntryAuthorizationLayer[] {
  if (entry === "ping") return ["operation_permission", "transport_control"];
  return hasResourcePolicy
    ? ["operation_permission", "resource_authorization"]
    : ["operation_permission"];
}

function inboundInventoryItem(entry: InboundEntry): EnterpriseEntryInventoryItem {
  const actions = inboundActionsForRequestType(entry) ?? [];
  const unresolved = unresolvedResourceEntries.has(entry);
  const hasResourcePolicy = actions.length > 0;
  const authoritySource = inboundAuthoritySource(entry, unresolved, hasResourcePolicy);
  return inventoryItem({
    surface: "session_inbound",
    entry,
    direction: "inbound",
    transport: "session_json",
    daemonPermissions: normalizePermissions(INBOUND_PERMISSION[entry]),
    enterpriseActions: actions,
    resourceKinds: resourceKindsForActions(actions, entry),
    authoritySource,
    workspaceIdPolicy: inboundWorkspaceIdPolicy(authoritySource, unresolved, hasResourcePolicy),
    authorizationLayers: inboundAuthorizationLayers(entry, hasResourcePolicy),
    wiringOwner: "W3",
    wiringGap: unresolved ? "resource_correlation" : "runtime_call_site",
  });
}

function outboundActions(entry: OutboundEntry): readonly EnterpriseAction[] {
  const receipt = authorityReceiptPolicyByEvent.get(entry);
  if (receipt) return receipt.enterpriseActions;
  if (OUTBOUND_DYNAMIC_RESOURCE_POLICY_EVENTS.includes(entry as "status"))
    return ["workspace.write"];
  const policy = OUTBOUND_RESOURCE_ACTION_MAP.get(entry);
  return policy ? [...new Set(Object.values(policy).flat())] : [];
}

function outboundResourceKinds(entry: OutboundEntry): readonly GlobalResourceRef["resourceKind"][] {
  const policy = OUTBOUND_RESOURCE_ACTION_MAP.get(entry);
  if (policy)
    return Object.entries(policy)
      .filter(([, values]) => values.length > 0)
      .map(([kind]) => kind) as GlobalResourceRef["resourceKind"][];
  return OUTBOUND_DYNAMIC_RESOURCE_POLICY_EVENTS.includes(entry as "status")
    ? ["workspace", "agent"]
    : [];
}

function outboundAuthoritySource(entry: OutboundEntry): EnterpriseEntryAuthoritySource {
  if (authorityReceiptPolicyByEvent.has(entry)) return "authority_receipt";
  if (OUTBOUND_DYNAMIC_RESOURCE_POLICY_EVENTS.includes(entry as "status"))
    return "authority_receipt";
  if (
    OUTBOUND_SELF_LIFECYCLE_EVENTS.includes(
      entry as (typeof OUTBOUND_SELF_LIFECYCLE_EVENTS)[number],
    )
  )
    return "authority_receipt";
  if (OUTBOUND_TRANSPORT_CONTROL_ONLY_EVENTS.includes(entry as "pong")) return "transport_control";
  return "outbound_resource_context";
}

function outboundAuthorizationLayers(
  entry: OutboundEntry,
): readonly EnterpriseEntryAuthorizationLayer[] {
  if (authorityReceiptPolicyByEvent.has(entry))
    return ["operation_permission", "authority_receipt"];
  if (
    OUTBOUND_SELF_LIFECYCLE_EVENTS.includes(
      entry as (typeof OUTBOUND_SELF_LIFECYCLE_EVENTS)[number],
    )
  )
    return ["authority_receipt"];
  if (OUTBOUND_INHERITED_CONTEXT_EVENTS.includes(entry as "rpc_error"))
    return ["resource_authorization", "authority_receipt"];
  if (OUTBOUND_TRANSPORT_CONTROL_ONLY_EVENTS.includes(entry as "pong"))
    return ["operation_permission", "transport_control"];
  if (OUTBOUND_DYNAMIC_RESOURCE_POLICY_EVENTS.includes(entry as "status"))
    return [
      "operation_permission",
      "resource_authorization",
      "transport_control",
      "authority_receipt",
    ];
  return ["operation_permission", "resource_authorization"];
}

function outboundWiringGap(entry: OutboundEntry): EnterpriseEntryInventoryItem["wiringGap"] {
  if (authorityReceiptPolicyByEvent.has(entry)) return "runtime_call_site";
  if (OUTBOUND_DYNAMIC_RESOURCE_POLICY_EVENTS.includes(entry as "status"))
    return "runtime_call_site";
  if (OUTBOUND_INHERITED_CONTEXT_EVENTS.includes(entry as "rpc_error")) return "runtime_call_site";
  if (
    OUTBOUND_SELF_LIFECYCLE_EVENTS.includes(
      entry as (typeof OUTBOUND_SELF_LIFECYCLE_EVENTS)[number],
    )
  )
    return "runtime_call_site";
  return "runtime_call_site";
}

function outboundInventoryItem(entry: OutboundEntry): EnterpriseEntryInventoryItem {
  const policy = OUTBOUND_RESOURCE_ACTION_MAP.get(entry);
  const dynamic = OUTBOUND_DYNAMIC_RESOURCE_POLICY_EVENTS.includes(entry as "status");
  const selfLifecycle = OUTBOUND_SELF_LIFECYCLE_EVENTS.includes(
    entry as (typeof OUTBOUND_SELF_LIFECYCLE_EVENTS)[number],
  );
  return inventoryItem({
    surface: "session_outbound",
    entry,
    direction: "outbound",
    transport: "session_json",
    daemonPermissions: normalizePermissions(OUTBOUND_PERMISSION[entry]),
    enterpriseActions: outboundActions(entry),
    resourceKinds: outboundResourceKinds(entry),
    authoritySource: outboundAuthoritySource(entry),
    workspaceIdPolicy: policy || dynamic ? "server_resolved" : "not_applicable",
    authorizationLayers: outboundAuthorizationLayers(entry),
    wiringOwner: selfLifecycle ? "W1" : "W3",
    wiringGap: outboundWiringGap(entry),
  });
}

const reviewedOutboundEntries: readonly OutboundEntry[] = [
  ...OUTBOUND_RESOURCE_ACTION_MAP.keys(),
  ...OUTBOUND_DYNAMIC_RESOURCE_POLICY_EVENTS,
  ...OUTBOUND_AUTHORITY_RECEIPT_POLICIES.map((policy) => policy.event),
  ...OUTBOUND_SELF_LIFECYCLE_EVENTS,
  ...OUTBOUND_INHERITED_CONTEXT_EVENTS,
  ...OUTBOUND_TRANSPORT_CONTROL_ONLY_EVENTS,
];

const nonUnionEntries: readonly EnterpriseEntryInventoryItem[] = [
  inventoryItem({
    surface: "file_binary",
    entry: "file.upload",
    direction: "inbound",
    transport: "file_binary",
    daemonPermissions: ["workspace.write"],
    enterpriseActions: ["workspace.write"],
    resourceKinds: ["workspace"],
    authoritySource: "upload_id",
    workspaceIdPolicy: "required_in_enterprise",
    authorizationLayers: ["operation_permission", "resource_authorization"],
    wiringOwner: "W3",
    wiringGap: "binary_context",
  }),
  inventoryItem({
    surface: "file_binary",
    entry: "file.download",
    direction: "outbound",
    transport: "file_binary",
    daemonPermissions: ["workspace.read"],
    enterpriseActions: ["workspace.content.read"],
    resourceKinds: ["workspace"],
    authoritySource: "download_token",
    workspaceIdPolicy: "server_resolved",
    authorizationLayers: ["operation_permission", "resource_authorization"],
    wiringOwner: "W3",
    wiringGap: "binary_context",
  }),
  inventoryItem({
    surface: "terminal_binary",
    entry: "terminal.input",
    direction: "inbound",
    transport: "terminal_binary",
    daemonPermissions: ["workspace.write"],
    enterpriseActions: ["terminal.use"],
    resourceKinds: ["workspace", "agent"],
    authoritySource: "server_binding",
    workspaceIdPolicy: "server_resolved",
    authorizationLayers: ["operation_permission", "resource_authorization"],
    wiringOwner: "W3",
    wiringGap: "binary_context",
  }),
  inventoryItem({
    surface: "terminal_binary",
    entry: "terminal.stream",
    direction: "outbound",
    transport: "terminal_binary",
    daemonPermissions: ["workspace.read"],
    enterpriseActions: ["terminal.use"],
    resourceKinds: ["workspace", "agent"],
    authoritySource: "outbound_resource_context",
    workspaceIdPolicy: "server_resolved",
    authorizationLayers: ["operation_permission", "resource_authorization"],
    wiringOwner: "W3",
    wiringGap: "binary_context",
  }),
  inventoryItem({
    surface: "http_download",
    entry: "file.download",
    direction: "outbound",
    transport: "http",
    daemonPermissions: ["workspace.read"],
    enterpriseActions: ["workspace.content.read"],
    resourceKinds: ["workspace"],
    authoritySource: "download_token",
    workspaceIdPolicy: "server_resolved",
    authorizationLayers: ["operation_permission", "resource_authorization"],
    wiringOwner: "W3",
    wiringGap: "binary_context",
  }),
  inventoryItem({
    surface: "push",
    entry: "push.notification",
    direction: "outbound",
    transport: "push",
    daemonPermissions: ["workspace.read"],
    enterpriseActions: ["workspace.metadata.read"],
    resourceKinds: ["workspace", "agent"],
    authoritySource: "outbound_resource_context",
    workspaceIdPolicy: "server_resolved",
    authorizationLayers: ["operation_permission", "resource_authorization"],
    wiringOwner: "W3",
    wiringGap: "notification_context",
  }),
  inventoryItem({
    surface: "browser_broker",
    entry: "browser.profile.bind",
    direction: "bidirectional",
    transport: "browser_broker",
    daemonPermissions: ["access.manage"],
    enterpriseActions: ["browser.profile.manage"],
    resourceKinds: ["browser_profile"],
    authoritySource: "server_binding",
    workspaceIdPolicy: "not_applicable",
    authorizationLayers: ["operation_permission", "resource_authorization"],
    wiringOwner: "W4",
    wiringGap: "runtime_call_site",
  }),
  inventoryItem({
    surface: "websocket_direct_notification",
    entry: "websocket.direct_notification",
    direction: "outbound",
    transport: "websocket_direct",
    daemonPermissions: [],
    enterpriseActions: [],
    resourceKinds: [],
    authoritySource: "authority_receipt",
    workspaceIdPolicy: "not_applicable",
    authorizationLayers: ["authority_receipt"],
    wiringOwner: "integration",
    wiringGap: "notification_context",
  }),
];

export const ENTERPRISE_ENTRY_INVENTORY: readonly EnterpriseEntryInventoryItem[] = [
  ...REVIEWED_INBOUND_ENTRIES.map(inboundInventoryItem),
  ...reviewedOutboundEntries.map(outboundInventoryItem),
  ...nonUnionEntries,
];

export function entriesForSurface(
  surface: EnterpriseEntrySurface,
): readonly EnterpriseEntryInventoryItem[] {
  return ENTERPRISE_ENTRY_INVENTORY.filter((item) => item.surface === surface);
}
