/* oxlint-disable complexity, react/jsx-no-useless-fragment, react-perf/jsx-no-new-function-as-prop */
import {
  CurrentIdentityProjectionSchema,
  EnterpriseFeatureFlagsWireSchema,
  EnterpriseOrganizationResourceProjectionSchema,
  normalizeEnterpriseFeatureFlags,
  type CurrentIdentityProjection,
  type GlobalResourceRef,
} from "@getpaseo/protocol/messages";
import React, { useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  EnterpriseCapabilityGate,
  EnterpriseIdentityNavigation,
  EnterprisePatLoginForm,
  EnterpriseResourceStatus,
} from "@/components/enterprise/enterprise-identity-ui";
import type { BossResourceStore } from "@/stores/enterprise/boss-resource-store";
import type { PatLoginFormModel } from "@/stores/enterprise/pat-login-form-model";
import type { BrowserBindingFormModel } from "./forms/browser-binding-form-model";
import type { GrantEditorFormModel } from "./forms/grant-editor-form-model";
import type { EnterpriseUiPort } from "./enterprise-ui-port";
import { createEnterpriseUiBundle, type EnterpriseContentReaders } from "./enterprise-ui-port";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { EnterpriseIdentityLifecycle } from "@getpaseo/client/internal/enterprise-identity-lifecycle";
import { getIdentityDisplayPolicyFromParsed } from "@/stores/enterprise/display-policy";
import { StyleSheet } from "react-native-unistyles";
import { Text, View } from "react-native";

interface IdentityView {
  readonly target: "legacy_passthrough" | "enterprise_host";
  readonly state: "booting" | "signed_out" | "signed_in" | "unavailable";
  readonly projection: CurrentIdentityProjection | undefined;
  readonly serverId: string;
}

export interface EnterpriseWorkbenchScreenProps<TGeneration extends string, TContent> {
  readonly capability: unknown;
  readonly identity: unknown;
  readonly patModel: PatLoginFormModel;
  readonly bossStore: BossResourceStore<TContent, TGeneration>;
  readonly generation: TGeneration;
  readonly uiPort: EnterpriseUiPort<TGeneration>;
  readonly grantEditor?: GrantEditorFormModel<TGeneration>;
  readonly browserBinding?: BrowserBindingFormModel<TGeneration>;
  readonly legacyContent: ReactNode;
  readonly renderContent?: (content: TContent) => ReactNode;
  readonly onNavigate?: (destination: string) => void;
  readonly onAuthenticated?: (value: unknown) => void;
  readonly createRequestId?: () => string;
  readonly resourceStatuses?: readonly unknown[];
}

/**
 * Mountable W6 container. Root supplies the already-selected host runtime client/lifecycle and
 * resource-specific readers; credentials and lifecycle teardown remain owned by W3.
 */
export interface EnterpriseWorkbenchContainerProps<
  TGeneration extends string,
  TContent,
> extends Omit<
  EnterpriseWorkbenchScreenProps<TGeneration, TContent>,
  "identity" | "generation" | "uiPort"
> {
  readonly serverId: string;
  readonly lifecycle: EnterpriseIdentityLifecycle;
  readonly daemonClient: DaemonClient;
  readonly contentReaders: EnterpriseContentReaders<TGeneration, TContent>;
}

export function EnterpriseWorkbenchContainer<TGeneration extends string, TContent>(
  props: EnterpriseWorkbenchContainerProps<TGeneration, TContent>,
) {
  const lifecycleSnapshot = useSyncExternalStore(
    (listener) => props.lifecycle.subscribe(listener),
    () => props.lifecycle.readSnapshot(),
    () => props.lifecycle.readSnapshot(),
  );
  const bundle = React.useMemo(
    () =>
      createEnterpriseUiBundle({
        lifecycle: props.lifecycle,
        daemonClient: props.daemonClient,
        serverId: props.serverId,
        contentReaders: props.contentReaders,
      }),
    [props.lifecycle, props.daemonClient, props.serverId, props.contentReaders],
  );
  const identity = React.useMemo(
    () => ({
      target: lifecycleSnapshot.target,
      state: lifecycleSnapshot.state,
      serverId: props.serverId,
      ...(lifecycleSnapshot.projection ? { projection: lifecycleSnapshot.projection } : {}),
    }),
    [lifecycleSnapshot, props.serverId],
  );
  const generation = (lifecycleSnapshot.generation ?? "enterprise-unavailable") as TGeneration;
  return (
    <EnterpriseWorkbenchScreen
      {...props}
      identity={identity}
      generation={generation}
      uiPort={bundle.uiPort}
    />
  );
}

