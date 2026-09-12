import { describe, expect, test } from "vitest";
import { z } from "zod";

import { ChatCreateRequestSchema } from "./chat/rpc-schemas.js";
import { LoopRunRequestSchema } from "./loop/rpc-schemas.js";
import {
  DirectorySuggestionsRequestSchema,
  FetchRecentProviderSessionsRequestMessageSchema,
  FileDownloadTokenRequestSchema,
  FileEntryCreateRequestSchema,
  FileEntryDeleteRequestSchema,
  FileEntryDuplicateRequestSchema,
  FileEntryRenameRequestSchema,
  FileExplorerRequestSchema,
  FileSubscribeRequestSchema,
  FileUploadRequestSchema,
  FileUploadResponseSchema,
  FileWriteRequestSchema,
  GetProvidersSnapshotRequestMessageSchema,
  ListProviderFeaturesRequestMessageSchema,
  ListProviderModelsRequestMessageSchema,
  ListProviderModesRequestMessageSchema,
  ProjectIconRequestSchema,
  ReadProjectConfigRequestMessageSchema,
  RefreshProvidersSnapshotRequestMessageSchema,
  UploadedFileAttachmentSchema,
  WriteProjectConfigRequestMessageSchema,
} from "./messages.js";
import { ScheduleCreateRequestSchema } from "./schedule/rpc-schemas.js";

const WORKSPACE_ID = "wks_enterprise_1";

const workspaceScopedRequests: Array<{
  name: string;
  schema: z.ZodType;
  message: Record<string, unknown>;
}> = [
  {
    name: "file explorer",
    schema: FileExplorerRequestSchema,
    message: {
      type: "file_explorer_request",
      cwd: "/workspace",
      mode: "list",
      requestId: "req-file-explorer",
    },
  },
  {
    name: "file subscription",
    schema: FileSubscribeRequestSchema,
    message: {
      type: "fs.file.subscribe.request",
      cwd: "/workspace",
      path: "README.md",
      subscriptionId: "sub-1",
      requestId: "req-subscribe",
    },
  },
  {
    name: "file write",
    schema: FileWriteRequestSchema,
    message: {
      type: "fs.file.write.request",
      cwd: "/workspace",
      path: "README.md",
      content: "content",
      expectedModifiedAt: "2026-09-09T00:00:00.000Z",
      requestId: "req-write",
    },
  },
  {
    name: "file create",
    schema: FileEntryCreateRequestSchema,
    message: {
      type: "fs.entry.create.request",
      cwd: "/workspace",
      parentPath: "src",
      name: "new.ts",
      kind: "file",
      requestId: "req-create",
    },
  },
  {
    name: "file rename",
    schema: FileEntryRenameRequestSchema,
    message: {
      type: "fs.entry.rename.request",
      cwd: "/workspace",
      path: "old.ts",
      name: "new.ts",
      requestId: "req-rename",
    },
  },
  {
    name: "file duplicate",
    schema: FileEntryDuplicateRequestSchema,
    message: {
      type: "fs.entry.duplicate.request",
      cwd: "/workspace",
      path: "source.ts",
      requestId: "req-duplicate",
    },
  },
  {
    name: "file delete",
    schema: FileEntryDeleteRequestSchema,
    message: {
      type: "fs.entry.delete.request",
      cwd: "/workspace",
      path: "old.ts",
      requestId: "req-delete",
    },
  },
  {
    name: "file download",
    schema: FileDownloadTokenRequestSchema,
    message: {
      type: "file_download_token_request",
      cwd: "/workspace",
      path: "report.csv",
      requestId: "req-download",
    },
  },
  {
    name: "file upload",
    schema: FileUploadRequestSchema,
    message: {
      type: "file.upload.request",
      fileName: "report.csv",
      mimeType: "text/csv",
      size: 12,
      modifiedAt: "2026-09-09T00:00:00.000Z",
      requestId: "req-upload",
    },
  },
  {
    name: "cwd project icon",
    schema: ProjectIconRequestSchema,
    message: { type: "project_icon_request", cwd: "/workspace", requestId: "req-icon" },
  },
  {
    name: "project config read",
    schema: ReadProjectConfigRequestMessageSchema,
    message: {
      type: "read_project_config_request",
      repoRoot: "/workspace",
      requestId: "req-config-read",
    },
  },
  {
    name: "project config write",
    schema: WriteProjectConfigRequestMessageSchema,
    message: {
      type: "write_project_config_request",
      repoRoot: "/workspace",
      config: { worktree: { setup: "npm ci" } },
      expectedRevision: null,
      requestId: "req-config-write",
    },
  },
  {
    name: "directory suggestions",
    schema: DirectorySuggestionsRequestSchema,
    message: { type: "directory_suggestions_request", query: "src", requestId: "req-directory" },
  },
  {
    name: "recent Provider history",
    schema: FetchRecentProviderSessionsRequestMessageSchema,
    message: { type: "fetch_recent_provider_sessions_request", requestId: "req-recent" },
  },
  {
    name: "Provider models",
    schema: ListProviderModelsRequestMessageSchema,
    message: { type: "list_provider_models_request", provider: "codex", requestId: "req-models" },
  },
  {
    name: "Provider modes",
    schema: ListProviderModesRequestMessageSchema,
    message: { type: "list_provider_modes_request", provider: "codex", requestId: "req-modes" },
  },
  {
    name: "Provider features",
    schema: ListProviderFeaturesRequestMessageSchema,
    message: {
      type: "list_provider_features_request",
      draftConfig: { provider: "codex", cwd: "/workspace" },
      requestId: "req-features",
    },
  },
  {
    name: "Provider snapshot",
    schema: GetProvidersSnapshotRequestMessageSchema,
    message: { type: "get_providers_snapshot_request", requestId: "req-snapshot" },
  },
  {
    name: "Provider snapshot refresh",
    schema: RefreshProvidersSnapshotRequestMessageSchema,
    message: { type: "refresh_providers_snapshot_request", requestId: "req-refresh" },
  },
  {
    name: "schedule new-agent target",
    schema: ScheduleCreateRequestSchema,
    message: {
      type: "schedule/create",
      requestId: "req-schedule",
      prompt: "Run the task",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "codex", cwd: "/workspace" } },
    },
  },
  {
    name: "loop run",
    schema: LoopRunRequestSchema,
    message: { type: "loop/run", requestId: "req-loop", prompt: "Run", cwd: "/workspace" },
  },
  {
    name: "chat create",
    schema: ChatCreateRequestSchema,
    message: { type: "chat/create", requestId: "req-chat", name: "Room" },
  },
];

