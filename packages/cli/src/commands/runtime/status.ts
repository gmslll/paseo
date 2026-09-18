import type { Command } from "commander";
import type { ManagedRuntimeStatus } from "@getpaseo/protocol/managed-runtimes";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";

function statusColor(value: unknown): string | undefined {
  if (value === "installed") return "green";
  if (value === "failed" || value === "mismatch") return "red";
  return "yellow";
}

export const runtimeStatusSchema: OutputSchema<ManagedRuntimeStatus> = {
  idField: "runtimeName",
  columns: [
    { header: "RUNTIME", field: "runtimeName" },
    { header: "PINNED", field: (item) => item.pinnedVersion ?? "-" },
    { header: "ACTIVE", field: (item) => item.activeVersion ?? "-" },
    { header: "STATUS", field: "status", color: statusColor },
    { header: "COMMAND", field: (item) => item.commandPath ?? item.error ?? "" },
  ],
};

export async function runRuntimeStatusCommand(
  options: CommandOptions,
  _command: Command,
): Promise<ListResult<ManagedRuntimeStatus>> {
  const client = await connectToDaemon({ host: options.host });
  try {
    const payload = await client.getManagedRuntimeStatus();
    return { type: "list", data: payload.runtimes, schema: runtimeStatusSchema };
  } finally {
    await client.close();
  }
}
