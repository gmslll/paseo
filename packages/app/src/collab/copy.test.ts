import { describe, expect, test } from "vitest";
import { collabCopyFor, COLLAB_COPY, formatCollabCopy, type CollabCopy } from "./copy";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function flattenStrings(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") {
    return { [prefix]: value };
  }
  if (typeof value !== "object" || value === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      Object.entries(flattenStrings(child, prefix ? `${prefix}.${key}` : key)),
    ),
  );
}

function interpolationTokens(value: string): string[] {
  return [...value.matchAll(/\{\{[^}]+\}\}/g)].map((match) => match[0]).sort();
}

describe("collab copy", () => {
  test("every supported locale has the English keys", () => {
    const englishKeys = flattenKeys(COLLAB_COPY.en).sort();
    for (const [locale, copy] of Object.entries(COLLAB_COPY) as [string, CollabCopy][]) {
      expect({ locale, keys: flattenKeys(copy).sort() }).toEqual({
        locale,
        keys: englishKeys,
      });
    }
  });

  test("non-English locales keep the same interpolation placeholders", () => {
    const english = flattenStrings(COLLAB_COPY.en);
    const mismatches: string[] = [];
    for (const [locale, copy] of Object.entries(COLLAB_COPY) as [string, CollabCopy][]) {
      const strings = flattenStrings(copy);
      for (const [key, value] of Object.entries(english)) {
        const expected = interpolationTokens(value).join("|");
        const actual = interpolationTokens(strings[key] ?? "").join("|");
        if (expected !== actual) mismatches.push(`${locale}.${key}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("a Japanese system language gets the Japanese strings, not English", () => {
    expect(collabCopyFor("ja-JP").share.title).toBe(COLLAB_COPY.ja.share.title);
    expect(collabCopyFor("ja-JP").share.title).not.toBe(COLLAB_COPY.en.share.title);
  });

  test("an unknown language falls back to English", () => {
    expect(collabCopyFor("xx").share.add).toBe(COLLAB_COPY.en.share.add);
    expect(collabCopyFor(undefined).share.add).toBe(COLLAB_COPY.en.share.add);
  });

  test("queued copy names the person or the count, never a prompt", () => {
    expect(formatCollabCopy(COLLAB_COPY.en.queued.one, { name: "Ada" })).toBe("Ada is waiting");
    expect(formatCollabCopy(COLLAB_COPY.en.queued.many, { count: 3 })).toBe("3 messages waiting");
    expect(COLLAB_COPY.en.queued.one.includes("{{text}}")).toBe(false);
  });
});