function parseIdentity(value: unknown): IdentityView | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const ownKeys = Reflect.ownKeys(record);
    if (ownKeys.some((key) => typeof key !== "string")) return undefined;
    const captured = new Map<string, unknown>();
    for (const key of ownKeys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
      captured.set(key, descriptor.value);
    }
    const target = captured.get("target");
    const state = captured.get("state");
    const serverId = captured.get("serverId");
    if (
      (target !== "legacy_passthrough" && target !== "enterprise_host") ||
      (state !== "booting" &&
        state !== "signed_out" &&
        state !== "signed_in" &&
        state !== "unavailable") ||
      typeof serverId !== "string" ||
      serverId.length === 0
    )
      return undefined;
    const expectedKeys =
      state === "signed_in"
        ? ["projection", "serverId", "state", "target"]
        : ["serverId", "state", "target"];
    if (captured.size !== expectedKeys.length || expectedKeys.some((key) => !captured.has(key)))
      return undefined;
    const capturedProjection = captured.get("projection");
    const projection =
      state === "signed_in"
        ? CurrentIdentityProjectionSchema.safeParse(capturedProjection)
        : { success: true as const, data: undefined };
    if (!projection.success) return undefined;
    const freezeRecursively = (current: unknown): unknown => {
      if (typeof current !== "object" || current === null || Object.isFrozen(current))
        return current;
      for (const key of Reflect.ownKeys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor && "value" in descriptor) freezeRecursively(descriptor.value);
      }
      return Object.freeze(current);
    };
    const frozenProjection = projection.data
      ? (freezeRecursively(projection.data) as CurrentIdentityProjection)
      : undefined;
    return Object.freeze({
      target,
      state,
      projection: frozenProjection as CurrentIdentityProjection | undefined,
      serverId,
    });
  } catch {
    return undefined;
  }
}

const resourceStatusObjectKeys = new WeakMap<object, string>();
let nextResourceStatusObjectKey = 0;
function resourceStatusKey(value: unknown): string {
  if (typeof value !== "object" || value === null) return `primitive:${String(value)}`;
  const existing = resourceStatusObjectKeys.get(value);
  if (existing) return existing;
  const key = `object:${++nextResourceStatusObjectKey}`;
  resourceStatusObjectKeys.set(value, key);
  return key;
}

function metadataRef(value: unknown): GlobalResourceRef | undefined {
  const parsed = EnterpriseOrganizationResourceProjectionSchema.safeParse(value);
  if (!parsed.success) return undefined;
  switch (parsed.data.resourceKind) {
    case "workspace":
      return {
        organizationId: parsed.data.organizationId,
        nodeId: parsed.data.nodeId,
        resourceKind: "workspace",
        localResourceId: parsed.data.workspaceId,
      };
    case "agent":
      return {
        organizationId: parsed.data.organizationId,
        nodeId: parsed.data.nodeId,
        resourceKind: "agent",
        localResourceId: parsed.data.agentId,
      };
    case "browser_profile":
      return {
        organizationId: parsed.data.organizationId,
        nodeId: parsed.data.nodeId,
        resourceKind: "browser_profile",
        localResourceId: parsed.data.browserProfileId,
      };
    case "app_slot":
      return {
        organizationId: parsed.data.organizationId,
        nodeId: parsed.data.nodeId,
        resourceKind: "app_slot",
        localResourceId: parsed.data.appSlotId,
      };
  }
}

function resourceRefKey(ref: GlobalResourceRef): string {
  return [ref.organizationId, ref.nodeId, ref.resourceKind, ref.localResourceId].join(":");
}

function sameResourceRef(left: GlobalResourceRef, right: GlobalResourceRef): boolean {
  return resourceRefKey(left) === resourceRefKey(right);
}

function parseCapability(value: unknown) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const snapshot = Object.fromEntries(Object.keys(record).map((key) => [key, record[key]]));
    const parsed = EnterpriseFeatureFlagsWireSchema.safeParse(snapshot);
    return parsed.success ? Object.freeze({ ...parsed.data }) : undefined;
  } catch {
    return undefined;
  }
}

const DISABLED_CAPABILITY = Object.freeze({ enterpriseIdentityV1: false });

