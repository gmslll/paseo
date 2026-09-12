/* oxlint-disable complexity, react-perf/jsx-no-new-function-as-prop */
import {
  ENTERPRISE_ACTIONS,
  EnterpriseIdentityListPrincipalsResponseSchema,
  type EnterpriseAction,
  type EnterpriseOrganizationResourceProjection,
  type EnterprisePrincipalRecord,
  type ResourceGrant,
} from "@getpaseo/protocol/messages";
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import type { BossResourceStore } from "@/stores/enterprise/boss-resource-store";
import type { BrowserBindingFormModel } from "./forms/browser-binding-form-model";
import type { GrantEditorFormModel } from "./forms/grant-editor-form-model";
import type { EnterprisePrincipalDirectoryPort } from "./enterprise-ui-port";

type WorkspaceProjection = Extract<
  EnterpriseOrganizationResourceProjection,
  { resourceKind: "workspace" }
>;

export type EnterpriseGrantEditorFactory<TGeneration extends string> = (
  principalId: string,
) => GrantEditorFormModel<TGeneration>;

export type EnterpriseBrowserBindingFactory<TGeneration extends string> = (
  workspace: WorkspaceProjection,
) => BrowserBindingFormModel<TGeneration>;

interface EnterpriseAdminControlsProps<TContent, TGeneration extends string> {
  readonly principalPort: EnterprisePrincipalDirectoryPort<TGeneration>;
  readonly bossStore: BossResourceStore<TContent, TGeneration>;
  readonly generation: TGeneration;
  readonly currentPrincipalId: string;
  readonly organizationId: string;
  readonly createGrantEditor?: EnterpriseGrantEditorFactory<TGeneration>;
  readonly createBrowserBinding?: EnterpriseBrowserBindingFactory<TGeneration>;
  readonly canViewPrincipals: boolean;
  readonly canViewGrants: boolean;
  readonly canManageGrants: boolean;
  readonly canViewProfiles: boolean;
  readonly canBindProfiles: boolean;
  readonly createRequestId: () => string;
}

type PrincipalDirectoryState =
  | { readonly status: "loading"; readonly requestId: string }
  | { readonly status: "loaded"; readonly principals: readonly EnterprisePrincipalRecord[] }
  | { readonly status: "failed" }
  | { readonly status: "not_requested" };

const EMPTY_PRINCIPALS: readonly EnterprisePrincipalRecord[] = Object.freeze([]);

const ACTION_LABELS: Readonly<Record<EnterpriseAction, string>> = Object.freeze({
  "workspace.metadata.read": "查看工作空间和智能体名称",
  "workspace.content.read": "读取工作空间和智能体内容",
  "workspace.write": "发送消息和修改工作空间内容",
  "workspace.manage": "创建和管理工作空间及智能体",
  "browser.use": "使用已分配的浏览器配置",
  "browser.profile.manage": "管理浏览器配置",
  "app.use": "使用已分配的应用执行位",
  "audit.read": "查看审计记录",
  "identity.manage": "管理员工和权限",
  "terminal.use": "使用终端",
  "provider.history.read": "读取模型提供方历史记录",
  "provider.history.import": "导入模型提供方历史记录",
  "workspace.script.execute": "运行工作空间脚本",
  "workspace.script.configure": "配置工作空间脚本",
  "workspace.editor.open": "打开工作空间编辑器",
});

const MUTATION_STATUS_LABELS = Object.freeze({
  idle: "空闲",
  pending: "处理中",
  success: "已完成",
  failed: "失败",
});

const PRINCIPAL_TYPE_LABELS = Object.freeze({
  human: "员工",
  service: "服务账号",
  break_glass_owner: "应急管理员",
});
const PRINCIPAL_STATUS_LABELS = Object.freeze({
  active: "已启用",
  disabled: "已停用",
  revoked: "已撤销",
});

