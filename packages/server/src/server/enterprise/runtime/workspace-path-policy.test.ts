import { describe, expect, it } from "vitest";
import type { AuthorizedWorkspace } from "@getpaseo/protocol/messages";
import { WorkspacePathPolicy, type SafeWorkspaceFsPort } from "./workspace-path-policy.js";

const workspace = {
  workspaceId: "workspace-1",
  organizationId: "org-1",
  nodeId: "node-1",
  ownerPrincipalId: "principal-1",
  createdByPrincipalId: "principal-1",
} satisfies AuthorizedWorkspace;

function fakeFs(supported: boolean): SafeWorkspaceFsPort {
  const handle = {
    stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }),
    close: async () => undefined,
  };
  return {
    releaseReady: true,
    supportsDirectoryRelativeOperations: supported,
    openWorkspaceRoot: async () => handle,
    read: async () => ({
      stat: async () => ({ dev: 1, ino: 2, size: 1, mtimeMs: 1 }),
      read: async () => new Uint8Array(),
      close: async () => undefined,
    }),
    stat: async () => ({ dev: 1, ino: 2, size: 1, mtimeMs: 1, kind: "file" }),
    list: async (_root, path) => (path.length === 0 ? ["src"] : ["main.ts"]),
    listRoot: async () => ["src"],
    write: async () => undefined,
    create: async () => undefined,
    rename: async () => undefined,
    copy: async () => undefined,
    delete: async () => undefined,
    watch: async () => ({ [Symbol.asyncDispose]: async () => undefined }),
  };
}

