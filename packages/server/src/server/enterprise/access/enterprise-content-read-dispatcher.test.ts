import { describe, expect, test } from "vitest";
import { createEnterpriseContentReadDispatcherRegistration } from "./enterprise-content-read-dispatcher.js";

describe("content registration lifecycle", () => {
  test("rejects missing factory deps", () => {
    expect(createEnterpriseContentReadDispatcherRegistration({})).toBeNull();
  });
});
