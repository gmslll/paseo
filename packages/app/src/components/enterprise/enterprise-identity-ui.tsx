/* oxlint-disable react-perf/jsx-no-new-function-as-prop */
import {
  EnterpriseFeatureFlagsWireSchema,
  CurrentIdentityProjectionSchema,
  normalizeEnterpriseFeatureFlags,
} from "@getpaseo/protocol/messages";
import React, { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import {
  getIdentityDisplayPolicyFromParsed,
  getResourceStatusDisplayPolicy,
} from "@/stores/enterprise/display-policy";
import type {
  PatAuthenticationPortResult,
  PatLoginFormModel,
} from "@/stores/enterprise/pat-login-form-model";
import { StyleSheet } from "react-native-unistyles";

export type EnterpriseIdentityTarget = "legacy_passthrough" | "enterprise_host";

export interface EnterpriseCapabilityGateProps {
  readonly capability: unknown;
  readonly target: EnterpriseIdentityTarget;
  readonly children: ReactNode;
  readonly legacyContent: ReactNode;
  readonly unavailableContent?: ReactNode;
}

export function EnterpriseCapabilityGate({
  capability,
  target,
  children,
  legacyContent,
  unavailableContent,
}: EnterpriseCapabilityGateProps) {
  if (target === "legacy_passthrough") return legacyContent;
  const parsed = EnterpriseFeatureFlagsWireSchema.safeParse(capability);
  const enabled =
    parsed.success && normalizeEnterpriseFeatureFlags(parsed.data).enterpriseIdentityV1;
  if (enabled) return children;
  return (
    unavailableContent ?? (
      <View
        style={styles.card}
        accessibilityRole="alert"
        testID="enterprise-capability-unavailable"
      >
        <Text style={styles.title}>Enterprise sign-in unavailable</Text>
        <Text style={styles.muted}>Update the host to enable enterprise identity.</Text>
      </View>
    )
  );
}

export interface PatLoginFormProps<T> {
  readonly model: PatLoginFormModel;
  readonly authenticate: (
    token: string,
    signal: AbortSignal,
  ) => Promise<PatAuthenticationPortResult<T>>;
  readonly onAuthenticated?: (value: T) => void;
  readonly onCancel?: () => void;
}

export function EnterprisePatLoginForm<T>({
  model,
  authenticate,
  onAuthenticated,
  onCancel,
}: PatLoginFormProps<T>) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<EditingTextInputHandle>(null);
  useEffect(
    () => () => {
      model.close();
      inputRef.current?.reset();
    },
    [model],
  );

  const submit = async () => {
    setError(undefined);
    const result = await model.submit(authenticate);
    if (result.ok) {
      inputRef.current?.reset();
      onAuthenticated?.(result.value);
    } else setError(PAT_REASON_COPY[result.reasonCode] ?? PAT_REASON_COPY["identity.unavailable"]);
  };

  const cancel = () => {
    model.close();
    inputRef.current?.reset();
    onCancel?.();
  };

  if (snapshot.status === "closed") return null;
  return (
    <View style={styles.card} testID="enterprise-pat-login-form">
      <Text style={styles.title}>Sign in to enterprise host</Text>
      <Field
        label="Personal access token"
        hint="Stored in memory only and cleared after authentication."
        testID="enterprise-pat-field"
      >
        <FormTextInput
          ref={inputRef}
          accessibilityLabel="Personal access token"
          autoCapitalize="none"
          autoCorrect={false}
          editable={snapshot.status === "idle"}
          onChangeText={model.setToken}
          placeholder="Paste your token"
          secureTextEntry
          testID="enterprise-pat-input"
        />
      </Field>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Button
          accessibilityLabel="Sign in"
          disabled={!snapshot.canSubmit}
          loading={snapshot.status === "pending"}
          onPress={submit}
          testID="enterprise-pat-submit"
        >
          Sign in
        </Button>
        {onCancel ? (
          <Button
            accessibilityLabel="Cancel"
            onPress={cancel}
            variant="ghost"
            testID="enterprise-pat-cancel"
          >
            Cancel
          </Button>
        ) : null}
      </View>
    </View>
  );
}

