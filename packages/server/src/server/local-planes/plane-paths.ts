import { createHash } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DARWIN_UNIX_SOCKET_PATH_MAX_BYTES,
  LOCAL_PLANE_MANIFEST_FILE,
  LOCAL_PLANE_NAMES,
  LOCAL_PLANE_RUN_DIRECTORY,
  LOCAL_PLANE_TOKEN_FILE,
  localPlanePipePath,
  localPlaneSocketFileName,
  type LocalPlaneName,
} from "@getpaseo/protocol/local-planes";

// Where the local planes live (ADR-0038). The manifest and token always stay in $PASEO_HOME/run;
// only the sockets move when their paths would not fit in sockaddr_un.

export interface LocalPlaneSocketEndpoint {
  readonly transport: "unix" | "pipe";
  readonly path: string;
}

export interface LocalPlanePaths {
  readonly runDirectory: string;
  readonly manifestPath: string;
  readonly tokenPath: string;
  /** Directory holding the Unix sockets, or null when the planes are Windows named pipes. */
  readonly socketDirectory: string | null;
  readonly endpoints: Readonly<Record<LocalPlaneName, LocalPlaneSocketEndpoint>>;
}

export class LocalPlaneDirectoryError extends Error {
  constructor(
    public readonly directory: string,
    reason: string,
  ) {
    super(`Local plane directory ${directory} ${reason}`);
    this.name = "LocalPlaneDirectoryError";
  }
}

export function localPlaneHomeDigest(paseoHome: string): string {
  return createHash("sha256").update(path.resolve(paseoHome)).digest("hex").slice(0, 12);
}

function mapPlanes(
  endpoint: (plane: LocalPlaneName) => LocalPlaneSocketEndpoint,
): Record<LocalPlaneName, LocalPlaneSocketEndpoint> {
  return Object.fromEntries(LOCAL_PLANE_NAMES.map((plane) => [plane, endpoint(plane)])) as Record<
    LocalPlaneName,
    LocalPlaneSocketEndpoint
  >;
}

// macOS allows 104 bytes including the terminator and Linux 108, so the stricter limit applies to
// every POSIX platform.
function socketsFit(directory: string): boolean {
  return LOCAL_PLANE_NAMES.every(
    (plane) =>
      Buffer.byteLength(path.join(directory, localPlaneSocketFileName(plane))) <
      DARWIN_UNIX_SOCKET_PATH_MAX_BYTES,
  );
}

export function resolveLocalPlanePaths(input: {
  paseoHome: string;
  platform?: NodeJS.Platform;
  tmpdir?: string;
}): LocalPlanePaths {
  const home = path.resolve(input.paseoHome);
  const runDirectory = path.join(home, LOCAL_PLANE_RUN_DIRECTORY);
  const files = {
    runDirectory,
    manifestPath: path.join(runDirectory, LOCAL_PLANE_MANIFEST_FILE),
    tokenPath: path.join(runDirectory, LOCAL_PLANE_TOKEN_FILE),
  };
  const digest = localPlaneHomeDigest(home);
  if ((input.platform ?? process.platform) === "win32") {
    return {
      ...files,
      socketDirectory: null,
      endpoints: mapPlanes((plane) => ({
        transport: "pipe",
        path: localPlanePipePath({ homeDigest: digest, plane }),
      })),
    };
  }
  const socketDirectory = socketsFit(runDirectory)
    ? runDirectory
    : path.join(input.tmpdir ?? os.tmpdir(), `paseo-${digest}`);
  return {
    ...files,
    socketDirectory,
    endpoints: mapPlanes((plane) => ({
      transport: "unix",
      path: path.join(socketDirectory, localPlaneSocketFileName(plane)),
    })),
  };
}

/**
 * Creates the directory with mode 0700 and refuses one another user owns or a symlink, because a
 * process that controls the socket directory could stand in for the daemon.
 */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new LocalPlaneDirectoryError(directory, "is not a directory");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new LocalPlaneDirectoryError(directory, "is owned by another user");
  }
  if ((info.mode & 0o077) !== 0) {
    await chmod(directory, 0o700);
  }
}