function BossMetadataPanel<TContent, TGeneration extends string>({
  store,
  generation,
  renderContent,
}: {
  readonly store: BossResourceStore<TContent, TGeneration>;
  readonly generation: TGeneration;
  readonly renderContent?: (content: TContent) => ReactNode;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const resources = snapshot.metadata.status === "loaded" ? snapshot.metadata.resources : [];
  return (
    <View style={styles.card} testID="enterprise-boss-metadata">
      <Text style={styles.title}>Organization resources</Text>
      <Button
        size="sm"
        variant="outline"
        disabled={snapshot.metadata.status === "loading"}
        loading={snapshot.metadata.status === "loading"}
        onPress={() => void store.loadMetadata(generation)}
        testID="enterprise-boss-load-metadata"
      >
        Load metadata
      </Button>
      {snapshot.metadata.status === "loading" ? (
        <Text style={styles.muted}>Loading metadata…</Text>
      ) : null}
      {snapshot.metadata.status === "failed" ? (
        <Text style={styles.error}>Metadata unavailable.</Text>
      ) : null}
      {resources.map((resource) => {
        const ref = metadataRef(resource);
        if (!ref) return null;
        const selected =
          snapshot.detail.status === "loaded" && sameResourceRef(snapshot.detail.resource, ref);
        return (
          <View key={resourceRefKey(ref)} style={styles.row}>
            <Text style={styles.body}>{resource.label ?? ref.localResourceId}</Text>
            <Button
              size="sm"
              variant="outline"
              onPress={() => {
                store.selectDetail(ref);
              }}
              testID={`enterprise-boss-select-${resourceRefKey(ref)}`}
            >
              {selected ? "Selected" : "Details"}
            </Button>
            {selected ? (
              <Button
                size="sm"
                disabled={snapshot.content.status === "loading"}
                loading={snapshot.content.status === "loading"}
                onPress={() => void store.openContent(generation)}
                testID={`enterprise-boss-open-${resourceRefKey(ref)}`}
              >
                Open content
              </Button>
            ) : null}
          </View>
        );
      })}
      {snapshot.content.status === "failed" ? (
        <Text style={styles.error}>Content unavailable.</Text>
      ) : null}
      {snapshot.content.status === "loaded" ? (
        <View testID="enterprise-boss-content">
          {renderContent ? (
            renderContent(snapshot.content.value)
          ) : (
            <Text style={styles.body}>Content loaded.</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

function AdminProjectionPanel<TGeneration extends string>({
  grantEditor,
  browserBinding,
  generation,
  createRequestId,
}: {
  readonly grantEditor?: GrantEditorFormModel<TGeneration>;
  readonly browserBinding?: BrowserBindingFormModel<TGeneration>;
  readonly generation: TGeneration;
  readonly createRequestId: () => string;
}) {
  if (!grantEditor && !browserBinding) return null;
  return (
    <View style={styles.card} testID="enterprise-admin-projections">
      <Text style={styles.title}>Administration</Text>
      {grantEditor ? (
        <GrantProjectionStatus
          model={grantEditor}
          generation={generation}
          createRequestId={createRequestId}
        />
      ) : null}
      {browserBinding ? (
        <BrowserProjectionStatus
          model={browserBinding}
          generation={generation}
          createRequestId={createRequestId}
        />
      ) : null}
    </View>
  );
}

function GrantProjectionStatus<TGeneration>({
  model,
  generation,
  createRequestId,
}: {
  readonly model: GrantEditorFormModel<TGeneration>;
  readonly generation: TGeneration;
  readonly createRequestId: () => string;
}) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  return (
    <View style={styles.adminBlock}>
      <View style={styles.row}>
        <Text style={styles.body}>Principal grants</Text>
        <StatusBadge
          label={snapshot.mutation.status}
          variant={snapshot.mutation.status === "failed" ? "error" : "muted"}
        />
      </View>
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
        Load grants
      </Button>
      <Button
        size="sm"
        disabled={!snapshot.canSubmit}
        loading={snapshot.mutation.status === "pending"}
        onPress={() =>
          void model.submit({ requestId: createRequestId(), sessionGeneration: generation })
        }
        testID="enterprise-admin-save-grants"
      >
        Save grants
      </Button>
    </View>
  );
}

function BrowserProjectionStatus<TGeneration extends string>({
  model,
  generation,
  createRequestId,
}: {
  readonly model: BrowserBindingFormModel<TGeneration>;
  readonly generation: TGeneration;
  readonly createRequestId: () => string;
}) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  return (
    <View style={styles.adminBlock}>
      <View style={styles.row}>
        <Text style={styles.body}>Browser profile binding</Text>
        <StatusBadge
          label={snapshot.mutation.status}
          variant={snapshot.mutation.status === "failed" ? "error" : "muted"}
        />
      </View>
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
        Load profiles
      </Button>
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
    </View>
  );
}

export function EnterpriseWorkbenchScreen<TGeneration extends string, TContent>({
  capability,
  identity: rawIdentity,
  patModel,
  bossStore,
  generation,
  uiPort,
  grantEditor,
  browserBinding,
  legacyContent,
  renderContent,
  onNavigate,
  onAuthenticated,
  createRequestId = () => globalThis.crypto.randomUUID(),
  resourceStatuses = [],
}: EnterpriseWorkbenchScreenProps<TGeneration, TContent>) {
  const identity = parseIdentity(rawIdentity);
  if (!identity) return null;
  const capabilitySnapshot = parseCapability(capability);
  const normalizedCapability = normalizeEnterpriseFeatureFlags(capabilitySnapshot);
  const enabled = normalizedCapability.enterpriseIdentityV1;
  if (identity.target === "legacy_passthrough") return <>{legacyContent}</>;
  if (!enabled)
    return (
      <EnterpriseCapabilityGate
        capability={capabilitySnapshot ?? DISABLED_CAPABILITY}
        target="enterprise_host"
        legacyContent={legacyContent}
      >
        {null}
      </EnterpriseCapabilityGate>
    );
  if (identity.state === "booting") {
    return (
      <View style={styles.card} testID="enterprise-identity-booting">
        <Text style={styles.muted}>Loading enterprise identity…</Text>
      </View>
    );
  }
  if (identity.state === "unavailable") {
    return (
      <View style={styles.card} testID="enterprise-identity-unavailable">
        <Text style={styles.error}>Enterprise identity unavailable.</Text>
      </View>
    );
  }
  if (identity.state === "signed_out") {
    return (
      <EnterprisePatLoginForm
        model={patModel}
        authenticate={(token, signal) =>
          uiPort.authenticatePat({ serverId: identity.serverId, token, signal })
        }
        onAuthenticated={onAuthenticated}
      />
    );
  }
  if (!identity.projection) return null;
  const policy = getIdentityDisplayPolicyFromParsed(identity.projection);
  const canViewResources =
    normalizedCapability.enterpriseResourceAuthorizationV1 &&
    policy.allowedOperations.includes("organization.resources.view");
  const canViewGrants =
    normalizedCapability.enterpriseResourceAuthorizationV1 &&
    (policy.allowedOperations.includes("access.grants.view") ||
      policy.allowedOperations.includes("access.grants.manage"));
  const canViewProfiles =
    normalizedCapability.enterpriseBrowserProfilesV1 &&
    (policy.allowedOperations.includes("browser.profiles.view") ||
      policy.allowedOperations.includes("browser.profiles.bind"));
  const canLogoutAll = policy.allowedOperations.includes("identity.logout_all");
  const clearSensitiveState = () => {
    bossStore.clearSensitiveState();
    grantEditor?.refreshScope(generation);
    browserBinding?.refreshScope(generation);
  };
  const clearForRefresh = () => {
    bossStore.clearSensitiveState();
    grantEditor?.refreshScope(generation);
    browserBinding?.refreshScope(generation);
  };
  return (
    <View style={styles.container} testID="enterprise-workbench-screen">
      <EnterpriseIdentityNavigation projection={identity.projection} onNavigate={onNavigate} />
      {resourceStatuses.map((status) => (
        <EnterpriseResourceStatus key={resourceStatusKey(status)} projection={status} />
      ))}
      {canViewResources ? (
        <BossMetadataPanel
          store={bossStore}
          generation={generation}
          renderContent={renderContent}
        />
      ) : null}
      {canViewGrants || canViewProfiles ? (
        <AdminProjectionPanel
          grantEditor={canViewGrants ? grantEditor : undefined}
          browserBinding={canViewProfiles ? browserBinding : undefined}
          generation={generation}
          createRequestId={createRequestId}
        />
      ) : null}
      <Button
        variant="ghost"
        onPress={() => {
          clearSensitiveState();
          void uiPort.logoutCurrent().catch(() => undefined);
        }}
        testID="enterprise-logout-current"
      >
        Sign out
      </Button>
      <Button
        variant="ghost"
        onPress={() => {
          clearForRefresh();
          void uiPort.refreshScope(generation).catch(() => undefined);
        }}
        testID="enterprise-refresh-scope"
      >
        Refresh session scope
      </Button>
      {canLogoutAll ? (
        <Button
          variant="ghost"
          onPress={() => {
            clearSensitiveState();
            void uiPort.logoutAll().catch(() => undefined);
          }}
          testID="enterprise-logout-all"
        >
          Sign out all sessions
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[4], padding: theme.spacing[4] },
  card: {
    gap: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[4],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  body: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    justifyContent: "space-between",
  },
  adminBlock: { gap: theme.spacing[2] },
}));
