import { Command } from "commander";
import { isCancel, password as passwordPrompt } from "@clack/prompts";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";
import { withOutput } from "../../output/index.js";

export interface EnterpriseInitResult {
  readonly principalId: string;
  readonly credentialId: string;
  readonly token?: string;
  readonly alreadyProvisioned: boolean;
}

export interface EnterpriseInitDependencies {
  provision(input: {
    readonly home?: string;
    readonly principalId: string;
    readonly displayName?: string;
    readonly organizationId?: string;
    readonly bootstrapPassword: string;
  }): Promise<EnterpriseInitResult>;
  readonly promptPassword?: (message: string) => Promise<string | symbol>;
}

const resultSchema: OutputSchema<EnterpriseInitResult> = {
  idField: "principalId",
  columns: [
    { header: "PRINCIPAL", field: "principalId" },
    { header: "CREDENTIAL", field: "credentialId" },
    { header: "STATUS", field: "alreadyProvisioned", color: () => "green" },
  ],
  renderHuman: (result) => {
    const value = result.data as EnterpriseInitResult;
    return value.token
      ? `Enterprise administrator created\nPAT (store securely; shown once): ${value.token}`
      : `Enterprise administrator already provisioned (${value.credentialId}); no token was returned.`;
  },
};

export async function runEnterpriseInitCommand(
  options: CommandOptions & { provision?: EnterpriseInitDependencies["provision"] },
  _command: Command,
): Promise<SingleResult<EnterpriseInitResult>> {
  if (typeof options.provision !== "function") {
    throw {
      code: "ENTERPRISE_INIT_UNAVAILABLE",
      message: "Enterprise initialization is unavailable",
    };
  }
  const principalId = typeof options.principalId === "string" ? options.principalId : "";
  const displayName = typeof options.displayName === "string" ? options.displayName : undefined;
  const organizationId =
    typeof options.organizationId === "string" ? options.organizationId : undefined;
  const home = typeof options.home === "string" ? options.home : undefined;
  if (!principalId)
    throw { code: "ENTERPRISE_INIT_PRINCIPAL_REQUIRED", message: "--principal is required" };
  const prompt =
    (options as { promptPassword?: EnterpriseInitDependencies["promptPassword"] }).promptPassword ??
    ((message: string) => passwordPrompt({ message }));
  const supplied = await prompt("Local daemon password");
  if (isCancel(supplied) || typeof supplied !== "string" || supplied.length === 0)
    throw { code: "ENTERPRISE_INIT_PASSWORD_REQUIRED", message: "A daemon password is required" };
  const result = await options.provision({
    ...(home ? { home } : {}),
    principalId,
    ...(displayName ? { displayName } : {}),
    ...(organizationId ? { organizationId } : {}),
    bootstrapPassword: supplied,
  });
  return { type: "single", data: result, schema: resultSchema };
}

export function createEnterpriseInitCommand(
  dependencies: EnterpriseInitDependencies = {
    provision: async () => {
      throw {
        code: "ENTERPRISE_INIT_UNAVAILABLE",
        message: "Enterprise initialization is unavailable",
      };
    },
  },
): Command {
  return new Command("init")
    .description("Provision the first local enterprise administrator")
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .requiredOption("--principal <id>", "Human principal ID (usr_...)")
    .option("--display-name <name>", "Administrator display name")
    .option("--organization <id>", "Organization ID (defaults to daemon config)")
    .action(
      withOutput((...args) => {
        const [options, command] = args.slice(-2) as [CommandOptions, Command];
        return runEnterpriseInitCommand({ ...options, ...dependencies }, command);
      }),
    );
}
