import { type ReactElement } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostFeature } from "@/runtime/host-features";
import { useCollabCopy } from "./copy";
import { projectAuthorLabel, type TimelineAuthor } from "./views";

export function AuthorLabel({
  serverId,
  author,
  viewerPrincipalId,
}: {
  serverId: string;
  author: TimelineAuthor | null | undefined;
  viewerPrincipalId: string;
}): ReactElement | null {
  const supported = useHostFeature(serverId, "enterpriseCollaborationV1");
  const copy = useCollabCopy();
  if (!supported) return null;
  const label = projectAuthorLabel({ author, viewerPrincipalId, copy });
  if (!label) return null;
  return (
    <Text testID="collab-author-label" style={styles.label}>
      {label}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
