import type { AuthorizedWorkspace, EnterpriseAction } from "@getpaseo/protocol/messages";
export interface WorkspacePathIdentity {
  dev: number;
  ino: number;
}
export interface SafeFileHandle {
  stat(): Promise<WorkspacePathIdentity & { size: number; mtimeMs: number }>;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface SafeDirectoryHandle {
  stat(): Promise<WorkspacePathIdentity & { isDirectory(): boolean }>;
  close(): Promise<void>;
}
export interface SafeWorkspaceFsPort {
  readonly supportsDirectoryRelativeOperations: boolean;
  openWorkspaceRoot(root: string): Promise<SafeDirectoryHandle>;
  read(root: SafeDirectoryHandle, path: readonly string[]): Promise<SafeFileHandle>;
  list(root: SafeDirectoryHandle, path: readonly string[]): Promise<readonly string[]>;
  listRoot(root: SafeDirectoryHandle): Promise<readonly string[]>;
  write(root: SafeDirectoryHandle, path: readonly string[], bytes: Uint8Array): Promise<void>;
  create(
    root: SafeDirectoryHandle,
    path: readonly string[],
    kind: "file" | "directory",
  ): Promise<void>;
  rename(root: SafeDirectoryHandle, from: readonly string[], to: readonly string[]): Promise<void>;
  copy(root: SafeDirectoryHandle, from: readonly string[], to: readonly string[]): Promise<void>;
  delete(root: SafeDirectoryHandle, path: readonly string[]): Promise<void>;
  watch(root: SafeDirectoryHandle, path: readonly string[]): Promise<AsyncDisposable>;
}
export interface WorkspacePathPolicyOptions {
  authorizeWorkspace(input: {
    workspaceId: string;
    action: EnterpriseAction;
  }): Promise<AuthorizedWorkspace>;
  resolveCanonicalRoot(workspace: AuthorizedWorkspace): Promise<string>;
  fs: SafeWorkspaceFsPort;
}
export interface WorkspaceReadHandle extends SafeFileHandle {}
interface Context {
  workspaceId: string;
  path: readonly string[];
  root: SafeDirectoryHandle;
}

/** Enterprise file facade. The injected port owns all handle-relative safety; unsupported ports fail closed. */
export class WorkspacePathPolicy {
  private readonly options: WorkspacePathPolicyOptions;
  constructor(options: WorkspacePathPolicyOptions) {
    this.options = options;
  }
  async read(workspaceId: string, p: string): Promise<WorkspaceReadHandle> {
    const c = await this.context(workspaceId, "workspace.content.read", p);
    try {
      const f = await this.options.fs.read(c.root, c.path);
      return composite(f, c.root);
    } catch (e) {
      await closePreserving(e, [c.root]);
      throw e;
    }
  }
  async list(workspaceId: string, p: string) {
    return this.with(workspaceId, "workspace.content.read", p, (c) =>
      this.options.fs.list(c.root, c.path),
    );
  }
  async listRoot(workspaceId: string) {
    const c = await this.context(workspaceId, "workspace.content.read");
    try {
      const result = await this.options.fs.listRoot(c.root);
      await closePreserving(undefined, [c.root]);
      return result;
    } catch (e) {
      await closePreserving(e, [c.root]);
      throw e;
    }
  }
  async write(workspaceId: string, p: string, b: Uint8Array) {
    return this.with(workspaceId, "workspace.write", p, (c) =>
      this.options.fs.write(c.root, c.path, b),
    );
  }
  async create(workspaceId: string, p: string, k: "file" | "directory") {
    return this.with(workspaceId, "workspace.write", p, (c) =>
      this.options.fs.create(c.root, c.path, k),
    );
  }
  async rename(workspaceId: string, a: string, b: string) {
    const c = await this.context(workspaceId, "workspace.write", a);
    try {
      await this.options.fs.rename(c.root, c.path, parse(b));
    } catch (e) {
      await closePreserving(e, [c.root]);
      throw e;
    }
    await closePreserving(undefined, [c.root]);
  }
  async copy(workspaceId: string, a: string, b: string) {
    const c = await this.context(workspaceId, "workspace.write", a);
    try {
      await this.options.fs.copy(c.root, c.path, parse(b));
    } catch (e) {
      await closePreserving(e, [c.root]);
      throw e;
    }
    await closePreserving(undefined, [c.root]);
  }
  async delete(workspaceId: string, p: string) {
    return this.with(workspaceId, "workspace.write", p, (c) =>
      this.options.fs.delete(c.root, c.path),
    );
  }
  async watch(workspaceId: string, p: string) {
    const c = await this.context(workspaceId, "workspace.content.read", p);
    let s: AsyncDisposable;
    try {
      s = await this.options.fs.watch(c.root, c.path);
    } catch (e) {
      await closePreserving(e, [c.root]);
      throw e;
    }
    let disposePromise: Promise<void> | undefined;
    return {
      [Symbol.asyncDispose]: async () => {
        disposePromise ??= (async () => {
          let first: unknown;
          try {
            await s[Symbol.asyncDispose]();
          } catch (e) {
            first = e;
          }
          try {
            await closePreserving(first, [c.root]);
          } catch (e) {
            if (first === undefined) first = e;
          }
          if (first !== undefined) throw first;
        })();
        return disposePromise;
      },
    };
  }
  private async with<T>(
    workspaceId: string,
    action: EnterpriseAction,
    p: string,
    fn: (c: Context) => Promise<T>,
  ) {
    const c = await this.context(workspaceId, action, p);
    let result: T;
    try {
      result = await fn(c);
    } catch (e) {
      await closePreserving(e, [c.root]);
      throw e;
    }
    await closePreserving(undefined, [c.root]);
    return result;
  }
  private async context(
    workspaceId: string,
    action: EnterpriseAction,
    p?: string,
  ): Promise<Context> {
    if (!this.options.fs.supportsDirectoryRelativeOperations)
      throw new Error("Enterprise workspace safe-FS port is unavailable");
    const relativePath = p === undefined ? [] : parse(p);
    const a = await this.options.authorizeWorkspace({ workspaceId, action });
    const root = await this.options.fs.openWorkspaceRoot(
      await this.options.resolveCanonicalRoot(a),
    );
    try {
      const s = await root.stat();
      if (!s.isDirectory()) throw new Error("Workspace root is not a directory");
      return { workspaceId: a.workspaceId, path: relativePath, root };
    } catch (e) {
      await closePreserving(e, [root]);
      throw e;
    }
  }
}
function parse(v: string) {
  if (!v || v.includes("\0") || v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v))
    throw new Error("Unsafe workspace path");
  const s = v.split("/");
  if (s.some((x) => !x || x === "." || x === ".." || x.includes("\\")))
    throw new Error("Unsafe workspace path");
  return s;
}
function composite(f: SafeFileHandle, r: SafeDirectoryHandle): WorkspaceReadHandle {
  let closePromise: Promise<void> | undefined;
  let inFlight = 0;
  let drained: (() => void) | undefined;
  const ensureOpen = () => {
    if (closePromise) throw new Error("Workspace read handle is closed");
  };
  return {
    stat: async () => {
      ensureOpen();
      inFlight += 1;
      try {
        return await f.stat();
      } finally {
        inFlight -= 1;
        if (inFlight === 0) drained?.();
      }
    },
    read: async (o, l) => {
      ensureOpen();
      if (
        !Number.isSafeInteger(o) ||
        o < 0 ||
        !Number.isSafeInteger(l) ||
        l < 0 ||
        l > 8 * 1024 * 1024
      )
        throw new Error("Invalid read range");
      if (!Number.isSafeInteger(o + l)) throw new Error("Invalid read range");
      inFlight += 1;
      try {
        return await f.read(o, l);
      } finally {
        inFlight -= 1;
        if (inFlight === 0) drained?.();
      }
    },
    close: () => {
      closePromise ??= (async () => {
        if (inFlight > 0)
          await new Promise<void>((resolve) => {
            drained = resolve;
          });
        await closePreserving(undefined, [f, r]);
      })();
      return closePromise;
    },
  };
}
async function closePreserving(primary: unknown, hs: readonly { close(): Promise<void> }[]) {
  let first: unknown;
  for (const h of hs) {
    try {
      await h.close();
    } catch (e) {
      if (first === undefined) first = e;
    }
  }
  if (primary !== undefined) throw primary;
  if (first !== undefined) throw first;
}
