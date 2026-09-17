import {
  MACHINE_RPC_DEFAULT_TTL_MS,
  MachineRpcClientRequestSchema,
  MachineRpcIdSchema,
  MachineRpcResultSchema,
  machineRpcMethodPolicy,
  type MachineRpcClientRequest,
  type MachineRpcResult,
} from "@getpaseo/protocol/enterprise-collaboration";

/**
 * Sends a machine RPC and waits for the node's answer (ADR-0035).
 *
 * The plane attests; this client only writes the unsigned request and correlates the result by
 * `rpcId`. Unknown methods never leave the device: the table is the allowlist, and appending one
 * the plane would refuse would still occupy a stream offset.
 */

export interface MachineRpcTransport {
  append(request: MachineRpcClientRequest): Promise<void>;
  subscribe(rpcId: string, onResult: (result: MachineRpcResult) => void): () => void;
}

export interface MachineRpcCallInput {
  readonly method: string;
  readonly nodeId: string;
  readonly containerId: string;
  readonly clientId: string;
  readonly payload: unknown;
}

export class MachineRpcClient {
  private readonly transport: MachineRpcTransport;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly timeoutMs: number;

  constructor(options: {
    transport: MachineRpcTransport;
    now?: () => number;
    randomId?: () => string;
    timeoutMs?: number;
  }) {
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? createRpcId;
    this.timeoutMs = options.timeoutMs ?? MACHINE_RPC_DEFAULT_TTL_MS;
  }

  async call(input: MachineRpcCallInput): Promise<MachineRpcResult> {
    if (!machineRpcMethodPolicy(input.method)) {
      throw new Error(`Unknown machine RPC method: ${input.method}`);
    }
    const rpcId = this.randomId();
    const request = MachineRpcClientRequestSchema.parse({
      kind: "request",
      rpcVersion: 1,
      rpcId,
      method: input.method,
      nodeId: input.nodeId,
      containerId: input.containerId,
      clientId: input.clientId,
      sentAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.timeoutMs).toISOString(),
      payload: input.payload,
    });

    let unsubscribe = (): void => {};
    const timeoutError: MachineRpcResult = {
      kind: "error",
      rpcVersion: 1,
      rpcId,
      nodeId: input.nodeId,
      code: "timeout",
      message: "Machine RPC timed out",
    };
    const response = new Promise<MachineRpcResult>((resolve) => {
      unsubscribe = this.transport.subscribe(rpcId, (incoming) => {
        const parsed = MachineRpcResultSchema.safeParse(incoming);
        if (!parsed.success || parsed.data.kind === "receipt") return;
        resolve(parsed.data);
      });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<MachineRpcResult>((resolve) => {
      timer = setTimeout(() => {
        resolve(timeoutError);
      }, this.timeoutMs);
    });
    const sent = this.transport.append(request).then(
      () => response,
      (error: unknown): MachineRpcResult => ({
        kind: "error",
        rpcVersion: 1,
        rpcId,
        nodeId: input.nodeId,
        code: "transport",
        message: error instanceof Error ? error.message : "Machine RPC transport failed",
      }),
    );

    try {
      return await Promise.race([sent, timeout]);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }
}

function createRpcId(): string {
  return MachineRpcIdSchema.parse(`rpc_${globalThis.crypto.randomUUID()}`);
}
