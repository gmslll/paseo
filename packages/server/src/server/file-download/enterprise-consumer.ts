import {
  NodeContextSchema,
  PrincipalContextSchema,
  type NodeContext,
  type PrincipalContext,
  type ResourceGrant,
  type ResourceSelector,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { EnterpriseSessionContext } from "../enterprise/identity/session-context.js";
import type {
  DownloadFileIdentity,
  DownloadTokenPolicy,
} from "../enterprise/runtime/download-token-policy.js";
import type {
  SafeWorkspaceFsPort,
  WorkspaceReadHandle,
} from "../enterprise/runtime/workspace-path-policy.js";

const EnterpriseSessionContextSchema = z
  .object({
    principal: PrincipalContextSchema,
    node: NodeContextSchema,
    sessionBindingGeneration: z.string().min(1),
  })
  .strict();

const EnterpriseDownloadHttpRequestSchema = z
  .object({
    context: EnterpriseSessionContextSchema,
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1),
    token: z.string().min(1),
  })
  .strict();

export interface EnterpriseDownloadPathPolicy {
  read(workspaceId: string, relativePath: string): Promise<WorkspaceReadHandle>;
}

export interface EnterpriseDownloadHttpRequest {
  readonly context: EnterpriseSessionContext;
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly token: string;
}

export interface EnterpriseDownloadReadCapability {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly modifiedAt: string;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface EnterpriseDownloadHttpConsumerOptions {
  readonly safeFs: Pick<
    SafeWorkspaceFsPort,
    "releaseReady" | "supportsDirectoryRelativeOperations"
  >;
  readonly policy: Pick<DownloadTokenPolicy, "consume" | "burn">;
  createPathPolicy(context: EnterpriseSessionContext): EnterpriseDownloadPathPolicy;
  readonly lifecycle: EnterpriseDownloadHttpLifecycle;
}

export interface EnterpriseDownloadHttpLifecycle {
  begin(context: EnterpriseSessionContext): EnterpriseDownloadHttpLifecycleAttempt | null;
}

export interface EnterpriseDownloadHttpLifecycleAttempt {
  isCurrent(): boolean;
  publish(capability: EnterpriseDownloadReadCapability): EnterpriseDownloadReadCapability | null;
  recordCleanupFailure(error: unknown): void;
  finish(): void;
}

/** Burns an enterprise download token before returning one already-opened safe read capability. */
export class EnterpriseDownloadHttpConsumer {
  private readonly releaseReady: boolean;
  private readonly consumeToken: DownloadTokenPolicy["consume"];
  private readonly burnToken: DownloadTokenPolicy["burn"];
  private readonly createPathPolicy: EnterpriseDownloadHttpConsumerOptions["createPathPolicy"];
  private readonly beginLifecycle: EnterpriseDownloadHttpLifecycle["begin"];

  public constructor(options: EnterpriseDownloadHttpConsumerOptions) {
    this.releaseReady =
      options.safeFs.releaseReady === true &&
      options.safeFs.supportsDirectoryRelativeOperations === true;
    this.consumeToken = options.policy.consume.bind(options.policy);
    this.burnToken = options.policy.burn.bind(options.policy);
    const createPathPolicy = options.createPathPolicy;
    this.createPathPolicy = (context) => createPathPolicy(context);
    this.beginLifecycle = options.lifecycle.begin.bind(options.lifecycle);
  }

