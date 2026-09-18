import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { issueLocalToken, localTokenMatches, removeLocalToken } from "./local-token.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-local-token-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("local token", () => {
  test("writes a new owner-only token on every start", async () => {
    const tokenPath = path.join(directory, "local-token");

    const first = await issueLocalToken(tokenPath);
    const second = await issueLocalToken(tokenPath);

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(await readFile(tokenPath, "utf8")).toBe(`${second}\n`);
    if (process.platform !== "win32") {
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("matches only the exact token", () => {
    expect(localTokenMatches("token-value", "token-value")).toBe(true);
    expect(localTokenMatches("token-value", "token-valuE")).toBe(false);
    expect(localTokenMatches("token-value", "token")).toBe(false);
    expect(localTokenMatches("token-value", undefined)).toBe(false);
  });

  test("leaves a token another daemon wrote in place", async () => {
    const tokenPath = path.join(directory, "local-token");
    const mine = await issueLocalToken(tokenPath);
    await writeFile(tokenPath, "newer-daemon-token\n");

    await removeLocalToken(tokenPath, mine);
    expect(await readFile(tokenPath, "utf8")).toBe("newer-daemon-token\n");

    const current = await issueLocalToken(tokenPath);
    await removeLocalToken(tokenPath, current);
    await expect(stat(tokenPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
