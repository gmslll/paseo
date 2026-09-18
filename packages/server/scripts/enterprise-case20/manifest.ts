import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";

export interface Case20CliArguments {
  readonly manifestPath: string;
}

export function parseCase20CliArguments(argv: readonly string[]): Case20CliArguments {
  let manifestPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") {
      manifestPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown Case20 argument: ${argument}`);
  }
  if (!manifestPath) throw new Error("Case20 requires --manifest <private-json-path>");
  return { manifestPath: path.resolve(manifestPath) };
}

export async function readPrivateManifest<T>(filePath: string, schema: ZodType<T>): Promise<T> {
  const file = await lstat(filePath);
  if (!file.isFile() || file.isSymbolicLink())
    throw new Error("Case20 manifest must be a regular file");
  if (process.platform !== "win32" && (file.mode & 0o077) !== 0) {
    throw new Error("Case20 manifest permissions must be 0600 or stricter");
  }
  return schema.parse(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}
