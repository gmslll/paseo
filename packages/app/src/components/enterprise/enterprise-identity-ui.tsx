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
        <Text style={styles.title}>企业登录不可用</Text>
        <Text style={styles.muted}>请更新主机以启用企业身份认证。</Text>
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
      <Text style={styles.title}>登录企业主机</Text>
      <Field
        label="个人访问令牌"
        hint="仅保存在内存中，身份验证完成后即清除。"
        testID="enterprise-pat-field"
      >
        <FormTextInput
          ref={inputRef}
          accessibilityLabel="个人访问令牌"
          autoCapitalize="none"
          autoCorrect={false}
          editable={snapshot.status === "idle"}
          onChangeText={model.setToken}
          placeholder="粘贴令牌"
          secureTextEntry
          testID="enterprise-pat-input"
        />
      </Field>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Button
          accessibilityLabel="登录"
          disabled={!snapshot.canSubmit}
          loading={snapshot.status === "pending"}
          onPress={submit}
          testID="enterprise-pat-submit"
        >
          登录
        </Button>
        {onCancel ? (
          <Button
            accessibilityLabel="取消"
            onPress={cancel}
            variant="ghost"
            testID="enterprise-pat-cancel"
          >
            取消
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
      <Text style={styles.title}>使用企业账号登录</Text>
      <Field label="账号" testID="enterprise-account-field">
        <FormTextInput
          accessibilityLabel="企业账号"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!pending}
          onChangeText={setUsername}
          placeholder="请输入账号"
          testID="enterprise-account-input"
        />
      </Field>
      <Field
        label="密码"
        hint="密码仅用于换取短期节点票据，不会被保存。"
        testID="enterprise-password-field"
      >
        <FormTextInput
          ref={passwordRef}
          accessibilityLabel="企业账号密码"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!pending}
          onChangeText={setPassword}
          placeholder="请输入密码"
          secureTextEntry
          testID="enterprise-password-input"
        />
      </Field>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Button
          accessibilityLabel="使用企业账号登录"
          disabled={pending || username.trim().length < 3 || password.length < 12}
          loading={pending}
          onPress={submit}
          testID="enterprise-password-submit"
        >
          登录
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
      <Text style={styles.title}>{identity.displayName ?? "当前身份"}</Text>
      <Text style={styles.muted}>{identity.principalId}</Text>
      <View style={styles.navigation}>
        {policy.navigation.map((destination) => (
          <Pressable
            accessibilityLabel={NAVIGATION_LABELS[destination] ?? destination}
            accessibilityRole="button"
            key={destination}
            onPress={() => onNavigate?.(destination)}
            style={styles.navItem}
            testID={`enterprise-nav-${destination}`}
          >
            <Text style={styles.navText}>
              {NAVIGATION_LABELS[destination] ?? destination.replaceAll("_", " ")}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const STATUS_LABELS = {
  ready: "可用",
  resource_waiting: "等待资源",
  login_required: "需要登录",
  mfa_required: "需要多重验证",
  risk_control: "风控限制",
  disabled: "已停用",
} as const;

const NAVIGATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  workspaces: "工作空间",
  organization: "组织资源",
  identity: "身份管理",
  browser_profiles: "浏览器配置",
  audit: "审计记录",
});

const PAT_REASON_COPY: Record<string, string> = {
  "identity.invalid_token": "令牌无效。",
  "identity.invalid_password": "账号或密码错误。",
  "identity.host_upgrade_required": "请更新主机以启用企业登录。",
  "identity.unavailable": "企业登录当前不可用。",
  "identity.logout_failed": "退出失败，请重试。",
  "identity.authentication_incomplete": "企业登录未完成。",
  "identity.logout_incomplete": "退出未完成。",
  "identity.mutation_in_progress": "正在进行另一项身份变更。",
  "identity.credential_revoked": "登录凭据已被撤销。",
  "identity.token_required": "请输入个人访问令牌。",
  "identity.authentication_pending": "正在登录，请稍候。",
  "identity.form_closed": "登录已取消。",
};

const RESOURCE_REASON_COPY: Record<string, string> = {
  capacity_wait: "正在等待可用资源。",
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
      {policy.workspaceId ? <Text style={styles.muted}>工作空间 {policy.workspaceId}</Text> : null}
      {policy.agentId ? <Text style={styles.muted}>智能体 {policy.agentId}</Text> : null}
      {policy.reasonCode ? (
        <Text style={styles.error}>
          {RESOURCE_REASON_COPY[policy.reasonCode] ?? "资源当前不可用。"}
        </Text>
      ) : null}
      {policy.queue ? (
        <View style={styles.queue} testID="enterprise-resource-queue">
          <Text style={styles.muted}>
            {policy.queue.position ? `队列位置：${policy.queue.position}` : "已进入队列"}
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
