import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runRuntimeInstallCommand } from "./install.js";
import { runRuntimeStatusCommand } from "./status.js";

export function createRuntimeCommand(): Command {
  const runtime = new Command("runtime").description(
    "Inspect and install company-pinned Agent runtimes",
  );

  addJsonAndDaemonHostOptions(
    runtime.command("status").description("Show pinned Agent runtimes on the daemon"),
  ).action(withOutput(runRuntimeStatusCommand));

  addJsonAndDaemonHostOptions(
    runtime
      .command("install")
      .description("Install a pinned Agent runtime on the daemon")
      .argument("<name>", "Runtime name, for example claude-code"),
  ).action(withOutput(runRuntimeInstallCommand));

  return runtime;
}
