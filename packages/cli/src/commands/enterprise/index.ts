import { Command } from "commander";
import { createEnterpriseInitCommand, type EnterpriseInitDependencies } from "./init.js";

export function createEnterpriseCommand(dependencies?: EnterpriseInitDependencies): Command {
  return new Command("enterprise")
    .description("Manage local enterprise identity")
    .addCommand(createEnterpriseInitCommand(dependencies));
}
