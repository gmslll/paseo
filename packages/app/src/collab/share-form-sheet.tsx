import { useCallback, useEffect, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  PresenceEntry,
  WorkspaceMember,
  WorkspaceMemberRole,
} from "@getpaseo/protocol/enterprise-collaboration";
import { PresenceList } from "./presence-list";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatCollabCopy, useCollabCopy, type CollabCopy } from "./copy";
import type {
  ShareableMemberRole,
  SharePrincipalIssue,
  ShareSubmitError,
} from "./share-form-model";
import { useShareWorkspaceFormModel, useShareWorkspaceFormState } from "./use-share-form-model";

export interface ShareWorkspacePort {
  share(principalId: string, role: ShareableMemberRole): Promise<readonly WorkspaceMember[]>;
  unshare(principalId: string): Promise<readonly WorkspaceMember[]>;
  enable(): Promise<{
    members: readonly WorkspaceMember[];
    viewerRole: WorkspaceMemberRole | null;
  }>;
}

export interface ShareWorkspaceSheetProps {
  visible: boolean;
  serverId: string;
  viewerPrincipalId: string;
  viewerRole: WorkspaceMemberRole | null;
  members: readonly WorkspaceMember[];
  revoked: boolean;
  collaborationEnabled: boolean;
  canEnable: boolean;
  presenceEntries?: readonly PresenceEntry[];
  presenceNow?: number;
  onClose: () => void;
  port: ShareWorkspacePort;
}

