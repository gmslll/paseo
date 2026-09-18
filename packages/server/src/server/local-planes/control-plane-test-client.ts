import { request } from "node:http";
import type { Socket } from "node:net";

// Test client for `paseo-ndjson/1` control plane Sessions over a Unix socket.

export interface ControlPlaneUpgrade {
  status: number;
  socket: Socket | null;
  /** Bytes the daemon sent with its 101 response; they never arrive as later socket data. */
  head: Buffer;
}

export interface SessionLine {
  type?: string;
  message?: { type?: string; payload?: Record<string, unknown> };
}

export function upgradeControlPlane(
  socketPath: string,
  headers: Record<string, string>,
): Promise<ControlPlaneUpgrade> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method: "POST", path: "/v1/session", headers });
    outgoing.on("upgrade", (_response, socket, head) => resolve({ status: 101, socket, head }));
    outgoing.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, socket: null, head: Buffer.alloc(0) });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/** Resolves with the first line the predicate accepts, starting with bytes that came with the 101. */
export function nextSessionLine(
  upgrade: ControlPlaneUpgrade,
  accept: (line: SessionLine) => boolean,
): Promise<SessionLine> {
  const socket = upgrade.socket;
  if (!socket) throw new Error(`control plane refused the upgrade with ${upgrade.status}`);
  return new Promise((resolve, reject) => {
    let buffered = upgrade.head.toString("utf8");
    upgrade.head = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error("timed out waiting for a control plane line"));
    }, 10_000);
    const settle = (line: SessionLine): true => {
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(line);
      return true;
    };
    const drain = (): boolean => {
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = JSON.parse(buffered.slice(0, newline)) as SessionLine;
        buffered = buffered.slice(newline + 1);
        if (accept(line)) return settle(line);
        newline = buffered.indexOf("\n");
      }
      return false;
    };
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      drain();
    };
    if (!drain()) socket.on("data", onData);
  });
}

export function writeSessionLine(upgrade: ControlPlaneUpgrade, value: unknown): void {
  if (!upgrade.socket) throw new Error("control plane Session is not open");
  upgrade.socket.write(`${JSON.stringify(value)}\n`);
}
