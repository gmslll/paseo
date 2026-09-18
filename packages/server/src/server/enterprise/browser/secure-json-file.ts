import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export async function readSecureJsonFile(filePath: string): Promise<unknown | null> {
  await ensureSecureParentDirectory(filePath);
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Secure registry path is not a regular file: ${filePath}`);
  }
  await fs.chmod(filePath, PRIVATE_FILE_MODE);
  const contents = await fs.readFile(filePath, "utf8");
  return JSON.parse(contents) as unknown;
}

export async function writeSecureJsonFile(filePath: string, value: unknown): Promise<void> {
  const directory = await ensureSecureParentDirectory(filePath);
  try {
    const existing = await fs.lstat(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`Secure registry path is not a regular file: ${filePath}`);
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    await fs.chmod(tempPath, PRIVATE_FILE_MODE);
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function ensureSecureParentDirectory(filePath: string): Promise<string> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Secure registry parent is not a directory: ${directory}`);
  }
  await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
  return directory;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
