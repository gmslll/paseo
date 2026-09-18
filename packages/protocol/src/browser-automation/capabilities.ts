import { z } from "zod";
import {
  BROWSER_AUTOMATION_COMMAND_NAMES,
  BrowserAutomationCommandNameSchema,
  type BrowserAutomationCommandName,
  type BrowserAutomationExecuteRequest,
} from "./rpc-schemas.js";

const KNOWN_BROWSER_AUTOMATION_COMMAND_NAMES = new Set<string>(BROWSER_AUTOMATION_COMMAND_NAMES);
const BrowserAutomationOpenCommandNameSchema = z.custom<BrowserAutomationCommandName>(
  (value) => typeof value === "string" && value.length > 0,
);

export const BrowserAutomationHostCapabilityWireSchema = z
  .object({
    supportedCommands: z.array(BrowserAutomationOpenCommandNameSchema),
    hostKind: z.string().min(1).default("browser host"),
    // COMPAT(enterpriseBrowserProfilesV1): added in v0.9.0, remove after 2027-03-09 once host floors support enterprise Profiles.
    enterpriseProfiles: z.object({ version: z.literal(1) }).optional(),
  })
  .passthrough();

export const BrowserAutomationHostCapabilitySchema = BrowserAutomationHostCapabilityWireSchema;

export type BrowserAutomationHostCapabilityWire = z.infer<
  typeof BrowserAutomationHostCapabilityWireSchema
>;
export type BrowserAutomationHostCapability = BrowserAutomationHostCapabilityWire;

export function normalizeBrowserAutomationHostCapability(
  input: unknown,
): BrowserAutomationHostCapability {
  const capability = BrowserAutomationHostCapabilityWireSchema.parse(input);
  const supportedCommands: BrowserAutomationCommandName[] = [];
  const seen = new Set<BrowserAutomationCommandName>();

  for (const command of capability.supportedCommands) {
    if (!isKnownBrowserAutomationCommandName(command) || seen.has(command)) {
      continue;
    }
    seen.add(command);
    supportedCommands.push(command);
  }

  BrowserAutomationCommandNameSchema.array().min(1).parse(supportedCommands);
  return { ...capability, supportedCommands };
}

export function projectBrowserAutomationRequestForHost(
  request: BrowserAutomationExecuteRequest,
  capability: BrowserAutomationHostCapability,
): BrowserAutomationExecuteRequest {
  if (capability.enterpriseProfiles?.version === 1) {
    return request;
  }
  const projected = { ...request };
  delete projected.enterpriseContext;
  return projected;
}

function isKnownBrowserAutomationCommandName(value: string): value is BrowserAutomationCommandName {
  return KNOWN_BROWSER_AUTOMATION_COMMAND_NAMES.has(value);
}