export function EnterprisePasswordLoginForm<T>({
  authenticate,
  onAuthenticated,
}: {
  readonly authenticate: (
    username: string,
    password: string,
    signal: AbortSignal,
  ) => Promise<PatAuthenticationPortResult<T>>;
  readonly onAuthenticated?: (value: T) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const passwordRef = useRef<EditingTextInputHandle>(null);
  const requestRef = useRef<AbortController | null>(null);
  const pendingRef = useRef(false);
  useEffect(
    () => () => {
      requestRef.current?.abort();
      passwordRef.current?.reset();
    },
    [],
  );
  const submit = async () => {
    if (pendingRef.current || username.trim().length < 3 || password.length < 12) return;
    pendingRef.current = true;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setPending(true);
    setError(undefined);
    try {
      const result = await authenticate(username.trim(), password, controller.signal);
      if (requestRef.current !== controller) return;
      setPassword("");
      passwordRef.current?.reset();
      if (result.ok) onAuthenticated?.(result.value);
      else setError(PAT_REASON_COPY[result.reasonCode] ?? PAT_REASON_COPY["identity.unavailable"]);
    } catch {
      if (!controller.signal.aborted) setError(PAT_REASON_COPY["identity.unavailable"]);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        pendingRef.current = false;
        setPending(false);
      }
    }
  };
  return (
    <View style={styles.card} testID="enterprise-password-login-form">
      <Text style={styles.title}>Sign in with your company account</Text>
      <Field label="Account" testID="enterprise-account-field">
        <FormTextInput
          accessibilityLabel="Enterprise account"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!pending}
          onChangeText={setUsername}
          placeholder="name@company"
          testID="enterprise-account-input"
        />
      </Field>
      <Field
        label="Password"
        hint="Your password is exchanged for a short-lived node ticket and is never saved."
        testID="enterprise-password-field"
      >
        <FormTextInput
          ref={passwordRef}
          accessibilityLabel="Enterprise password"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!pending}
          onChangeText={setPassword}
          placeholder="Enter your password"
          secureTextEntry
          testID="enterprise-password-input"
        />
      </Field>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Button
          accessibilityLabel="Sign in with company account"
          disabled={pending || username.trim().length < 3 || password.length < 12}
          loading={pending}
          onPress={submit}
          testID="enterprise-password-submit"
        >
          Sign in
        </Button>
      </View>
    </View>
  );
}

export interface EnterpriseIdentityNavigationProps {
  readonly projection: unknown;
  readonly onNavigate?: (destination: string) => void;
}

export function EnterpriseIdentityNavigation({
  projection,
  onNavigate,
}: EnterpriseIdentityNavigationProps) {
  const parsed = CurrentIdentityProjectionSchema.safeParse(projection);
  if (!parsed.success) return null;
  const policy = getIdentityDisplayPolicyFromParsed(parsed.data);
  const identity = parsed.data;
  return (
    <View style={styles.card} testID="enterprise-identity-navigation">
      <Text style={styles.title}>{identity.displayName ?? "Current identity"}</Text>
      <Text style={styles.muted}>{identity.principalId}</Text>
      <View style={styles.navigation}>
        {policy.navigation.map((destination) => (
          <Pressable
            accessibilityLabel={destination}
            accessibilityRole="button"
            key={destination}
            onPress={() => onNavigate?.(destination)}
            style={styles.navItem}
            testID={`enterprise-nav-${destination}`}
          >
            <Text style={styles.navText}>{destination.replaceAll("_", " ")}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const STATUS_LABELS = {
  ready: "Ready",
  resource_waiting: "Waiting for resource",
  login_required: "Login required",
  mfa_required: "MFA required",
  risk_control: "Risk control",
  disabled: "Disabled",
} as const;

const PAT_REASON_COPY: Record<string, string> = {
  "identity.invalid_token": "The token was rejected.",
  "identity.invalid_password": "The account or password was rejected.",
  "identity.host_upgrade_required": "Update the host to enable enterprise sign-in.",
  "identity.unavailable": "Enterprise sign-in is unavailable.",
  "identity.logout_failed": "Unable to sign out. Try again.",
  "identity.authentication_incomplete": "Enterprise sign-in did not complete.",
  "identity.logout_incomplete": "Sign-out did not complete.",
  "identity.mutation_in_progress": "Another identity change is in progress.",
  "identity.credential_revoked": "The credential was revoked.",
  "identity.token_required": "Enter a personal access token.",
  "identity.authentication_pending": "Sign-in is already in progress.",
  "identity.form_closed": "Sign-in was cancelled.",
};

const RESOURCE_REASON_COPY: Record<string, string> = {
  capacity_wait: "Waiting for resource capacity.",
};

export function EnterpriseResourceStatus({ projection }: { readonly projection: unknown }) {
  const policy = getResourceStatusDisplayPolicy(projection);
  if (!policy) return null;
  return (
    <View style={styles.card} testID="enterprise-resource-status">
      <View style={styles.statusHeader}>
        <Text style={styles.title}>{policy.label ?? policy.resource.localResourceId}</Text>
        <StatusBadge label={STATUS_LABELS[policy.status]} variant={policy.tone} />
      </View>
      {policy.workspaceId ? <Text style={styles.muted}>Workspace {policy.workspaceId}</Text> : null}
      {policy.agentId ? <Text style={styles.muted}>Agent {policy.agentId}</Text> : null}
      {policy.reasonCode ? (
        <Text style={styles.error}>
          {RESOURCE_REASON_COPY[policy.reasonCode] ?? "Resource unavailable."}
        </Text>
      ) : null}
      {policy.queue ? (
        <View style={styles.queue} testID="enterprise-resource-queue">
          <Text style={styles.muted}>
            {policy.queue.position ? `Position ${policy.queue.position}` : "Queued"}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  navigation: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  navItem: {
    minHeight: 44,
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[3],
  },
  navText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  statusHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  queue: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
