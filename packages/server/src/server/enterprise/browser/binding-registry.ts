import { promises as fs } from "node:fs";
import {
  BrowserProfileBindingSchema,
  BrowserProfileRecordSchema,
  EnterpriseResourceOwnerSchema,
  PrincipalIdSchema,
  type AuthorizedAgent,
  type AuthorizedBrowserProfile,
  type AuthorizedWorkspace,
  type BrowserProfileBinding,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../atomic-file.js";

const StrictBrowserProfileBindingSchema = BrowserProfileBindingSchema.strict();
const AuthorizedWorkspaceSchema = EnterpriseResourceOwnerSchema.extend({
  workspaceId: z.string().min(1),
}).strict();
const AuthorizedAgentSchema = EnterpriseResourceOwnerSchema.extend({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
}).strict();
const BindBrowserProfileInputSchema = z
  .object({
    workspace: AuthorizedWorkspaceSchema,
    profile: BrowserProfileRecordSchema.strict(),
    boundByPrincipalId: PrincipalIdSchema,
    boundAt: z.string().min(1),
  })
  .strict();
const BrowserProfileBindingRegistrySnapshotSchema = z
  .object({
    version: z.literal(1),
    bindings: z.array(StrictBrowserProfileBindingSchema),
  })
  .strict();

export type BrowserProfileBindingRegistrySnapshot = z.infer<
  typeof BrowserProfileBindingRegistrySnapshotSchema
>;

export interface BrowserProfileBindingStorage {
  read(): Promise<unknown | null>;
  write(snapshot: BrowserProfileBindingRegistrySnapshot): Promise<void>;
}

export class BrowserProfileBindingRegistryCorruptError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserProfileBindingRegistryCorruptError";
  }
}

export class JsonFileBrowserProfileBindingStorage implements BrowserProfileBindingStorage {
  public constructor(private readonly filePath: string) {}

  public async read(): Promise<unknown | null> {
    let contents: string;
    try {
      contents = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return null;
      }
      throw error;
    }
    try {
      return JSON.parse(contents) as unknown;
    } catch (error) {
      throw new BrowserProfileBindingRegistryCorruptError(
        "Browser Profile binding registry contains invalid JSON.",
        { cause: error },
      );
    }
  }

  public write(snapshot: BrowserProfileBindingRegistrySnapshot): Promise<void> {
    return writeJsonFileAtomic(this.filePath, snapshot);
  }
}

