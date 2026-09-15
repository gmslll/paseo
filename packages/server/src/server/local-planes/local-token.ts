import { randomBytes, timingSafeEqual } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

const LOCAL_TOKEN_BYTES = 32;

/** Writes a fresh token readable only by this user. Each daemon start replaces the previous one. */
export async function issueLocalToken(tokenPath: string): Promise<string> {
  const token = randomBytes(LOCAL_TOKEN_BYTES).toString("base64url");
  const tempPath = path.join(
    path.dirname(tokenPath),
    `.${path.basename(tokenPath)}.${process.pid}.tmp`,
  );
  const handle = await open(tempPath, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, tokenPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return token;
}

export function localTokenMatches(expected: string, presented: string | null | undefined): boolean {
  if (typeof presented !== "string") return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const presentedBytes = Buffer.from(presented, "utf8");
  return (
    expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes)
  );
}

/** Removes the token file only while it still holds this daemon's token. */
export async function removeLocalToken(tokenPath: string, token: string): Promise<void> {
  let current: string;
  try {
    current = await readFile(tokenPath, "utf8");
  } catch {
    return;
  }
  if (current.trim() === token) {
    await rm(tokenPath, { force: true });
  }
}
