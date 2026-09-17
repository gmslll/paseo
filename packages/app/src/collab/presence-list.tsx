import { type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { PresenceEntry } from "@getpaseo/protocol/enterprise-collaboration";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";
import { useCollabCopy } from "./copy";
import { projectPresence } from "./views";

export function PresenceList({
  serverId,
  entries,
  viewerPrincipalId,
  now,
}: {
  serverId: string;
  entries: readonly PresenceEntry[];
  viewerPrincipalId: string;
  now: number;
}): ReactElement | null {
  const supported = useHostFeature(serverId, "enterpriseCollaborationV1");
  const copy = useCollabCopy();
  if (!supported) return null;
  const people = projectPresence({ entries, viewerPrincipalId, now, copy });
  return (
    <View testID="collab-presence-list" style={styles.section}>
      <Text style={settingsStyles.sectionHeaderTitle}>{copy.presence.title}</Text>
      {people.length === 0 ? (
        <Text style={styles.empty}>{copy.presence.empty}</Text>
      ) : (
        <View style={settingsStyles.card}>
          {people.map((person, index) => (
            <View
              key={person.principalId}
              style={[settingsStyles.row, index > 0 ? settingsStyles.rowBorder : null]}
            >
              <Text style={settingsStyles.rowTitle}>{person.label}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[3],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