const PROFILE_STATUS_LABELS = Object.freeze({
  ready: "可用",
  login_required: "需要登录",
  mfa_required: "需要多重验证",
  risk_control: "风控限制",
  disabled: "已停用",
});

const PROFILE_PLATFORM_LABELS = Object.freeze({
  douyin: "抖音",
  pinduoduo: "拼多多",
  taobao: "淘宝",
  feishu_web: "飞书网页版",
  generic: "通用网站",
});

function principalLabel(principal: EnterprisePrincipalRecord, currentPrincipalId: string): string {
  const label = principal.displayName ?? principal.principalId;
  return principal.principalId === currentPrincipalId ? `${label}（当前账号）` : label;
}

function scopeKeyForGrant(grant: ResourceGrant): string[] {
  switch (grant.selector.kind) {
    case "self":
      return ["self"];
    case "organization":
      return [`organization:${grant.selector.organizationId}`];
    case "workspace":
      return grant.selector.workspaceIds.map((workspaceId) => `workspace:${workspaceId}`);
  }
}

function grantMatchesScope(
  grant: ResourceGrant,
  action: EnterpriseAction,
  scopeKey: string,
): boolean {
  return grant.action === action && scopeKeyForGrant(grant).includes(scopeKey);
}

function updateGrantForScope(
  grants: readonly ResourceGrant[],
  action: EnterpriseAction,
  scopeKey: string,
  enabled: boolean,
  organizationId: string,
): readonly ResourceGrant[] {
  if (enabled && grants.some((grant) => grantMatchesScope(grant, action, scopeKey))) return grants;
  if (scopeKey.startsWith("workspace:")) {
    const workspaceId = scopeKey.slice("workspace:".length);
    const next = grants.flatMap((grant): ResourceGrant[] => {
      if (grant.action !== action || grant.selector.kind !== "workspace") return [grant];
      const workspaceIds = grant.selector.workspaceIds.filter(
        (candidate) => candidate !== workspaceId,
      );
      return workspaceIds.length === 0
        ? []
        : [{ action: grant.action, selector: { kind: "workspace", workspaceIds } }];
    });
    return enabled
      ? [...next, { action, selector: { kind: "workspace", workspaceIds: [workspaceId] } }]
      : next;
  }
  const next = grants.filter((grant) => !grantMatchesScope(grant, action, scopeKey));
  if (!enabled) return next;
  return [
    ...next,
    {
      action,
      selector: scopeKey === "self" ? { kind: "self" } : { kind: "organization", organizationId },
    },
  ];
}

function useOwnedGrantEditor<TGeneration extends string>(
  factory: EnterpriseGrantEditorFactory<TGeneration> | undefined,
  principalId: string | undefined,
  generation: TGeneration,
  createRequestId: () => string,
) {
  const model = useMemo(
    () => (factory && principalId ? factory(principalId) : undefined),
    [factory, principalId],
  );
  useEffect(() => {
    if (!model) return;
    model.setSessionGeneration(generation);
    void model.load({ requestId: createRequestId(), sessionGeneration: generation });
    return () => model.close();
  }, [createRequestId, generation, model]);
  return model;
}

function useOwnedBrowserBinding<TGeneration extends string>(
  factory: EnterpriseBrowserBindingFactory<TGeneration> | undefined,
  workspace: WorkspaceProjection | undefined,
  generation: TGeneration,
  createRequestId: () => string,
) {
  const model = useMemo(
    () => (factory && workspace ? factory(workspace) : undefined),
    [factory, workspace],
  );
  useEffect(() => {
    if (!model) return;
    model.setSessionGeneration(generation);
    void model.load({ requestId: createRequestId(), sessionGeneration: generation });
    return () => model.close();
  }, [createRequestId, generation, model]);
  return model;
}

