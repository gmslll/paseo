import { describe, expect, test } from "vitest";

import { digestPassword, PASSWORD_BCRYPT_COST, verifyPassword } from "./security.js";

describe("enterprise password digests", () => {
  test("uses bcrypt cost 12 and never embeds the plaintext password", async () => {
    const password = "employee-password-2026";
    const digest = await digestPassword(password);

    expect(PASSWORD_BCRYPT_COST).toBe(12);
    expect(digest).toMatch(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
    expect(digest).not.toContain(password);
    await expect(verifyPassword(password, digest)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password-2026", digest)).resolves.toBe(false);
  });
});
