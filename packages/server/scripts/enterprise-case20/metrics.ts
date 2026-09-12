import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import os from "node:os";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import type { Case20ResourceSample } from "./model.js";

const executeFile = promisify(execFile);
const LOG_TAIL_BYTES = 2 * 1024 * 1024;

interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly rssKiB: number;
  readonly startTime: string;
  readonly command: string;
}

interface DaemonRuntimeMetrics {
  readonly sessions: { readonly activeConnections: number };
  readonly sockets: { readonly activeSockets: number; readonly pendingConnections: number };
  readonly eventLoopDelay: { readonly p99Ms: number } | null;
}

function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssKiB: Number(match[3]),
      startTime: match[4],
      command: match[5],
    });
  }
  return rows;
}

function processTree(rootPid: number, rows: readonly ProcessRow[]): readonly ProcessRow[] {
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.parentPid) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter(
    (row) =>
      selected.has(row.pid) &&
      (row.pid === rootPid || !/(?:^|\/)(?:ps|sysctl|lsof)(?:\s|$)/.test(row.command)),
  );
}

async function readProcessTree(rootPid: number): Promise<readonly ProcessRow[]> {
  const { stdout } = await executeFile("ps", ["-axo", "pid=,ppid=,rss=,lstart=,comm="]);
  const tree = processTree(rootPid, parseProcessRows(stdout));
  if (!tree.some((row) => row.pid === rootPid))
    throw new Error(`Case20 daemon pid ${rootPid} is not running`);
  return tree;
}

async function fileDescriptorCount(pid: number, required: boolean): Promise<number> {
  try {
    const { stdout } = await executeFile("lsof", [
      "-nP",
      "-a",
      "-p",
      String(pid),
      "-d",
      "0-999999",
      "-F",
      "f",
    ]);
    return stdout.split("\n").filter((line) => /^f\d+$/.test(line)).length;
  } catch (error) {
    if (required) throw error;
    return 0;
  }
}

async function countFileDescriptors(pids: readonly number[], requiredPid: number): Promise<number> {
  let count = 0;
  for (const pid of pids) {
    count += await fileDescriptorCount(pid, pid === requiredPid);
  }
  return count;
}

async function processSamples(tree: readonly ProcessRow[], requiredPid: number) {
  return await Promise.all(
    tree.map(async (row) => ({
      pid: row.pid,
      parentPid: row.parentPid,
      identity: createHash("sha256")
        .update(`${row.pid}\0${row.startTime}\0${row.command}`)
        .digest("hex"),
      rssMiB: row.rssKiB / 1024,
      fdCount: await fileDescriptorCount(row.pid, row.pid === requiredPid),
    })),
  );
}

function parseDarwinSwap(output: string): number {
  const match = /used\s*=\s*([0-9.]+)([KMG])/i.exec(output);
  if (!match) throw new Error("Unable to parse Darwin swap usage");
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === "G") return value * 1024;
  if (unit === "K") return value / 1024;
  return value;
}

async function readSwapMiB(): Promise<number> {
  if (process.platform === "darwin") {
    const { stdout } = await executeFile("sysctl", ["vm.swapusage"]);
    return parseDarwinSwap(stdout);
  }
  if (process.platform === "linux") {
    const contents = await readFile("/proc/meminfo", "utf8");
    const total = /^SwapTotal:\s+(\d+)\s+kB$/m.exec(contents);
    const free = /^SwapFree:\s+(\d+)\s+kB$/m.exec(contents);
    if (!total || !free) throw new Error("Unable to parse Linux swap usage");
    return (Number(total[1]) - Number(free[1])) / 1024;
  }
  throw new Error(`Case20 resource sampling does not support ${process.platform}`);
}

function isDaemonRuntimeMetrics(value: unknown): value is DaemonRuntimeMetrics {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.msg !== "ws_runtime_metrics") return false;
  const sessions = row.sessions as Record<string, unknown> | undefined;
  const sockets = row.sockets as Record<string, unknown> | undefined;
  const delay = row.eventLoopDelay as Record<string, unknown> | null | undefined;
  return (
    typeof sessions?.activeConnections === "number" &&
    typeof sockets?.activeSockets === "number" &&
    typeof sockets.pendingConnections === "number" &&
    (delay === null || typeof delay?.p99Ms === "number")
  );
}

async function readLogTail(filePath: string): Promise<string> {
  const info = await stat(filePath);
  const length = Math.min(info.size, LOG_TAIL_BYTES);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function readLatestDaemonRuntimeMetrics(
  filePath: string,
): Promise<DaemonRuntimeMetrics> {
  const lines = (await readLogTail(filePath)).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isDaemonRuntimeMetrics(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  throw new Error("No ws_runtime_metrics record is available in the daemon log");
}

export async function sampleDaemonResources(input: {
  readonly daemonPid: number;
  readonly daemonLogPath: string;
  readonly tSec: number;
}): Promise<Case20ResourceSample> {
  const [tree, swapMiB, metrics] = await Promise.all([
    readProcessTree(input.daemonPid),
    readSwapMiB(),
    readLatestDaemonRuntimeMetrics(input.daemonLogPath),
  ]);
  const fdCount = await countFileDescriptors(
    tree.map((row) => row.pid),
    input.daemonPid,
  );
  return {
    tSec: input.tSec,
    rssMiB: tree.reduce((sum, row) => sum + row.rssKiB, 0) / 1024,
    fdCount,
    swapMiB,
    eventLoopP99Ms: metrics.eventLoopDelay?.p99Ms ?? Number.POSITIVE_INFINITY,
    sessions: metrics.sessions.activeConnections,
    sockets: metrics.sockets.activeSockets + metrics.sockets.pendingConnections,
    processes: await processSamples(tree, input.daemonPid),
  };
}

export async function sampleRunnerProcessTree(input: {
  readonly tSec: number;
  readonly eventLoopP99Ms: number;
}): Promise<Case20ResourceSample> {
  const [tree, swapMiB] = await Promise.all([readProcessTree(process.pid), readSwapMiB()]);
  return {
    tSec: input.tSec,
    rssMiB: tree.reduce((sum, row) => sum + row.rssKiB, 0) / 1024,
    fdCount: await countFileDescriptors(
      tree.map((row) => row.pid),
      process.pid,
    ),
    swapMiB,
    eventLoopP99Ms: input.eventLoopP99Ms,
    sessions: null,
    sockets: null,
    processes: await processSamples(tree, process.pid),
  };
}

export async function countRunnerChildProcesses(): Promise<number> {
  const tree = await readProcessTree(process.pid);
  return tree.filter((row) => row.pid !== process.pid).length;
}

export async function runnerChildProcessIds(): Promise<ReadonlySet<number>> {
  const tree = await readProcessTree(process.pid);
  return new Set(tree.filter((row) => row.pid !== process.pid).map((row) => row.pid));
}

export async function assertCase20MetricsPreflight(): Promise<void> {
  if (os.platform() !== "darwin")
    throw new Error("Formal Case20 capacity evidence must run on the P0 Darwin node");
  await Promise.all([
    executeFile("ps", ["-p", String(process.pid)]),
    executeFile("lsof", ["-p", String(process.pid)]),
    executeFile("sysctl", ["vm.swapusage"]),
  ]);
}

export async function countDaemonAuditErrors(filePath: string): Promise<number> {
  let count = 0;
  const lines = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.level !== "number" || record.level < 50) continue;
      if (/audit/i.test(JSON.stringify(record))) count += 1;
    } catch {
      continue;
    }
  }
  return count;
}
