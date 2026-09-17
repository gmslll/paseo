import { type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { RevokeBanner } from "./revoke-banner";
import { useCollabRevoke } from "./use-collab-revoke";

export function WorkspaceRevokeBanner({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}): ReactElement | null {
  const { revoked, reason } = useCollabRevoke({ serverId, workspaceId });
  if (!revoked) return null;
  return (
    <View style={styles.banner} testID="workspace-revoke-banner">
      <RevokeBanner serverId={serverId} revoked={revoked} reason={reason} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
}));