function MemberRow({
  principalId,
  label,
  roleLabel,
  canRemove,
  bordered,
  removeLabel,
  disabled,
  onRemove,
}: {
  principalId: string;
  label: string;
  roleLabel: string;
  canRemove: boolean;
  bordered: boolean;
  removeLabel: string;
  disabled: boolean;
  onRemove: (principalId: string, label: string) => Promise<void>;
}): ReactElement {
  const handlePress = useCallback(() => {
    void onRemove(principalId, label);
  }, [label, onRemove, principalId]);

  return (
    <View style={[settingsStyles.row, bordered ? settingsStyles.rowBorder : null]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        <Text style={settingsStyles.rowHint}>{principalId}</Text>
      </View>
      <View style={styles.rowTrailing}>
        <StatusBadge label={roleLabel} />
        {canRemove ? (
          <Button
            variant="outline"
            size="sm"
            onPress={handlePress}
            disabled={disabled}
            testID={`collab-share-remove-${principalId}`}
          >
            {removeLabel}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

function principalError(issue: SharePrincipalIssue | null, copy: CollabCopy): string | null {
  if (issue === "invalid") return copy.share.principalInvalid;
  if (issue === "self") return copy.share.principalSelf;
  if (issue === "owner") return copy.share.principalOwner;
  return null;
}

function submitErrorText(error: ShareSubmitError | null, copy: CollabCopy): string | null {
  if (error === "revoked") return copy.share.revoked;
  if (error === "failed") return copy.share.failed;
  if (error === "enable_failed") return copy.share.enableFailed;
  return null;
}

function isAccessRevoked(error: unknown): boolean {
  return error instanceof Error && error.message.includes("revoked");
}

export function ShareWorkspaceSheet(props: ShareWorkspaceSheetProps): ReactElement | null {
  const supported = useHostFeature(props.serverId, "enterpriseCollaborationV1");
  if (!props.visible || !supported) return null;
  return <ShareWorkspaceSheetOpen key={props.viewerPrincipalId} {...props} />;
}

function ShareWorkspaceSheetOpen({
  viewerPrincipalId,
  viewerRole,
  serverId,
  presenceEntries,
  presenceNow,
  members,
  revoked,
  collaborationEnabled,
  canEnable,
  onClose,
  port,
}: ShareWorkspaceSheetProps): ReactElement {
  const copy = useCollabCopy();
  const model = useShareWorkspaceFormModel({
    viewerPrincipalId,
    viewerRole,
    members,
    revoked,
    collaborationEnabled,
    canEnable,
  });
  const state = useShareWorkspaceFormState(model);

  useEffect(() => {
    model.applySnapshot({
      viewerRole,
      members,
      revoked,
      collaborationEnabled,
      canEnable,
    });
  }, [canEnable, collaborationEnabled, members, model, revoked, viewerRole]);

  const roleOptions = useMemo<SelectFieldOption<ShareableMemberRole>[]>(
    () => [
      { id: "editor", value: "editor", label: copy.roles.editor },
      { id: "viewer", value: "viewer", label: copy.roles.viewer },
    ],
    [copy.roles.editor, copy.roles.viewer],
  );

  const handleShare = useCallback(async () => {
    const value = model.getState().submitValue;
    if (!value) return;
    model.setSubmitting(true);
    try {
      const nextMembers = await port.share(value.principalId, value.role);
      model.applyMembers(nextMembers);
      model.resetPrincipal();
      model.setSubmitting(false);
    } catch (error) {
      if (isAccessRevoked(error)) {
        model.applyRevoked(true);
        return;
      }
      model.setSubmitError("failed");
    }
  }, [model, port]);

  const handleRemove = useCallback(
    async (principalId: string, label: string) => {
      const confirmed = await confirmDialog({
        title: copy.share.removeTitle,
        message: formatCollabCopy(copy.share.removeMessage, { name: label }),
        confirmLabel: copy.share.confirmRemove,
        cancelLabel: copy.share.cancel,
        destructive: true,
      });
      if (!confirmed) return;
      model.setSubmitting(true);
      try {
        const nextMembers = await port.unshare(principalId);
        model.applyMembers(nextMembers);
        model.setSubmitting(false);
      } catch (error) {
        if (isAccessRevoked(error)) {
          model.applyRevoked(true);
          return;
        }
        model.setSubmitError("failed");
      }
    },
    [copy.share, model, port],
  );

  const header = useMemo<SheetHeader>(() => ({ title: copy.share.title }), [copy.share.title]);
  const errorText = submitErrorText(state.submitError, copy);
  const selectedDisplay = useMemo(
    () => ({ label: copy.roles[state.role] }),
    [copy.roles, state.role],
  );
  const handleSharePress = useCallback(() => {
    void handleShare();
  }, [handleShare]);
  const handleEnable = useCallback(async () => {
    model.setSubmitting(true);
    try {
      const result = await port.enable();
      model.applySnapshot({
        viewerRole: result.viewerRole,
        members: result.members,
        revoked: false,
        collaborationEnabled: true,
        canEnable: false,
      });
      model.setSubmitting(false);
    } catch (error) {
      if (isAccessRevoked(error)) {
        model.applyRevoked(true);
        return;
      }
      model.setSubmitError("enable_failed");
    }
  }, [model, port]);
  const handleEnablePress = useCallback(() => {
    void handleEnable();
  }, [handleEnable]);
  const handleRoleChange = useCallback(
    (value: ShareableMemberRole) => {
      model.setRole(value);
    },
    [model],
  );

  let primaryAction: ReactElement | null = null;
  if (state.canEnable) {
    primaryAction = (
      <Button
        variant="default"
        size="md"
        style={styles.footerButton}
        onPress={handleEnablePress}
        disabled={state.isSubmitting}
        loading={state.isSubmitting}
        testID="collab-share-enable"
      >
        {state.isSubmitting ? copy.share.enabling : copy.share.enable}
      </Button>
    );
  } else if (state.canManage) {
    primaryAction = (
      <Button
        variant="default"
        size="md"
        style={styles.footerButton}
        onPress={handleSharePress}
        disabled={!state.canSubmit}
        loading={state.isSubmitting}
        testID="collab-share-add"
      >
        {state.isSubmitting ? copy.share.adding : copy.share.add}
      </Button>
    );
  }

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" size="md" style={styles.footerButton} onPress={onClose}>
          {copy.share.close}
        </Button>
        {primaryAction}
      </View>
    ),
    [copy.share.close, onClose, primaryAction],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      footer={footer}
      desktopMaxWidth={440}
      testID="collab-share-sheet"
    >
      <Text style={styles.subtitle}>
        {state.canEnable ? copy.share.enableHint : copy.share.subtitle}
      </Text>
      {errorText ? <Alert variant="error" title={errorText} /> : null}
      {!state.canManage && !state.revoked && !state.canEnable ? (
        <Alert
          variant="info"
          title={state.collaborationEnabled ? copy.share.readOnly : copy.share.collaborationOff}
        />
      ) : null}
      {state.canManage ? (
        <View style={styles.fields}>
          <Field
            label={copy.share.principalLabel}
            error={principalError(state.principalIssue, copy)}
          >
            <FormTextInput
              initialValue=""
              resetKey={state.principalResetKey}
              onChangeText={model.setPrincipalId}
              placeholder={copy.share.principalPlaceholder}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!state.isSubmitting}
              accessibilityLabel={copy.share.principalLabel}
              testID="collab-share-principal"
            />
          </Field>
          <SelectField
            label={copy.share.roleLabel}
            value={state.role}
            selectedDisplay={selectedDisplay}
            options={roleOptions}
            onChange={handleRoleChange}
            placeholder={copy.share.roleLabel}
            emptyText={copy.share.roleLabel}
            disabled={state.isSubmitting}
            title={copy.share.roleLabel}
            testID="collab-share-role"
            triggerTestID="collab-share-role-trigger"
          />
        </View>
      ) : null}
      {state.collaborationEnabled || state.members.length > 0 ? (
        <>
          <Text style={settingsStyles.sectionHeaderTitle}>{copy.share.members}</Text>
          <View style={settingsStyles.card}>
            {state.members.map((member, index) => (
              <MemberRow
                key={member.principalId}
                principalId={member.principalId}
                label={member.isSelf ? copy.share.you : member.principalId}
                roleLabel={copy.roles[member.role]}
                canRemove={member.canRemove}
                bordered={index > 0}
                removeLabel={copy.share.remove}
                disabled={state.isSubmitting}
                onRemove={handleRemove}
              />
            ))}
          </View>
        </>
      ) : null}
      {presenceEntries ? (
        <View style={styles.presence}>
          <PresenceList
            serverId={serverId}
            entries={presenceEntries}
            viewerPrincipalId={viewerPrincipalId}
            now={presenceNow ?? Date.now()}
          />
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    marginBottom: theme.spacing[4],
  },
  fields: {
    gap: theme.spacing[4],
    marginBottom: theme.spacing[6],
  },
  presence: {
    marginTop: theme.spacing[6],
  },
  footer: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  rowTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
