import { isCancel, password as passwordPrompt } from "@clack/prompts";
import { Command } from "commander";

import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";
import { withOutput } from "../../output/index.js";

export interface EnterpriseEnrollResult {
  readonly organizationId: string;
  readonly nodeId: string;
  readonly endpoint: string;
  readonly managementBaseUrl: string;
  readonly relationshipPath: string;
}

export interface EnterpriseEnrollDependencies {
  enroll(input: {
    readonly home?: string;
    readonly managementBaseUrl: string;
    readonly caCertificatePath: string;
    readonly endpoint: string;
    readonly relationshipPath?: string;
    readonly enrollmentToken: string;
  }): Promise<EnterpriseEnrollResult>;
  readonly readEnrollmentToken?: (path: string) => Promise<string>;
  readonly promptEnrollmentToken?: (message: string) => Promise<string | symbol>;
}

const resultSchema: OutputSchema<EnterpriseEnrollResult> = {
  idField: "nodeId",
  columns: [
    { header: "NODE", field: "nodeId" },
    { header: "ORGANIZATION", field: "organizationId" },
    { header: "ENDPOINT", field: "endpoint" },
  ],
  renderHuman: (result) => {
    const value = result.data as EnterpriseEnrollResult;
    return [
      `Managed node enrolled: ${value.nodeId}`,
      `Management plane: ${value.managementBaseUrl}`,
      `Daemon endpoint: ${value.endpoint}`,
      `Relationship: ${value.relationshipPath}`,
    ].join("\n");
  },
};

export async function runEnterpriseEnrollCommand(
  options: CommandOptions & EnterpriseEnrollDependencies,
  _command: Command,
): Promise<SingleResult<EnterpriseEnrollResult>> {
  const managementBaseUrl = requiredString(
    options.management,
    "ENTERPRISE_ENROLL_MANAGEMENT_REQUIRED",
    "--management is required",
  );
  const caCertificatePath = requiredString(
    options.ca,
    "ENTERPRISE_ENROLL_CA_REQUIRED",
    "--ca is required",
  );
  const endpoint = requiredString(
    options.endpoint,
    "ENTERPRISE_ENROLL_ENDPOINT_REQUIRED",
    "--endpoint is required",
  );
  const tokenFile = typeof options.tokenFile === "string" ? options.tokenFile : undefined;
  const supplied = tokenFile
    ? await options.readEnrollmentToken?.(tokenFile)
    : await (options.promptEnrollmentToken ?? ((message: string) => passwordPrompt({ message })))(
        "One-time enrollment token",
      );
  if (isCancel(supplied) || typeof supplied !== "string" || supplied.trim().length === 0) {
    throw {
      code: "ENTERPRISE_ENROLL_TOKEN_REQUIRED",
      message: "An enrollment token is required",
    };
  }
  const result = await options.enroll({
    ...(typeof options.home === "string" ? { home: options.home } : {}),
    managementBaseUrl,
    caCertificatePath,
    endpoint,
    ...(typeof options.relationship === "string" ? { relationshipPath: options.relationship } : {}),
    enrollmentToken: supplied.trim(),
  });
  return { type: "single", data: result, schema: resultSchema };
}

export function createEnterpriseEnrollCommand(dependencies: EnterpriseEnrollDependencies): Command {
  return new Command("enroll")
    .description("Enroll this stopped daemon with an enterprise management plane")
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .requiredOption("--management <https-url>", "Enterprise management plane HTTPS origin")
    .requiredOption("--ca <path>", "Management plane CA certificate")
    .requiredOption("--endpoint <url>", "Direct WebSocket endpoint advertised by this node")
    .option("--relationship <path>", "Managed node relationship file")
    .option("--token-file <path>", "Read the one-time enrollment token from a private file")
    .action(
      withOutput((...args) => {
        const [options, command] = args.slice(-2) as [CommandOptions, Command];
        return runEnterpriseEnrollCommand({ ...options, ...dependencies }, command);
      }),
    );
}

function requiredString(value: unknown, code: string, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw { code, message };
  return value.trim();
}
