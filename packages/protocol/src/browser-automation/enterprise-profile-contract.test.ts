import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  BrowserAutomationEnterpriseContextSchema,
  BrowserAutomationExecuteRequestSchema,
  BrowserAutomationExecuteResponseSchema,
  BrowserAutomationTabInfoSchema,
} from "./rpc-schemas.js";
import {
  BrowserAutomationHostCapabilitySchema,
  BrowserAutomationHostCapabilityWireSchema,
  normalizeBrowserAutomationHostCapability,
  projectBrowserAutomationRequestForHost,
} from "./capabilities.js";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const ENTERPRISE_CONTEXT = {
  browserProfileId: "brp_5555555555555555",
  nodeId: "nod_2222222222222222",
  leaseId: "lea_11111111-1111-1111-1111-111111111111",
  fencingToken: 7,
  leaseRevision: "revision-7",
} as const;

const LegacyBrowserAutomationHostCapabilitySchema = z
  .object({
    supportedCommands: z.array(z.string().min(1)),
    hostKind: z.string().min(1).default("browser host"),
  })
  .passthrough();

const LegacyBrowserAutomationExecuteRequestSchema = z
  .object({
    type: z.literal("browser.automation.execute.request"),
    requestId: z.string().min(1),
    agentId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    command: z.unknown(),
  })
  .strict();

const LegacyBrowserAutomationTabInfoSchema = z.object({
  browserId: z.string().uuid(),
  workspaceId: z.string().min(1).optional(),
  url: z.string(),
  title: z.string(),
  isActive: z.boolean().default(false),
  isLoading: z.boolean().default(false),
  canGoBack: z.boolean().optional(),
  canGoForward: z.boolean().optional(),
});

const LegacyBrowserAutomationExecuteResponseSchema = z.object({
  type: z.literal("browser.automation.execute.response"),
  payload: z.discriminatedUnion("ok", [
    z.object({ requestId: z.string().min(1), ok: z.literal(true), result: z.unknown() }),
    z.object({ requestId: z.string().min(1), ok: z.literal(false), error: z.unknown() }),
  ]),
});

describe("enterprise browser host compatibility", () => {
  test("a new host declares enterprise Profile support and parses the full envelope", () => {
    const capability = normalizeBrowserAutomationHostCapability({
      supportedCommands: ["future_command", "snapshot", "snapshot"],
      enterpriseProfiles: { version: 1 },
    });
    const request = BrowserAutomationExecuteRequestSchema.parse({
      type: "browser.automation.execute.request",
      requestId: "req-new-host",
      workspaceId: "wks_1",
      command: { command: "snapshot", args: { browserId: BROWSER_ID } },
      enterpriseContext: ENTERPRISE_CONTEXT,
    });

    expect(projectBrowserAutomationRequestForHost(request, capability)).toEqual(request);
    expect(BrowserAutomationEnterpriseContextSchema.parse(ENTERPRISE_CONTEXT)).toEqual(
      ENTERPRISE_CONTEXT,
    );
    expect(capability.supportedCommands).toEqual(["snapshot"]);
    expect(capability.hostKind).toBe("browser host");
  });

  test("an old strict host never receives the enterprise envelope", () => {
    const capability = normalizeBrowserAutomationHostCapability({
      supportedCommands: ["snapshot"],
    });
    const request = BrowserAutomationExecuteRequestSchema.parse({
      type: "browser.automation.execute.request",
      requestId: "req-old-host",
      workspaceId: "wks_1",
      command: { command: "snapshot", args: { browserId: BROWSER_ID } },
      enterpriseContext: ENTERPRISE_CONTEXT,
    });
    const projected = projectBrowserAutomationRequestForHost(request, capability);

    expect(projected).not.toHaveProperty("enterpriseContext");
    expect(LegacyBrowserAutomationExecuteRequestSchema.parse(projected)).toEqual(projected);
  });

  test("new schemas parse old host messages without enterprise fields", () => {
    expect(
      BrowserAutomationHostCapabilityWireSchema.parse({ supportedCommands: ["list_tabs"] }),
    ).not.toHaveProperty("enterpriseProfiles");
    expect(
      BrowserAutomationHostCapabilitySchema.parse({
        supportedCommands: ["future_command", "list_tabs"],
      }).supportedCommands,
    ).toEqual(["future_command", "list_tabs"]);
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-legacy",
        command: { command: "list_tabs", args: {} },
      }),
    ).not.toHaveProperty("enterpriseContext");
    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-legacy",
          ok: true,
          result: { command: "list_tabs", tabs: [] },
        },
      }).payload,
    ).not.toHaveProperty("enterpriseContext");
    expect(
      BrowserAutomationTabInfoSchema.parse({
        browserId: BROWSER_ID,
        url: "https://example.com",
        title: "Example",
      }),
    ).not.toHaveProperty("enterpriseContext");
  });

  test("frozen old schemas ignore new response, tab, and capability fields", () => {
    const response = {
      type: "browser.automation.execute.response",
      payload: {
        requestId: "req-new",
        ok: true,
        result: { command: "list_tabs", tabs: [] },
        enterpriseContext: ENTERPRISE_CONTEXT,
      },
    } as const;
    const tab = {
      browserId: BROWSER_ID,
      url: "https://example.com",
      title: "Example",
      enterpriseContext: ENTERPRISE_CONTEXT,
    } as const;

    expect(LegacyBrowserAutomationExecuteResponseSchema.parse(response).payload).not.toHaveProperty(
      "enterpriseContext",
    );
    expect(LegacyBrowserAutomationTabInfoSchema.parse(tab)).not.toHaveProperty("enterpriseContext");
    expect(
      LegacyBrowserAutomationHostCapabilitySchema.parse({
        supportedCommands: ["snapshot"],
        enterpriseProfiles: { version: 1 },
      }),
    ).toMatchObject({ enterpriseProfiles: { version: 1 } });
  });

  test("Agent-visible command args reject Profile and lease authority", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.safeParse({
        type: "browser.automation.execute.request",
        requestId: "req-untrusted",
        command: {
          command: "snapshot",
          args: { browserId: BROWSER_ID, browserProfileId: ENTERPRISE_CONTEXT.browserProfileId },
        },
      }).success,
    ).toBe(false);
  });
});