describe("WorkspacePathPolicy safe facade", () => {
  it("fails closed before authorization when the safe FS is not release ready", async () => {
    let authorized = 0;
    let opened = 0;
    const base = fakeFs(true);
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async () => {
        authorized += 1;
        return workspace;
      },
      resolveCanonicalRoot: async () => "/workspace",
      fs: {
        ...base,
        releaseReady: false,
        openWorkspaceRoot: async () => {
          opened += 1;
          return base.openWorkspaceRoot("/workspace");
        },
      },
    });

    await expect(policy.read(workspace.workspaceId, "src/main.ts")).rejects.toThrow(
      "safe-FS port is unavailable",
    );
    expect(authorized).toBe(0);
    expect(opened).toBe(0);
  });

  it("fails closed when directory-relative safe FS is unavailable", async () => {
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs: fakeFs(false),
    });
    await expect(policy.read(workspace.workspaceId, "src/main.ts")).rejects.toThrow(
      "safe-FS port is unavailable",
    );
  });

  it("passes only validated relative segments to the safe port and closes root handles", async () => {
    const fs = fakeFs(true);
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs,
    });
    await expect(policy.list(workspace.workspaceId, "src")).resolves.toEqual(["main.ts"]);
    await expect(policy.list(workspace.workspaceId, "./src")).rejects.toThrow();
    await expect(policy.list(workspace.workspaceId, "src/")).rejects.toThrow();
    await expect(policy.listRoot(workspace.workspaceId)).resolves.toEqual(["src"]);
  });

  it("returns a composite read handle that closes file and root exactly once", async () => {
    let fileClosed = 0;
    let rootClosed = 0;
    const fs = fakeFs(true);
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs: {
        ...fs,
        openWorkspaceRoot: async () => ({
          stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }),
          close: async () => {
            rootClosed += 1;
          },
        }),
        read: async () => ({
          stat: async () => ({ dev: 1, ino: 2, size: 1, mtimeMs: 1 }),
          read: async () => new Uint8Array(),
          close: async () => {
            fileClosed += 1;
          },
        }),
      },
    });
    const handle = await policy.read(workspace.workspaceId, "file.txt");
    await handle.close();
    await handle.close();
    expect(fileClosed).toBe(1);
    expect(rootClosed).toBe(1);
  });

  it("closes the root handle when a read operation fails", async () => {
    let closed = false;
    const fs = fakeFs(true);
    const failing: SafeWorkspaceFsPort = {
      ...fs,
      openWorkspaceRoot: async () => ({
        stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }),
        close: async () => {
          closed = true;
        },
      }),
      read: async () => {
        throw new Error("open failed");
      },
    };
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs: failing,
    });
    await expect(policy.read(workspace.workspaceId, "file.txt")).rejects.toThrow("open failed");
    expect(closed).toBe(true);
  });

  it("delegates every mutation and watch operation through the typed port", async () => {
    const calls: string[] = [];
    let rootCloses = 0;
    const base = fakeFs(true);
    const fs: SafeWorkspaceFsPort = {
      ...base,
      openWorkspaceRoot: async () => ({
        stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }),
        close: async () => {
          rootCloses += 1;
        },
      }),
      write: async () => {
        calls.push("write");
      },
      create: async (_root, _path, kind) => {
        calls.push(`create:${kind}`);
      },
      rename: async () => {
        calls.push("rename");
      },
      copy: async () => {
        calls.push("copy");
      },
      delete: async () => {
        calls.push("delete");
      },
      watch: async () => {
        calls.push("watch");
        return {
          [Symbol.asyncDispose]: async () => {
            calls.push("dispose");
          },
        };
      },
    };
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs,
    });
    await policy.write(workspace.workspaceId, "a.txt", new Uint8Array([1]), {
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });
    await policy.create(workspace.workspaceId, "b.txt", "file");
    await policy.create(workspace.workspaceId, "dir", "directory");
    await policy.rename(workspace.workspaceId, "a.txt", "c.txt");
    await policy.copy(workspace.workspaceId, "c.txt", "d.txt");
    await policy.delete(workspace.workspaceId, "d.txt");
    const subscription = await policy.watch(workspace.workspaceId, "src");
    await subscription[Symbol.asyncDispose]();
    expect(calls).toEqual([
      "write",
      "create:file",
      "create:directory",
      "rename",
      "copy",
      "delete",
      "watch",
      "dispose",
    ]);
    expect(rootCloses).toBe(7);
  });

  it("rejects unsafe paths before authorization or opening a root", async () => {
    let authorized = 0;
    let opened = 0;
    const base = fakeFs(true);
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async () => {
        authorized += 1;
        return workspace;
      },
      resolveCanonicalRoot: async () => "/workspace",
      fs: {
        ...base,
        openWorkspaceRoot: async () => {
          opened += 1;
          return base.openWorkspaceRoot("/workspace");
        },
      },
    });
    await expect(policy.list(workspace.workspaceId, "./bad")).rejects.toThrow();
    expect(authorized).toBe(0);
    expect(opened).toBe(0);
  });

  it("preserves a watch dispose error while still closing the root", async () => {
    let rootClosed = 0;
    const base = fakeFs(true);
    const fs: SafeWorkspaceFsPort = {
      ...base,
      openWorkspaceRoot: async () => ({
        stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }),
        close: async () => {
          rootClosed += 1;
        },
      }),
      watch: async () => ({
        [Symbol.asyncDispose]: async () => {
          throw new Error("dispose failed");
        },
      }),
    };
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs,
    });
    const subscription = await policy.watch(workspace.workspaceId, "src");
    await expect(subscription[Symbol.asyncDispose]()).rejects.toThrow("dispose failed");
    expect(rootClosed).toBe(1);
  });

  it("records exact authorization actions and operation arguments", async () => {
    const actions: string[] = [];
    const args: unknown[] = [];
    const base = fakeFs(true);
    const fs: SafeWorkspaceFsPort = {
      ...base,
      write: async (_r, p, b) => args.push(["write", p, [...b]]),
      create: async (_r, p, k) => args.push(["create", p, k]),
      rename: async (_r, a, b) => args.push(["rename", a, b]),
      copy: async (_r, a, b) => args.push(["copy", a, b]),
      delete: async (_r, p) => args.push(["delete", p]),
      list: async (_r, p) => {
        args.push(["list", p]);
        return [];
      },
      listRoot: async () => {
        args.push(["listRoot"]);
        return [];
      },
      read: async (_r, p) => {
        args.push(["read", p]);
        return await base.read(_r, p);
      },
      stat: async (_r, p) => {
        args.push(["stat", p]);
        return await base.stat(_r, p);
      },
      watch: async (_r, p) => {
        args.push(["watch", p]);
        return { [Symbol.asyncDispose]: async () => undefined };
      },
    };
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async ({ workspaceId, action }) => {
        actions.push(`${workspaceId}:${action}`);
        return workspace;
      },
      resolveCanonicalRoot: async () => "/workspace",
      fs,
    });
    await policy.read(workspace.workspaceId, "a/b").then((h) => h.close());
    await expect(policy.stat(workspace.workspaceId, "a/b")).resolves.toEqual({
      dev: 1,
      ino: 2,
      size: 1,
      mtimeMs: 1,
      kind: "file",
    });
    await policy.list(workspace.workspaceId, "a/b");
    await policy.listRoot(workspace.workspaceId);
    const watch = await policy.watch(workspace.workspaceId, "a/b");
    await watch[Symbol.asyncDispose]();
    await policy.write(workspace.workspaceId, "a/b", new Uint8Array([1, 2]), {
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });
    await policy.create(workspace.workspaceId, "c", "directory");
    await policy.rename(workspace.workspaceId, "a", "b");
    await policy.copy(workspace.workspaceId, "a", "b");
    await policy.delete(workspace.workspaceId, "a");
    expect(actions).toEqual([
      "workspace-1:workspace.content.read",
      "workspace-1:workspace.content.read",
      "workspace-1:workspace.content.read",
      "workspace-1:workspace.content.read",
      "workspace-1:workspace.content.read",
      "workspace-1:workspace.write",
      "workspace-1:workspace.write",
      "workspace-1:workspace.write",
      "workspace-1:workspace.write",
      "workspace-1:workspace.write",
    ]);
    expect(args).toContainEqual(["write", ["a", "b"], [1, 2]]);
    expect(args).toContainEqual(["create", ["c"], "directory"]);
    expect(args).toContainEqual(["read", ["a", "b"]]);
    expect(args).toContainEqual(["stat", ["a", "b"]]);
    expect(args).toContainEqual(["list", ["a", "b"]]);
    expect(args).toContainEqual(["listRoot"]);
    expect(args).toContainEqual(["watch", ["a", "b"]]);
    expect(args).toContainEqual(["rename", ["a"], ["b"]]);
    expect(args).toContainEqual(["copy", ["a"], ["b"]]);
    expect(args).toContainEqual(["delete", ["a"]]);
  });

  it("preserves primary errors across cleanup and rejects invalid read ranges", async () => {
    const base = fakeFs(true);
    let rootClosed = 0;
    const fs: SafeWorkspaceFsPort = {
      ...base,
      openWorkspaceRoot: async () => ({
        stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }),
        close: async () => {
          rootClosed++;
          throw new Error("close");
        },
      }),
      write: async () => {
        throw new Error("operation");
      },
    };
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs,
    });
    await expect(
      policy.write(workspace.workspaceId, "x", new Uint8Array(), {
        modifiedAt: "2026-09-10T00:00:00.000Z",
      }),
    ).rejects.toThrow("operation");
    expect(rootClosed).toBe(1);
    const h = await new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs: base,
    }).read(workspace.workspaceId, "x");
    await expect(h.read(-1, 1)).rejects.toThrow();
    await h.close();
    await expect(h.read(0, 1)).rejects.toThrow();
  });

  it("waits for an in-flight read before closing and rejects overflow ranges", async () => {
    let release!: () => void;
    let closed = false;
    const base = fakeFs(true);
    const fs: SafeWorkspaceFsPort = {
      ...base,
      read: async () => ({
        stat: async () => ({ dev: 1, ino: 2, size: 1, mtimeMs: 1 }),
        read: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return new Uint8Array([1]);
        },
        close: async () => {
          closed = true;
        },
      }),
    };
    const h = await new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs,
    }).read(workspace.workspaceId, "x");
    const read = h.read(Number.MAX_SAFE_INTEGER - 1, 1);
    const closing = h.close();
    const closing2 = h.close();
    let settled2 = false;
    void closing2.then(() => {
      settled2 = true;
      return undefined;
    });
    expect(closed).toBe(false);
    expect(settled2).toBe(false);
    release();
    await read;
    await closing;
    await closing2;
    expect(closed).toBe(true);
    await expect(h.read(Number.MAX_SAFE_INTEGER, 1)).rejects.toThrow(
      "Workspace read handle is closed",
    );
    await h.close();
  });

  it("shares read close failure with concurrent callers", async () => {
    const base = fakeFs(true);
    const fs: SafeWorkspaceFsPort = {
      ...base,
      read: async () => ({
        stat: async () => ({ dev: 1, ino: 2, size: 1, mtimeMs: 1 }),
        read: async () => new Uint8Array(),
        close: async () => {
          throw new Error("read close failed");
        },
      }),
    };
    const h = await new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs,
    }).read(workspace.workspaceId, "x");
    const first = h.close();
    const second = h.close();
    await expect(first).rejects.toThrow("read close failed");
    await expect(second).rejects.toThrow("read close failed");
  });

  it("shares blocked watch dispose and preserves subscription primary failure", async () => {
    let release!: () => void;
    let subscriptions = 0;
    let roots = 0;
    const base = fakeFs(true);
    const fs: SafeWorkspaceFsPort = {
      ...base,
      openWorkspaceRoot: async () => ({
        stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }),
        close: async () => {
          roots += 1;
          throw new Error("root close failed");
        },
      }),
      watch: async () => ({
        [Symbol.asyncDispose]: async () => {
          subscriptions += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw new Error("subscription failed");
        },
      }),
    };
    const d = await new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs,
    }).watch(workspace.workspaceId, "x");
    const first = d[Symbol.asyncDispose]();
    const second = d[Symbol.asyncDispose]();
    let settled = false;
    void second.then(
      () => {
        settled = true;
        return undefined;
      },
      () => {
        settled = true;
      },
    );
    expect(settled).toBe(false);
    release();
    await expect(first).rejects.toThrow("subscription failed");
    await expect(second).rejects.toThrow("subscription failed");
    expect(subscriptions).toBe(1);
    expect(roots).toBe(1);
  });

  it("does not touch resolver or FS when authorization rejects", async () => {
    let roots = 0;
    const base = fakeFs(true);
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async () => {
        throw new Error("denied");
      },
      resolveCanonicalRoot: async () => {
        roots++;
        return "/workspace";
      },
      fs: {
        ...base,
        openWorkspaceRoot: async () => {
          roots++;
          return base.openWorkspaceRoot("/workspace");
        },
      },
    });
    await expect(policy.read(workspace.workspaceId, "x")).rejects.toThrow("denied");
    expect(roots).toBe(0);
  });

  it("preserves root stat failure when root close also fails", async () => {
    let closes = 0;
    const base = fakeFs(true);
    const fs = {
      ...base,
      openWorkspaceRoot: async () => ({
        stat: async () => {
          throw new Error("stat failed");
        },
        close: async () => {
          closes += 1;
          throw new Error("close failed");
        },
      }),
    };
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs,
    });
    await expect(policy.list(workspace.workspaceId, "x")).rejects.toThrow("stat failed");
    expect(closes).toBe(1);
  });

  it("closes the root when rename/copy target parsing fails", async () => {
    let closes = 0;
    const base = fakeFs(true);
    const fs = {
      ...base,
      openWorkspaceRoot: async () => ({
        stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }),
        close: async () => {
          closes++;
        },
      }),
    };
    const policy = new WorkspacePathPolicy({
      authorizeWorkspace: async () => workspace,
      resolveCanonicalRoot: async () => "/workspace",
      fs,
    });
    await expect(policy.rename(workspace.workspaceId, "a", "../bad")).rejects.toThrow();
    await expect(policy.copy(workspace.workspaceId, "a", "./bad")).rejects.toThrow();
    expect(closes).toBe(2);
  });
});
