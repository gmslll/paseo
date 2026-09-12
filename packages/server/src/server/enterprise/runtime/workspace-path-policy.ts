import type { AuthorizedWorkspace, EnterpriseAction } from "@getpaseo/protocol/messages";
export interface WorkspacePathIdentity {
  dev: number;
  ino: number;
}
export interface WorkspacePathStat extends WorkspacePathIdentity {
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
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
  readonly releaseReady: boolean;
  readonly supportsDirectoryRelativeOperations: boolean;
  openWorkspaceRoot(root: string): Promise<SafeDirectoryHandle>;
  read(root: SafeDirectoryHandle, path: readonly string[]): Promise<SafeFileHandle>;
  stat(root: SafeDirectoryHandle, path: readonly string[]): Promise<WorkspacePathStat>;
  list(root: SafeDirectoryHandle, path: readonly string[]): Promise<readonly string[]>;
  listRoot(root: SafeDirectoryHandle): Promise<readonly string[]>;
  write(
    root: SafeDirectoryHandle,
    path: readonly string[],
    bytes: Uint8Array,
    expected: { readonly modifiedAt: string; readonly revision?: string },
  ): Promise<void>;
  create(
    root: SafeDirectoryHandle,
    path: readonly string[],
    kind: "file" | "directory",
  ): Promise<void>;
  rename(root: SafeDirectoryHandle, from: readonly string[], to: readonly string[]): Promise<void>;
  copy(root: SafeDirectoryHandle, from: readonly string[], to: readonly string[]): Promise<void>;
  delete(root: SafeDirectoryHandle, path: readonly string[]): Promise<void>;
  watch(
    root: SafeDirectoryHandle,
    path: readonly string[],
    onChange?: () => void,
  ): Promise<AsyncDisposable>;
}
export interface WorkspacePathPolicyOptions {
  authorizeWorkspace(input: {
    workspaceId: string;
    action: EnterpriseAction;
  }): Promise<AuthorizedWorkspace>;
  resolveCanonicalRoot(workspace: AuthorizedWorkspace): Promise<string>;
  fs: SafeWorkspaceFsPort;
  isCurrent?: () => boolean;
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
  private readonly isCurrent: () => boolean;
  constructor(options: WorkspacePathPolicyOptions) {
    this.options = options;
    const isCurrent = options.isCurrent ?? (() => true);
    this.isCurrent = () => {
      try {
        return isCurrent() === true;
      } catch {
        return false;
      }
    };
  }
  async read(workspaceId: string, p: string): Promise<WorkspaceReadHandle> {
    const c = await this.context(workspaceId, "workspace.content.read", p);
    let f: SafeFileHandle | null = null;
    try {
      this.assertCurrent();
      f = await this.options.fs.read(c.root, c.path);
      this.assertCurrent();
      return composite(f, c.root);
    } catch (e) {
      await closePreserving(e, [...(f ? [f] : []), c.root]);
      throw e;
    }
  }
  async stat(workspaceId: string, p: string): Promise<WorkspacePathStat> {
    return this.with(workspaceId, "workspace.content.read", p, (c) =>
      this.options.fs.stat(c.root, c.path),
    );
  }
  async list(workspaceId: string, p: string) {
    return this.with(workspaceId, "workspace.content.read", p, (c) =>
      this.options.fs.list(c.root, c.path),
    );
  }
  async listRoot(workspaceId: string) {
    const c = await this.context(workspaceId, "workspace.content.read");
    try {
      this.assertCurrent();
      const result = await this.options.fs.listRoot(c.root);
      this.assertCurrent();
      await closePreserving(undefined, [c.root]);
      return result;
    } catch (e) {
      await closePreserving(e, [c.root]);
      throw e;
    }
  }
  async write(
    workspaceId: string,
    p: string,
    b: Uint8Array,
    expected: { readonly modifiedAt: string; readonly revision?: string },
  ) {
    return this.with(workspaceId, "workspace.write", p, (c) =>
      this.options.fs.write(c.root, c.path, b, expected),
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
      this.assertCurrent();
      await this.options.fs.rename(c.root, c.path, parse(b));
      this.assertCurrent();
    } catch (e) {
      await closePreserving(e, [c.root]);
      throw e;
    }
    await closePreserving(undefined, [c.root]);
  }
  async copy(workspaceId: string, a: string, b: string) {
    const c = await this.context(workspaceId, "workspace.write", a);
    try {
      this.assertCurrent();
      await this.options.fs.copy(c.root, c.path, parse(b));
      this.assertCurrent();
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
  async watch(workspaceId: string, p: string, onChange?: () => void) {
    const c = await this.context(workspaceId, "workspace.content.read", p);
    let s: AsyncDisposable | null = null;
    try {
      this.assertCurrent();
      s = await this.options.fs.watch(c.root, c.path, onChange);
      this.assertCurrent();
    } catch (e) {
      await disposePreserving(e, s, c.root);
      throw e;
    }
    const subscription = s;
    let disposePromise: Promise<void> | undefined;
    return {
      [Symbol.asyncDispose]: () => {
        disposePromise ??= (async () => {
          let first: unknown;
          try {
            await subscription[Symbol.asyncDispose]();
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
      this.assertCurrent();
      result = await fn(c);
      this.assertCurrent();
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
    if (!this.options.fs.releaseReady || !this.options.fs.supportsDirectoryRelativeOperations)
      throw new Error("Enterprise workspace safe-FS port is unavailable");
    const relativePath = p === undefined ? [] : parse(p);
    this.assertCurrent();
    const a = await this.options.authorizeWorkspace({ workspaceId, action });
    this.assertCurrent();
    const canonicalRoot = await this.options.resolveCanonicalRoot(a);
    this.assertCurrent();
    const root = await this.options.fs.openWorkspaceRoot(canonicalRoot);
    try {
      this.assertCurrent();
      const s = await root.stat();
      this.assertCurrent();
      if (!s.isDirectory()) throw new Error("Workspace root is not a directory");
      return { workspaceId: a.workspaceId, path: relativePath, root };
    } catch (e) {
      await closePreserving(e, [root]);
      throw e;
    }
  }

  private assertCurrent(): void {
    if (!this.isCurrent()) throw new Error("Enterprise workspace operation is no longer current");
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

async function disposePreserving(
  primary: unknown,
  subscription: AsyncDisposable | null,
  root: SafeDirectoryHandle,
): Promise<void> {
  let first = primary;
  if (subscription) {
    try {
      await subscription[Symbol.asyncDispose]();
    } catch (error) {
      if (first === undefined) first = error;
    }
  }
  await closePreserving(first, [root]);
}
