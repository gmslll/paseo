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
  "workspace.metadata.read": "View workspace and agent names",
  "workspace.content.read": "Read workspace and agent content",
  "workspace.write": "Send messages and modify workspace content",
  "workspace.manage": "Create and manage workspaces and agents",
  "browser.use": "Use the assigned browser profile",
  "browser.profile.manage": "Manage browser profiles",
  "app.use": "Use assigned app slots",
  "audit.read": "View audit events",
  "identity.manage": "Manage employees and permissions",
  "terminal.use": "Use terminals",
  "provider.history.read": "Read provider history",
  "provider.history.import": "Import provider history",
  "workspace.script.execute": "Run workspace scripts",
  "workspace.script.configure": "Configure workspace scripts",
  "workspace.editor.open": "Open workspace editors",
});

function principalLabel(principal: EnterprisePrincipalRecord, currentPrincipalId: string): string {
  const label = principal.displayName ?? principal.principalId;
  return principal.principalId === currentPrincipalId ? `${label} (you)` : label;
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
        label: "Own resources",
        description: "Resources owned by this employee",
      },
      {
        id: "scope-organization",
        value: `organization:${organizationId}`,
        label: "Entire organization",
        description: "Every current resource in the organization",
      },
      ...workspaces.map((workspace) => ({
        id: `scope-workspace-${workspace.workspaceId}`,
        value: `workspace:${workspace.workspaceId}`,
        label: workspace.label,
        description: `Workspace · ${workspace.nodeId}`,
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
        <Text style={styles.subtitle}>Employee permissions</Text>
        <StatusBadge
          label={snapshot.mutation.status}
          variant={snapshot.mutation.status === "failed" ? "error" : "muted"}
        />
      </View>
      <SelectField
        label="Permission scope"
        value={scopeKey}
        selectedDisplay={selectedScopeDisplay}
        options={scopeOptions}
        onChange={(value) => setScopeKey(value)}
        placeholder="Choose a scope"
        emptyText="No scopes available"
        testID="enterprise-admin-grant-scope"
        triggerTestID="enterprise-admin-grant-scope-trigger"
      />
      {snapshot.server.status === "loading" ? (
        <Text style={styles.muted}>Loading current permissions…</Text>
      ) : null}
      {snapshot.server.status === "failed" ? (
        <View style={styles.feedback}>
          <Text style={styles.error}>Could not load permissions.</Text>
          <Button
            size="sm"
            variant="outline"
            onPress={() =>
              void model.load({ requestId: createRequestId(), sessionGeneration: generation })
            }
            testID="enterprise-admin-retry-grants"
          >
            Retry
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
                  accessibilityLabel={`${ACTION_LABELS[action]} for selected scope`}
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
        <Text style={styles.success}>Permissions saved.</Text>
      ) : null}
      {snapshot.mutation.status === "failed" ? (
        <Text style={styles.error}>Could not save permissions. Reload and try again.</Text>
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
          Reload
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
            Save permissions
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
        description: `${profile.platform} · ${profile.status}`,
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
        <Text style={styles.subtitle}>Browser profile binding</Text>
        <StatusBadge
          label={snapshot.mutation.status}
          variant={snapshot.mutation.status === "failed" ? "error" : "muted"}
        />
      </View>
      {snapshot.server.status === "loading" ? (
        <Text style={styles.muted}>Loading browser profiles…</Text>
      ) : null}
      {snapshot.server.status === "failed" ? (
        <Text style={styles.error}>Could not load browser profiles.</Text>
      ) : null}
      {snapshot.server.status === "loaded" ? (
        <SelectField
          label="Browser profile"
          value={snapshot.draftBrowserProfileId}
          selectedDisplay={selectedProfileDisplay}
          options={profileOptions}
          onChange={(profileId) => model.selectProfile(profileId)}
          placeholder="Choose a browser profile"
          emptyText="No browser profiles registered on this node"
          disabled={!canBind || snapshot.mutation.status === "pending"}
          testID="enterprise-admin-browser-profile"
          triggerTestID="enterprise-admin-browser-profile-trigger"
        />
      ) : null}
      {snapshot.mutation.status === "success" ? (
        <Text style={styles.success}>Browser profile bound.</Text>
      ) : null}
      {snapshot.mutation.status === "failed" ? (
        <Text style={styles.error}>Could not bind this browser profile.</Text>
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
          Reload
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
            Bind profile
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
        description: `${principal.principalType.replaceAll("_", " ")} · ${principal.status}`,
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
        description: `Node ${workspace.nodeId}`,
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
          <Text style={styles.title}>Enterprise administration</Text>
          <Text style={styles.muted}>Assign employee access and workspace browser identities.</Text>
        </View>
        {bossSnapshot.metadata.status === "loading" || directory.status === "loading" ? (
          <StatusBadge label="loading" variant="muted" />
        ) : null}
      </View>

      {canViewGrants && createGrantEditor ? (
        <View style={styles.section}>
          {canViewPrincipals ? (
            <>
              <SelectField
                label="Employee or service account"
                value={effectivePrincipalId ?? null}
                selectedDisplay={selectedPrincipalDisplay}
                options={principalOptions}
                onChange={(principalId) => setSelectedPrincipalId(principalId)}
                placeholder="Choose an account"
                emptyText="No enterprise accounts found"
                loading={directory.status === "loading"}
                disabled={directory.status !== "loaded"}
                searchable
                searchPlaceholder="Search accounts"
                testID="enterprise-admin-principal"
                triggerTestID="enterprise-admin-principal-trigger"
              />
              {directory.status === "failed" ? (
                <View style={styles.feedback}>
                  <Text style={styles.error}>Could not load enterprise accounts.</Text>
                  <Button
                    size="sm"
                    variant="outline"
                    onPress={() => {
                      startPrincipalLoad();
                    }}
                  >
                    Retry
                  </Button>
                </View>
              ) : null}
            </>
          ) : (
            <Text style={styles.error}>This session cannot view enterprise accounts.</Text>
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
            label="Workspace for browser access"
            value={effectiveWorkspaceKey ?? null}
            selectedDisplay={selectedWorkspaceFieldDisplay}
            options={workspaceOptions}
            onChange={(workspaceKey) => setSelectedWorkspaceKey(workspaceKey)}
            placeholder="Choose a workspace"
            emptyText="Load a workspace before assigning a browser profile"
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
