// Measures what the desktop daemon transport actually pays to move one binary frame from the main
// process into the renderer's main world, under production window constraints (sandbox +
// contextIsolation). It exists to decide whether a dedicated MessagePort channel earns its
// complexity over plain structured-clone IPC — ADR-0038 follow-up.
//
// Three inbound paths, one shared return path:
//   base64  the pre-0.9 bridge: main encodes, the main world decodes with atob
//   bytes   today's bridge: a Uint8Array over ipcRenderer, structured clone end to end
//   port    MessageChannelMain; the port stays in preload because contextBridge cannot hand a
//           MessagePort to the main world, so preload forwards the bytes on by callback
//
// The return leg is always ipcRenderer.send, so the numbers isolate the inbound leg. That is the
// leg that matters: terminal output and agent streams flow daemon -> renderer, while the other
// direction carries keystrokes.

const { app, BrowserWindow, ipcMain, MessageChannelMain } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const MODES = ["base64", "bytes", "port"];
const FRAME_SIZES = [1024, 16 * 1024, 256 * 1024, 1024 * 1024];
// Percentiles need samples: the default pass is a smoke run, and BENCH_ROUNDS_SCALE buys the
// stability a decision should rest on (scale 5 puts the 1MiB case at 200 rounds).
const ROUNDS_SCALE = Math.max(1, Number(process.env.BENCH_ROUNDS_SCALE ?? 1));
const BASE_ROUNDS = { 1024: 300, 16384: 200, 262144: 100, 1048576: 40 };
const ROUNDS = Object.fromEntries(
  Object.entries(BASE_ROUNDS).map(([size, rounds]) => [size, rounds * ROUNDS_SCALE]),
);
const CONCURRENCIES = (process.env.BENCH_CONCURRENCY ?? "1,4")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const OUT_DIR = process.env.BENCH_OUT_DIR ?? "/tmp/paseo-transport-bench";
const READY_TIMEOUT_MS = 30_000;

// --- stats (same shape as scripts/benchmark-terminal-latency.ts) -------------

function round(n) {
  return Math.round(n * 100) / 100;
}

function summarize(values) {
  if (values.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, max: 0, avg: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    count: sorted.length,
    min: round(sorted[0]),
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    max: round(sorted[sorted.length - 1]),
    avg: round(values.reduce((a, b) => a + b, 0) / values.length),
  };
}

function withTimeout(promise, label, timeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// --- harness ----------------------------------------------------------------

const pending = new Map();
let nextId = 0;

function awaitAck(id) {
  return new Promise((resolve) => pending.set(id, resolve));
}

ipcMain.on("bench:ack", (_event, id) => {
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    resolve(performance.now());
  }
});

function makeFrame(size) {
  const bytes = Buffer.allocUnsafe(size);
  // Random-ish content so base64 cannot be optimized away by repetition.
  for (let index = 0; index < size; index += 4096) bytes[index] = index & 0xff;
  return bytes;
}

async function runCase(input) {
  const { win, port1, mode, size, concurrency } = input;
  const rounds = ROUNDS[size] ?? 50;
  const frame = makeFrame(size);
  const base64 = mode === "base64" ? frame.toString("base64") : null;
  const latencies = [];

  // One warm-up batch keeps first-frame allocation out of the percentiles.
  for (let iteration = 0; iteration < rounds + 1; iteration += 1) {
    const batch = [];
    const started = performance.now();
    for (let lane = 0; lane < concurrency; lane += 1) {
      const id = (nextId += 1);
      const settled = awaitAck(id);
      if (mode === "port") {
        port1.postMessage({ id, mode, data: new Uint8Array(frame) });
      } else {
        win.webContents.send("bench:frame", {
          id,
          mode,
          data: mode === "base64" ? base64 : new Uint8Array(frame),
        });
      }
      batch.push(settled);
    }
    const finishedAt = await withTimeout(
      Promise.all(batch).then((times) => Math.max(...times)),
      `${mode} ${size}B x${concurrency}`,
      READY_TIMEOUT_MS,
    );
    if (iteration > 0) latencies.push(finishedAt - started);
  }

  const stats = summarize(latencies);
  // Throughput counts every lane in the batch, since they share the one bridge.
  const bytesPerBatch = size * concurrency;
  const throughputMiBps = round(bytesPerBatch / 1024 / 1024 / (stats.avg / 1000));
  return { mode, size, concurrency, rounds, ...stats, throughputMiBps };
}

async function main() {
  const win = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 640,
    height: 480,
    webPreferences: {
      // The production window's constraints; without these the numbers mean nothing.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const ready = new Promise((resolve) => ipcMain.once("bench:ready", resolve));
  await win.loadFile(path.join(__dirname, "index.html"));
  await withTimeout(ready, "renderer ready", READY_TIMEOUT_MS);

  // Hand one end of a channel to preload. If a sandboxed preload cannot receive the port, this
  // rejects and the "port" rows are simply absent — itself a result worth recording.
  const { port1, port2 } = new MessageChannelMain();
  const portReady = new Promise((resolve) => ipcMain.once("bench:port-ready", resolve));
  win.webContents.postMessage("bench:port", null, [port2]);
  port1.start();
  let portUsable = true;
  try {
    await withTimeout(portReady, "preload port handshake", 5_000);
  } catch (error) {
    portUsable = false;
    console.log(`port path unavailable: ${error.message}`);
  }

  const results = [];
  for (const concurrency of CONCURRENCIES) {
    for (const size of FRAME_SIZES) {
      for (const mode of MODES) {
        if (mode === "port" && !portUsable) continue;
        results.push(await runCase({ win, port1, mode, size, concurrency }));
      }
    }
  }

  report(results, portUsable);
  win.destroy();
  app.exit(0);
}

function report(results, portUsable) {
  console.log("");
  console.log("mode    frame     conc  p50(ms)  p95(ms)  avg(ms)  MiB/s");
  for (const row of results) {
    const frameLabel =
      row.size >= 1024 * 1024 ? `${row.size / 1024 / 1024}MiB` : `${row.size / 1024}KiB`;
    console.log(
      `${row.mode.padEnd(7)} ${frameLabel.padEnd(9)} ${String(row.concurrency).padEnd(5)} ` +
        `${String(row.p50).padEnd(8)} ${String(row.p95).padEnd(8)} ${String(row.avg).padEnd(8)} ${row.throughputMiBps}`,
    );
  }

  // Compared against bytes, because that is what ships today.
  console.log("");
  for (const concurrency of CONCURRENCIES) {
    for (const size of FRAME_SIZES) {
      const bytes = results.find(
        (r) => r.mode === "bytes" && r.size === size && r.concurrency === concurrency,
      );
      const port = results.find(
        (r) => r.mode === "port" && r.size === size && r.concurrency === concurrency,
      );
      const b64 = results.find(
        (r) => r.mode === "base64" && r.size === size && r.concurrency === concurrency,
      );
      if (!bytes) continue;
      const label = `${size / 1024}KiB x${concurrency}`;
      const vsB64 = b64 ? `base64 ${round(b64.p95 / bytes.p95)}x` : "base64 n/a";
      const vsPort = port ? `port ${round(port.p95 / bytes.p95)}x` : "port n/a";
      console.log(`${label.padEnd(16)} p95 vs bytes: ${vsB64}, ${vsPort}`);
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `transport-bench-${Date.now()}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        roundsScale: ROUNDS_SCALE,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: `${process.platform}-${process.arch}`,
        portUsable,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${file}`);
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error);
    app.exit(1);
  }),
);
