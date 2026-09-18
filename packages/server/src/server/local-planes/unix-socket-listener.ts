import { chmod, lstat, unlink } from "node:fs/promises";
import type { Server } from "node:http";

import type { LocalPlaneSocketEndpoint } from "./plane-paths.js";

/** A socket file left by a crashed daemon is replaced; any other file at the path is an error. */
export async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket()) {
      throw new Error(`Refusing to replace ${socketPath}: it is not a socket`);
    }
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Listens on a plane endpoint; a Unix socket is made readable and writable by its owner only. */
export async function listenOnPlaneEndpoint(
  server: Server,
  endpoint: LocalPlaneSocketEndpoint,
): Promise<void> {
  const isUnix = endpoint.transport === "unix";
  if (isUnix) await removeStaleSocket(endpoint.path);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint.path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (isUnix) await chmod(endpoint.path, 0o600);
}

export async function closePlaneServer(
  server: Server,
  endpoint: LocalPlaneSocketEndpoint,
): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (endpoint.transport === "unix") {
    await unlink(endpoint.path).catch(() => undefined);
  }
}
