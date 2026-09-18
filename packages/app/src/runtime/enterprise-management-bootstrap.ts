import { NodeIdSchema } from "@getpaseo/protocol/messages";
import type { HostConnection } from "@/types/host-connection";
import { z } from "zod";

const EnterpriseManagementBootstrapSchema = z
  .object({
    mode: z.literal("managed"),
    managementBaseUrl: z.string().url(),
    nodeId: NodeIdSchema,
    paseoServerId: z.string().min(1),
  })
  .strict();
export type EnterpriseManagementBootstrap = z.infer<typeof EnterpriseManagementBootstrapSchema>;

/** ADR-0030 HTTP discovery. Lives outside host-runtime so the directory-sync cycle cannot TDZ it. */
export async function fetchEnterpriseManagementBootstrap(
  connection: HostConnection,
  signal?: AbortSignal,
): Promise<EnterpriseManagementBootstrap | null> {
  if (connection.type !== "directTcp") return null;
  const bootstrapResponse = await fetch(
    new URL(
      "/api/enterprise/bootstrap",
      `${connection.useTls ? "https" : "http"}://${connection.endpoint}`,
    ),
    {
      method: "GET",
      signal,
      headers: { accept: "application/json" },
    },
  );
  if (bootstrapResponse.status === 404) return null;
  if (!bootstrapResponse.ok) throw new Error("Enterprise management discovery failed");
  return EnterpriseManagementBootstrapSchema.parse(await bootstrapResponse.json());
}