export class BrowserProfileBindingRegistry {
  private readonly bindings = new Map<string, BrowserProfileBinding>();
  private initialization: Promise<void> | null = null;
  private corruptError: BrowserProfileBindingRegistryCorruptError | null = null;
  private initialized = false;
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: { storage: BrowserProfileBindingStorage }) {}

  public async initialize(): Promise<void> {
    if (this.corruptError) {
      throw this.corruptError;
    }
    if (this.initialized) {
      return;
    }
    this.initialization ??= this.load();
    try {
      await this.initialization;
    } finally {
      if (!this.initialized && !this.corruptError) {
        this.initialization = null;
      }
    }
  }

  public async list(): Promise<BrowserProfileBinding[]> {
    await this.initialize();
    return Array.from(this.bindings.values(), cloneBinding).sort((a, b) =>
      bindingKey(a).localeCompare(bindingKey(b)),
    );
  }

  public bind(input: {
    workspace: AuthorizedWorkspace;
    profile: AuthorizedBrowserProfile;
    boundByPrincipalId: string;
    boundAt: string;
  }): Promise<BrowserProfileBinding> {
    return this.mutate(async () => {
      const parsed = BindBrowserProfileInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(
          `Invalid Browser Profile binding input: ${parsed.error.issues[0]?.message}`,
        );
      }
      assertWorkspaceCanBindProfile(parsed.data.workspace, parsed.data.profile);
      const binding = StrictBrowserProfileBindingSchema.parse({
        organizationId: parsed.data.workspace.organizationId,
        nodeId: parsed.data.workspace.nodeId,
        workspaceId: parsed.data.workspace.workspaceId,
        browserProfileId: parsed.data.profile.browserProfileId,
        boundByPrincipalId: parsed.data.boundByPrincipalId,
        boundAt: parsed.data.boundAt,
      });
      const key = bindingKey(binding);
      const next = new Map(this.bindings).set(key, binding);
      await this.persist(next);
      this.bindings.set(key, binding);
      return cloneBinding(binding);
    });
  }

  public resolveForAgent(input: {
    workspace: AuthorizedWorkspace;
    agent: AuthorizedAgent;
  }): Promise<BrowserProfileBinding | null> {
    return this.resolveForAgentInternal(input);
  }

  public unbind(workspace: AuthorizedWorkspace): Promise<void> {
    return this.mutate(async () => {
      const parsedWorkspace = AuthorizedWorkspaceSchema.parse(workspace);
      const key = bindingKey(parsedWorkspace);
      if (!this.bindings.has(key)) {
        return;
      }
      const next = new Map(this.bindings);
      next.delete(key);
      await this.persist(next);
      this.bindings.delete(key);
    });
  }

  private async resolveForAgentInternal(input: {
    workspace: AuthorizedWorkspace;
    agent: AuthorizedAgent;
  }): Promise<BrowserProfileBinding | null> {
    await this.initialize();
    const workspace = AuthorizedWorkspaceSchema.parse(input.workspace);
    const agent = AuthorizedAgentSchema.parse(input.agent);
    assertCanonicalAgentWorkspace(agent, workspace);
    const binding = this.bindings.get(bindingKey(workspace));
    return binding ? cloneBinding(binding) : null;
  }

  private async load(): Promise<void> {
    let raw: unknown | null;
    try {
      raw = await this.options.storage.read();
    } catch (error) {
      if (error instanceof BrowserProfileBindingRegistryCorruptError) {
        this.corruptError = error;
      }
      throw error;
    }

    try {
      const snapshot = BrowserProfileBindingRegistrySnapshotSchema.parse(
        raw ?? { version: 1, bindings: [] },
      );
      const bindings = new Map<string, BrowserProfileBinding>();
      for (const binding of snapshot.bindings) {
        const key = bindingKey(binding);
        if (bindings.has(key)) {
          throw new Error(`Duplicate Browser Profile binding for ${binding.workspaceId}.`);
        }
        bindings.set(key, binding);
      }
      this.bindings.clear();
      for (const [key, binding] of bindings) {
        this.bindings.set(key, binding);
      }
      this.initialized = true;
    } catch (error) {
      this.corruptError = new BrowserProfileBindingRegistryCorruptError(
        "Browser Profile binding registry is corrupt and was not loaded.",
        { cause: error },
      );
      throw this.corruptError;
    }
  }

  private async persist(bindings: ReadonlyMap<string, BrowserProfileBinding>): Promise<void> {
    await this.options.storage.write({
      version: 1,
      bindings: Array.from(bindings.values(), cloneBinding),
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(async () => {
      await this.initialize();
      return operation();
    });
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function assertWorkspaceCanBindProfile(
  workspace: AuthorizedWorkspace,
  profile: AuthorizedBrowserProfile,
): void {
  if (workspace.organizationId !== profile.organizationId) {
    throw new Error("Browser Profile binding organization does not match the Workspace.");
  }
  if (workspace.nodeId !== profile.homeNodeId) {
    throw new Error("Browser Profile binding node does not match the Workspace.");
  }
  if (workspace.ownerPrincipalId !== profile.ownerPrincipalId) {
    throw new Error("Browser Profile binding owner does not match the Workspace.");
  }
}

function assertCanonicalAgentWorkspace(
  agent: AuthorizedAgent,
  workspace: AuthorizedWorkspace,
): void {
  if (
    agent.workspaceId !== workspace.workspaceId ||
    agent.organizationId !== workspace.organizationId ||
    agent.nodeId !== workspace.nodeId ||
    agent.ownerPrincipalId !== workspace.ownerPrincipalId ||
    agent.createdByPrincipalId !== workspace.createdByPrincipalId
  ) {
    throw new Error("AuthorizedAgent does not match the canonical AuthorizedWorkspace.");
  }
}

function bindingKey(
  binding: Pick<BrowserProfileBinding, "organizationId" | "nodeId" | "workspaceId">,
): string {
  return JSON.stringify([binding.organizationId, binding.nodeId, binding.workspaceId]);
}

function cloneBinding(binding: BrowserProfileBinding): BrowserProfileBinding {
  return StrictBrowserProfileBindingSchema.parse(binding);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