  public async consume(
    input: EnterpriseDownloadHttpRequest,
  ): Promise<EnterpriseDownloadReadCapability | null> {
    if (!this.releaseReady) return null;
    let token: string | null = null;
    let snapshot: unknown;
    try {
      token = input.token;
      snapshot = {
        context: input.context,
        workspaceId: input.workspaceId,
        relativePath: input.relativePath,
        token,
      };
    } catch {
      if (token !== null) this.burnToken(token);
      return null;
    }
    let parsed: ReturnType<typeof EnterpriseDownloadHttpRequestSchema.safeParse>;
    try {
      parsed = EnterpriseDownloadHttpRequestSchema.safeParse(snapshot);
    } catch {
      if (token !== null) this.burnToken(token);
      return null;
    }
    if (!parsed.success) {
      if (token !== null) this.burnToken(token);
      return null;
    }
    const request = freezeRequest(parsed.data);
    const lifecycle = this.beginLifecycle(request.context);
    if (lifecycle === null) {
      this.burnToken(request.token);
      return null;
    }

    let binding;
    try {
      binding = await this.consumeToken({
        principal: request.context.principal,
        node: request.context.node,
        sessionBindingGeneration: request.context.sessionBindingGeneration,
        workspaceId: request.workspaceId,
        relativePath: request.relativePath,
        token: request.token,
      });
    } catch {
      lifecycle.finish();
      return null;
    }
    if (binding === null || !lifecycleIsCurrent(lifecycle)) {
      lifecycle.finish();
      return null;
    }

    let handle: WorkspaceReadHandle | null = null;
    try {
      const paths = this.createPathPolicy(request.context);
      handle = await paths.read(binding.workspace.workspaceId, binding.relativePath);
      if (!lifecycleIsCurrent(lifecycle)) return null;
      const actualIdentity = await handle.stat();
      if (!lifecycleIsCurrent(lifecycle) || !sameIdentity(binding.fileIdentity, actualIdentity)) {
        return null;
      }
      const capability = freezeCapability({
        workspaceId: binding.workspace.workspaceId,
        relativePath: binding.relativePath,
        fileName: fileName(binding.relativePath),
        mimeType: mimeType(binding.relativePath),
        size: actualIdentity.size,
        modifiedAt: new Date(actualIdentity.mtimeMs).toISOString(),
        handle,
      });
      handle = null;
      let published: EnterpriseDownloadReadCapability | null = null;
      try {
        published = lifecycle.publish(capability);
      } catch {
        // A defective lifecycle seam fails closed; the opened handle is still closed below.
      }
      if (published !== null) return published;
      await closeForLifecycle(capability, lifecycle);
      return null;
    } catch {
      return null;
    } finally {
      if (handle) await closeForLifecycle(handle, lifecycle);
      lifecycle.finish();
    }
  }
}

function lifecycleIsCurrent(lifecycle: EnterpriseDownloadHttpLifecycleAttempt): boolean {
  try {
    return lifecycle.isCurrent() === true;
  } catch {
    return false;
  }
}

async function closeForLifecycle(
  resource: { close(): Promise<void> },
  lifecycle: EnterpriseDownloadHttpLifecycleAttempt,
): Promise<void> {
  try {
    await resource.close();
  } catch (error) {
    lifecycle.recordCleanupFailure(error);
  }
}

interface CapabilityInput {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly handle: WorkspaceReadHandle;
}

function freezeCapability(input: CapabilityInput): EnterpriseDownloadReadCapability {
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    workspaceId: input.workspaceId,
    relativePath: input.relativePath,
    fileName: input.fileName,
    mimeType: input.mimeType,
    size: input.size,
    modifiedAt: input.modifiedAt,
    read: (offset: number, length: number) => {
      if (closePromise) return Promise.reject(new Error("Download capability is closed."));
      return input.handle.read(offset, length);
    },
    close: () => {
      closePromise ??= input.handle.close();
      return closePromise;
    },
  });
}

function freezeRequest(input: z.infer<typeof EnterpriseDownloadHttpRequestSchema>) {
  return Object.freeze({
    context: Object.freeze({
      principal: freezePrincipal(input.context.principal),
      node: freezeNode(input.context.node),
      sessionBindingGeneration: input.context.sessionBindingGeneration,
    }),
    workspaceId: input.workspaceId,
    relativePath: input.relativePath,
    token: input.token,
  });
}

function freezePrincipal(input: PrincipalContext): PrincipalContext {
  const grants = input.grants.map(cloneGrant);
  Object.freeze(grants);
  if (input.principalType === "human") {
    return Object.freeze({ ...input, grants });
  }
  if (input.principalType === "service") {
    return Object.freeze({ ...input, grants });
  }
  return Object.freeze({
    principalType: input.principalType,
    principalId: input.principalId,
    organizationId: input.organizationId,
    grants,
    credentialId: input.credentialId,
    grantVersion: input.grantVersion,
  });
}

function cloneGrant(input: ResourceGrant): ResourceGrant {
  return Object.freeze({ action: input.action, selector: cloneSelector(input.selector) });
}

function cloneSelector(input: ResourceSelector): ResourceSelector {
  if (input.kind === "self") return Object.freeze({ kind: input.kind });
  if (input.kind === "organization") {
    return Object.freeze({ kind: input.kind, organizationId: input.organizationId });
  }
  const workspaceIds = [...input.workspaceIds];
  Object.freeze(workspaceIds);
  return Object.freeze({ kind: input.kind, workspaceIds });
}

function freezeNode(input: NodeContext): NodeContext {
  return Object.freeze({
    nodeId: input.nodeId,
    paseoServerId: input.paseoServerId,
    mode: input.mode,
  });
}

function sameIdentity(expected: DownloadFileIdentity, actual: DownloadFileIdentity): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs
  );
}

function fileName(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? "download";
}

function mimeType(relativePath: string): string {
  const extension = relativePath.toLowerCase().split(".").at(-1);
  if (extension === "txt") return "text/plain";
  if (extension === "csv") return "text/csv";
  if (extension === "json") return "application/json";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return "application/octet-stream";
}
