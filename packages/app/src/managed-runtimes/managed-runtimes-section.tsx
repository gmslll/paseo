import { useCallback } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import {
  buildManagedRuntimeRows,
  type ManagedRuntimeRow,
  type ManagedRuntimeStatusKey,
} from "./runtime-rows";
import {
  type ManagedRuntimeInstallState,
  type ManagedRuntimesView,
  useManagedRuntimes,
} from "./use-managed-runtimes";

function statusLabel(status: ManagedRuntimeStatusKey, t: TFunction): string {
  switch (status) {
    case "installed":
      return t("settings.runtimes.statuses.installed");
    case "installing":
      return t("settings.runtimes.statuses.installing");
    case "not_installed":
      return t("settings.runtimes.statuses.notInstalled");
    case "mismatch":
      return t("settings.runtimes.statuses.mismatch");
    case "failed":
      return t("settings.runtimes.statuses.failed");
    case "not_pinned":
      return t("settings.runtimes.statuses.notPinned");
  }
}

function versionHint(row: ManagedRuntimeRow, t: TFunction): string | null {
  if (row.activeVersion)
    return t("settings.runtimes.activeVersion", { version: row.activeVersion });
  if (row.pinnedVersion)
    return t("settings.runtimes.pinnedVersion", { version: row.pinnedVersion });
  return null;
}

export function ManagedRuntimesSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { view, installState, install } = useManagedRuntimes(serverId);

  if (view.kind === "unsupported") {
    return null;
  }

  return (
    <SettingsSection title={t("settings.runtimes.title")} info={t("settings.runtimes.info")}>
      <View style={settingsStyles.card}>
        <ManagedRuntimesBody view={view} installState={installState} onInstall={install} />
      </View>
    </SettingsSection>
  );
}

interface ManagedRuntimesBodyProps {
  view: Exclude<ManagedRuntimesView, { kind: "unsupported" }>;
  installState: ManagedRuntimeInstallState;
  onInstall: (runtimeName: string) => Promise<void>;
}

function ManagedRuntimesBody({ view, installState, onInstall }: ManagedRuntimesBodyProps) {
  const { t } = useTranslation();

  switch (view.kind) {
    case "disconnected":
      return <CardLine text={t("settings.runtimes.unavailable")} />;
    case "loading":
      return <CardLine text={t("settings.runtimes.loading")} />;
    case "error":
      return <CardLine text={view.message} isError />;
    case "ready": {
      const rows = buildManagedRuntimeRows(view.runtimes);
      if (rows.length === 0) {
        return <CardLine text={t("settings.runtimes.empty")} />;
      }
      return (
        <>
          {rows.map((row, index) => (
            <ManagedRuntimeRowView
              key={row.runtimeName}
              row={row}
              isFirst={index === 0}
              installState={installState}
              onInstall={onInstall}
            />
          ))}
        </>
      );
    }
  }
}

function CardLine({ text, isError = false }: { text: string; isError?: boolean }) {
  return (
    <View style={settingsStyles.row}>
      <Text style={isError ? settingsStyles.rowError : styles.mutedText}>{text}</Text>
    </View>
  );
}

interface ManagedRuntimeRowViewProps {
  row: ManagedRuntimeRow;
  isFirst: boolean;
  installState: ManagedRuntimeInstallState;
  onInstall: (runtimeName: string) => Promise<void>;
}

function ManagedRuntimeRowView({
  row,
  isFirst,
  installState,
  onInstall,
}: ManagedRuntimeRowViewProps) {
  const { t } = useTranslation();
  const handleInstall = useCallback(() => {
    void onInstall(row.runtimeName);
  }, [onInstall, row.runtimeName]);
  const isInstallingThisRow =
    installState.kind === "installing" && installState.runtimeName === row.runtimeName;
  const installFailure =
    installState.kind === "failed" && installState.runtimeName === row.runtimeName
      ? installState.message
      : null;
  const hint = versionHint(row, t);

  return (
    <View style={[settingsStyles.row, !isFirst && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <View style={styles.titleRow}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {row.runtimeName}
          </Text>
          <StatusBadge label={statusLabel(row.status, t)} variant={row.badgeVariant} />
        </View>
        {hint ? <Text style={settingsStyles.rowHint}>{hint}</Text> : null}
        {row.commandPath ? (
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {row.commandPath}
          </Text>
        ) : null}
        {row.failure ? <Text style={settingsStyles.rowError}>{row.failure}</Text> : null}
        {installFailure ? <Text style={settingsStyles.rowError}>{installFailure}</Text> : null}
      </View>
      {row.canInstall ? (
        <Button
          variant="outline"
          size="sm"
          onPress={handleInstall}
          disabled={installState.kind === "installing"}
        >
          {isInstallingThisRow ? t("settings.runtimes.installing") : t("settings.runtimes.install")}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
