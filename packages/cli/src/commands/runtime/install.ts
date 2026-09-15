import type { Command } from "commander";
import type { ManagedRuntimeStatus } from "@getpaseo/protocol/managed-runtimes";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, SingleResult } from "../../output/index.js";
import { runtimeStatusSchema } from "./status.js";

export async function runRuntimeInstallCommand(
  runtimeName: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<ManagedRuntimeStatus>> {
  const client = await connectToDaemon({ host: options.host });
  try {
    const payload = await client.installManagedRuntime(runtimeName);
    return { type: "single", data: payload.runtime, schema: runtimeStatusSchema };
  } finally {
    await client.close();
  }
}