function GrantEditorControls<TGeneration extends string>({
  model,
  generation,
  organizationId,
  workspaces,
  canManage,
  createRequestId,
}: {
  readonly model: GrantEditorFormModel<TGeneration>;
  readonly generation: TGeneration;
  readonly organizationId: string;
  readonly workspaces: readonly WorkspaceProjection[];
  readonly canManage: boolean;
  readonly createRequestId: () => string;
}) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [scopeKey, setScopeKey] = useState(`organization:${organizationId}`);
  const scopeOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      {
        id: "scope-self",
        value: "self",
        label: "本人资源",
        description: "由该员工拥有的资源",
      },
      {
        id: "scope-organization",
        value: `organization:${organizationId}`,
        label: "整个组织",
        description: "组织内的全部现有资源",
      },
      ...workspaces.map((workspace) => ({
        id: `scope-workspace-${workspace.workspaceId}`,
        value: `workspace:${workspace.workspaceId}`,
        label: workspace.label,
        description: `工作空间 · 节点 ${workspace.nodeId}`,
      })),
    ],
    [organizationId, workspaces],
  );
  const selectedScope = scopeOptions.find((option) => option.value === scopeKey) ?? null;
  const selectedScopeDisplay = useMemo(
    () =>
      selectedScope ? { label: selectedScope.label, description: selectedScope.description } : null,
    [selectedScope],
  );

  return (
    <View style={styles.section} testID="enterprise-admin-grant-editor">
      <View style={styles.row}>
        <Text style={styles.subtitle}>员工权限</Text>
        <StatusBadge
          label={MUTATION_STATUS_LABELS[snapshot.mutation.status]}
          variant={snapshot.mutation.status === "failed" ? "error" : "muted"}
        />
      </View>
      <SelectField
        label="权限范围"
        value={scopeKey}
        selectedDisplay={selectedScopeDisplay}
        options={scopeOptions}
        onChange={(value) => setScopeKey(value)}
        placeholder="选择权限范围"
        emptyText="暂无可用范围"
        testID="enterprise-admin-grant-scope"
        triggerTestID="enterprise-admin-grant-scope-trigger"
      />
      {snapshot.server.status === "loading" ? (
        <Text style={styles.muted}>正在加载当前权限…</Text>
      ) : null}
      {snapshot.server.status === "failed" ? (
        <View style={styles.feedback}>
          <Text style={styles.error}>无法加载权限。</Text>
          <Button
            size="sm"
            variant="outline"
            onPress={() =>
              void model.load({ requestId: createRequestId(), sessionGeneration: generation })
            }
            testID="enterprise-admin-retry-grants"
          >
            重试
          </Button>
        </View>
      ) : null}
      {snapshot.server.status === "loaded" ? (
        <View style={styles.permissionList}>
          {ENTERPRISE_ACTIONS.map((action) => {
            const enabled = snapshot.draft.some((grant) =>
              grantMatchesScope(grant, action, scopeKey),
            );
            return (
              <View key={action} style={styles.permissionRow}>
                <Text style={styles.body}>{ACTION_LABELS[action]}</Text>
                <Switch
                  value={enabled}
                  disabled={!canManage || snapshot.mutation.status === "pending"}
                  accessibilityLabel={`${ACTION_LABELS[action]}，当前所选范围`}
                  onValueChange={(value) => {
                    model.setDraft(
                      updateGrantForScope(snapshot.draft, action, scopeKey, value, organizationId),
                    );
                  }}
                  testID={`enterprise-admin-grant-${action}`}
                />
              </View>
            );
          })}
        </View>
      ) : null}
      {snapshot.mutation.status === "success" ? (
        <Text style={styles.success}>权限已保存。</Text>
      ) : null}
      {snapshot.mutation.status === "failed" ? (
        <Text style={styles.error}>无法保存权限，请重新加载后再试。</Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          disabled={!snapshot.canEdit}
          loading={snapshot.server.status === "loading"}
          onPress={() =>
            void model.load({ requestId: createRequestId(), sessionGeneration: generation })
          }
          testID="enterprise-admin-load-grants"
        >
          重新加载
        </Button>
        {canManage ? (
          <Button
            size="sm"
            disabled={!snapshot.canSubmit}
            loading={snapshot.mutation.status === "pending"}
            onPress={() =>
              void model.submit({ requestId: createRequestId(), sessionGeneration: generation })
            }
            testID="enterprise-admin-save-grants"
          >
            保存权限
          </Button>
        ) : null}
      </View>
    </View>
  );
}

function BrowserBindingControls<TGeneration extends string>({
  model,
  generation,
  canBind,
  createRequestId,
}: {
  readonly model: BrowserBindingFormModel<TGeneration>;
  readonly generation: TGeneration;
  readonly canBind: boolean;
  readonly createRequestId: () => string;
}) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const profileOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      snapshot.server.profiles.map((profile) => ({
        id: profile.browserProfileId,
        value: profile.browserProfileId,
        label: profile.label,
        description: `${PROFILE_PLATFORM_LABELS[profile.platform]} · ${PROFILE_STATUS_LABELS[profile.status]}`,
      })),
    [snapshot.server.profiles],
  );
  const selectedProfile =
    profileOptions.find((option) => option.value === snapshot.draftBrowserProfileId) ?? null;
  const selectedProfileDisplay = useMemo(
    () =>
      selectedProfile
        ? { label: selectedProfile.label, description: selectedProfile.description }
        : null,
    [selectedProfile],
  );
  return (
    <View style={styles.section} testID="enterprise-admin-browser-binding">
      <View style={styles.row}>
        <Text style={styles.subtitle}>浏览器配置绑定</Text>
        <StatusBadge
          label={MUTATION_STATUS_LABELS[snapshot.mutation.status]}
          variant={snapshot.mutation.status === "failed" ? "error" : "muted"}
        />
      </View>
      {snapshot.server.status === "loading" ? (
        <Text style={styles.muted}>正在加载浏览器配置…</Text>
      ) : null}
      {snapshot.server.status === "failed" ? (
        <Text style={styles.error}>无法加载浏览器配置。</Text>
      ) : null}
      {snapshot.server.status === "loaded" ? (
        <SelectField
          label="浏览器配置"
          value={snapshot.draftBrowserProfileId}
          selectedDisplay={selectedProfileDisplay}
          options={profileOptions}
          onChange={(profileId) => model.selectProfile(profileId)}
          placeholder="选择浏览器配置"
          emptyText="此节点尚未注册浏览器配置"
          disabled={!canBind || snapshot.mutation.status === "pending"}
          testID="enterprise-admin-browser-profile"
          triggerTestID="enterprise-admin-browser-profile-trigger"
        />
      ) : null}
      {snapshot.mutation.status === "success" ? (
        <Text style={styles.success}>浏览器配置已绑定。</Text>
      ) : null}
      {snapshot.mutation.status === "failed" ? (
        <Text style={styles.error}>无法绑定此浏览器配置。</Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          disabled={!snapshot.canEdit}
          loading={snapshot.server.status === "loading"}
          onPress={() =>
            void model.load({ requestId: createRequestId(), sessionGeneration: generation })
          }
          testID="enterprise-admin-load-profiles"
        >
          重新加载
        </Button>
        {canBind ? (
          <Button
            size="sm"
            disabled={!snapshot.canSubmit}
            loading={snapshot.mutation.status === "pending"}
            onPress={() =>
              void model.submit({ requestId: createRequestId(), sessionGeneration: generation })
            }
            testID="enterprise-admin-bind-profile"
          >
            绑定配置
          </Button>
        ) : null}
      </View>
    </View>
  );
}

export function EnterpriseAdminControls<TContent, TGeneration extends string>({
  principalPort,
  bossStore,
  generation,
  currentPrincipalId,
  organizationId,
  createGrantEditor,
  createBrowserBinding,
  canViewPrincipals,
  canViewGrants,
  canManageGrants,
  canViewProfiles,
  canBindProfiles,
  createRequestId,
}: EnterpriseAdminControlsProps<TContent, TGeneration>) {
  const bossSnapshot = useSyncExternalStore(
    bossStore.subscribe,
    bossStore.getSnapshot,
    bossStore.getSnapshot,
  );
  const [directory, setDirectory] = useState<PrincipalDirectoryState>({
    status: "not_requested",
  });
  const [selectedPrincipalId, setSelectedPrincipalId] = useState<string>();
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<string>();

  const startPrincipalLoad = useCallback(() => {
    const controller = new AbortController();
    const requestId = createRequestId();
    setDirectory({ status: "loading", requestId });
    void principalPort
      .listPrincipals({ requestId, sessionGeneration: generation, signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return undefined;
        const parsed =
          EnterpriseIdentityListPrincipalsResponseSchema.shape.payload.safeParse(response);
        if (!parsed.success || parsed.data.requestId !== requestId) {
          setDirectory({ status: "failed" });
          return undefined;
        }
        setDirectory({
          status: "loaded",
          principals: Object.freeze(parsed.data.principals),
        });
        return undefined;
      })
      .catch(() => {
        if (!controller.signal.aborted) setDirectory({ status: "failed" });
        return undefined;
      });
    return controller;
  }, [createRequestId, generation, principalPort]);

  useEffect(() => {
    if (!canViewPrincipals || !canViewGrants || !createGrantEditor) return;
    const controller = startPrincipalLoad();
    return () => controller.abort();
  }, [canViewGrants, canViewPrincipals, createGrantEditor, startPrincipalLoad]);

  useEffect(() => {
    if (bossSnapshot.metadata.status === "not_requested" && (canViewProfiles || canViewGrants)) {
      void bossStore.loadMetadata(generation);
    }
  }, [bossSnapshot.metadata.status, bossStore, canViewGrants, canViewProfiles, generation]);

  const principals = directory.status === "loaded" ? directory.principals : EMPTY_PRINCIPALS;
  const principalOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      principals.map((principal) => ({
        id: principal.principalId,
        value: principal.principalId,
        label: principalLabel(principal, currentPrincipalId),
        description: `${PRINCIPAL_TYPE_LABELS[principal.principalType]} · ${PRINCIPAL_STATUS_LABELS[principal.status]}`,
      })),
    [currentPrincipalId, principals],
  );
  const defaultPrincipal =
    principals.find(
      (principal) =>
        principal.principalType === "human" && principal.principalId !== currentPrincipalId,
    ) ?? principals[0];
  const effectivePrincipalId = principals.some(
    (principal) => principal.principalId === selectedPrincipalId,
  )
    ? selectedPrincipalId
    : defaultPrincipal?.principalId;
  const selectedPrincipal =
    principalOptions.find((option) => option.value === effectivePrincipalId) ?? null;
  const selectedPrincipalDisplay = useMemo(
    () =>
      selectedPrincipal
        ? { label: selectedPrincipal.label, description: selectedPrincipal.description }
        : null,
    [selectedPrincipal],
  );

  const workspaces = useMemo(
    () =>
      bossSnapshot.metadata.status === "loaded"
        ? bossSnapshot.metadata.resources.filter(
            (resource): resource is WorkspaceProjection => resource.resourceKind === "workspace",
          )
        : [],
    [bossSnapshot.metadata],
  );
  const workspaceOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      workspaces.map((workspace) => ({
        id: `${workspace.nodeId}:${workspace.workspaceId}`,
        value: `${workspace.nodeId}:${workspace.workspaceId}`,
        label: workspace.label,
        description: `节点 ${workspace.nodeId}`,
      })),
    [workspaces],
  );
  const effectiveWorkspaceKey = workspaceOptions.some(
    (option) => option.value === selectedWorkspaceKey,
  )
    ? selectedWorkspaceKey
    : workspaceOptions[0]?.value;
  const selectedWorkspace = workspaces.find(
    (workspace) => `${workspace.nodeId}:${workspace.workspaceId}` === effectiveWorkspaceKey,
  );
  const selectedWorkspaceDisplay =
    workspaceOptions.find((option) => option.value === effectiveWorkspaceKey) ?? null;
  const selectedWorkspaceFieldDisplay = useMemo(
    () =>
      selectedWorkspaceDisplay
        ? {
            label: selectedWorkspaceDisplay.label,
            description: selectedWorkspaceDisplay.description,
          }
        : null,
    [selectedWorkspaceDisplay],
  );

  const grantEditor = useOwnedGrantEditor(
    canViewGrants ? createGrantEditor : undefined,
    effectivePrincipalId,
    generation,
    createRequestId,
  );
  const browserBinding = useOwnedBrowserBinding(
    canViewProfiles ? createBrowserBinding : undefined,
    selectedWorkspace,
    generation,
    createRequestId,
  );

  return (
    <View style={styles.card} testID="enterprise-admin-controls">
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>企业管理</Text>
          <Text style={styles.muted}>分配员工权限和工作空间的浏览器身份。</Text>
        </View>
        {bossSnapshot.metadata.status === "loading" || directory.status === "loading" ? (
          <StatusBadge label="加载中" variant="muted" />
        ) : null}
      </View>

      {canViewGrants && createGrantEditor ? (
        <View style={styles.section}>
          {canViewPrincipals ? (
            <>
              <SelectField
                label="员工或服务账号"
                value={effectivePrincipalId ?? null}
                selectedDisplay={selectedPrincipalDisplay}
                options={principalOptions}
                onChange={(principalId) => setSelectedPrincipalId(principalId)}
                placeholder="选择账号"
                emptyText="未找到企业账号"
                loading={directory.status === "loading"}
                disabled={directory.status !== "loaded"}
                searchable
                searchPlaceholder="搜索账号"
                testID="enterprise-admin-principal"
                triggerTestID="enterprise-admin-principal-trigger"
              />
              {directory.status === "failed" ? (
                <View style={styles.feedback}>
                  <Text style={styles.error}>无法加载企业账号。</Text>
                  <Button
                    size="sm"
                    variant="outline"
                    onPress={() => {
                      startPrincipalLoad();
                    }}
                  >
                    重试
                  </Button>
                </View>
              ) : null}
            </>
          ) : (
            <Text style={styles.error}>当前会话无权查看企业账号。</Text>
          )}
          {grantEditor ? (
            <GrantEditorControls
              model={grantEditor}
              generation={generation}
              organizationId={organizationId}
              workspaces={workspaces}
              canManage={canManageGrants}
              createRequestId={createRequestId}
            />
          ) : null}
        </View>
      ) : null}

      {canViewProfiles && createBrowserBinding ? (
        <View style={styles.section}>
          <SelectField
            label="浏览器访问对应的工作空间"
            value={effectiveWorkspaceKey ?? null}
            selectedDisplay={selectedWorkspaceFieldDisplay}
            options={workspaceOptions}
            onChange={(workspaceKey) => setSelectedWorkspaceKey(workspaceKey)}
            placeholder="选择工作空间"
            emptyText="请先加载工作空间，再分配浏览器配置"
            loading={bossSnapshot.metadata.status === "loading"}
            disabled={bossSnapshot.metadata.status !== "loaded" || workspaceOptions.length === 0}
            testID="enterprise-admin-browser-workspace"
            triggerTestID="enterprise-admin-browser-workspace-trigger"
          />
          {browserBinding ? (
            <BrowserBindingControls
              model={browserBinding}
              generation={generation}
              canBind={canBindProfiles}
              createRequestId={createRequestId}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[4],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  headerText: { flex: 1, gap: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  subtitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  body: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  success: { color: theme.colors.palette.green[400], fontSize: theme.fontSize.sm },
  section: { gap: theme.spacing[3] },
  permissionList: { gap: theme.spacing[2] },
  permissionRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  feedback: { gap: theme.spacing[2], alignItems: "flex-start" },
}));
