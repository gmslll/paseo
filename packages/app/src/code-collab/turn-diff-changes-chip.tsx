import { memo, useCallback, type ReactElement } from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { STREAM_METADATA_FONT_SIZE } from "@/components/message";
import { useHostFeature } from "@/runtime/host-features";
import { useOptionalPaneContext } from "@/panels/pane-context";
import { useTurnDiffListQuery } from "./use-turn-diff-query";

export const TurnDiffChangesChip = memo(function TurnDiffChangesChip({
  turnId,
}: {
  turnId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const pane = useOptionalPaneContext();
  const serverId = pane?.serverId ?? "";
  const workspaceId = pane?.workspaceId ?? "";
  const target = pane?.target;
  const openPreferredTarget = pane?.openPreferredTarget;
  const supported = useHostFeature(serverId, "codeCollabTurnDiff");
  const agentId = target?.kind === "agent" ? target.agentId : null;
  const list = useTurnDiffListQuery({
    serverId,
    workspaceId,
    agentId: agentId ?? undefined,
    enabled: supported && Boolean(agentId) && Boolean(turnId),
  });
  const turn = list.data?.find((entry) => entry.turnId === turnId);
  const handlePress = useCallback(() => {
    if (!agentId || !openPreferredTarget) return;
    openPreferredTarget({ kind: "turn_diff", turnId, agentId }, "diffs");
  }, [agentId, openPreferredTarget, turnId]);

  if (!pane || !supported || !agentId || !turn || turn.fileCount === 0) {
    return null;
  }

  return (
    <Pressable
      testID="turn-diff-changes-chip"
      accessibilityRole="button"
      accessibilityLabel={t("panels.diff.turnChanges", { count: turn.fileCount })}
      onPress={handlePress}
    >
      <Text style={styles.label}>{t("panels.diff.turnChanges", { count: turn.fileCount })}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
  },
}));