describe("enterprise Workspace request context", () => {
  test.each(workspaceScopedRequests)(
    "$name accepts and preserves workspaceId",
    ({ schema, message }) => {
      const withWorkspace =
        message.type === "schedule/create"
          ? {
              ...message,
              target: { ...(message.target as Record<string, unknown>), workspaceId: WORKSPACE_ID },
            }
          : { ...message, workspaceId: WORKSPACE_ID };

      expect(schema.parse(withWorkspace)).toMatchObject(withWorkspace);
    },
  );

  test.each(workspaceScopedRequests)(
    "$name keeps legacy single-user payloads parseable",
    ({ schema, message }) => {
      expect(schema.safeParse(message).success).toBe(true);
    },
  );

  test("Workspace context never admits client-supplied owner, organization, or node authority", () => {
    const parsed = FileExplorerRequestSchema.parse({
      type: "file_explorer_request",
      cwd: "/workspace",
      workspaceId: WORKSPACE_ID,
      mode: "list",
      requestId: "req-untrusted-authority",
      organizationId: "org_1111111111111111",
      nodeId: "nod_2222222222222222",
      ownerPrincipalId: "usr_3333333333333333",
    });

    expect(parsed).not.toHaveProperty("organizationId");
    expect(parsed).not.toHaveProperty("nodeId");
    expect(parsed).not.toHaveProperty("ownerPrincipalId");
  });

  test("upload wire shapes carry optional opaque upload and Workspace correlation", () => {
    const attachment = {
      type: "uploaded_file",
      id: "legacy-id",
      uploadId: "upl_opaque_1",
      workspaceId: WORKSPACE_ID,
      fileName: "report.csv",
      mimeType: "text/csv",
      size: 12,
      path: "/legacy/path/report.csv",
    } as const;
    const response = {
      type: "file.upload.response",
      payload: {
        requestId: "req-upload",
        uploadId: attachment.uploadId,
        workspaceId: WORKSPACE_ID,
        file: attachment,
        error: null,
      },
    } as const;

    expect(UploadedFileAttachmentSchema.parse(attachment)).toEqual(attachment);
    expect(FileUploadResponseSchema.parse(response)).toEqual(response);
    expect(
      UploadedFileAttachmentSchema.safeParse({
        type: "uploaded_file",
        id: "legacy-id",
        fileName: "report.csv",
        mimeType: "text/csv",
        size: 12,
        path: "/legacy/path/report.csv",
      }).success,
    ).toBe(true);
  });
});
