import { readFile, rm } from "node:fs/promises";
import { DaemonManifestSchema, type DaemonManifest } from "@getpaseo/protocol/local-planes";

import { writeFileAtomic } from "../atomic-file.js";

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Written after every listener is ready, so a reader never finds a plane that is not up yet. */
export async function writeDaemonManifest(
  manifestPath: string,
  manifest: DaemonManifest,
): Promise<void> {
  await writeFileAtomic(
    manifestPath,
    `${JSON.stringify(DaemonManifestSchema.parse(manifest), null, 2)}\n`,
  );
}

export async function readDaemonManifest(manifestPath: string): Promise<DaemonManifest | null> {
  let contents: string;
  try {
    contents = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  return DaemonManifestSchema.parse(JSON.parse(contents));
}

/** Removes the manifest only while it still describes this process, so a newer daemon keeps its own. */
export async function removeDaemonManifest(manifestPath: string, pid: number): Promise<void> {
  const current = await readDaemonManifest(manifestPath).catch(() => null);
  if (current?.pid === pid) {
    await rm(manifestPath, { force: true });
  }
}
