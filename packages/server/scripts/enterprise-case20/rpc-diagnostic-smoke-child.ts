import {
  createCase20DaemonRuntimeObservationController,
  createCase20DaemonRpcDiagnosticCollector,
  installCase20DaemonRuntimeObservationHandler,
  installCase20DaemonRpcDiagnosticDrainHandler,
} from "./part-a-fixture.js";

const phases = [
  "frame.received",
  "session.call",
  "session.enter",
  "response.deliver.begin",
  "response.stringify.begin",
  "response.stringify.return",
  "response.send.begin",
  "response.send.return",
  "response.deliver.return",
] as const;

const collector = createCase20DaemonRpcDiagnosticCollector({ capacity: 300 });
for (let diagnosticIndex = 1; diagnosticIndex <= 257; diagnosticIndex += 1) {
  const requestId = `case20-rpc-${diagnosticIndex.toString(16).padStart(32, "0")}`;
  for (const [phaseIndex, phase] of phases.entries()) {
    collector.observe({
      phase,
      requestId,
      ...(phaseIndex < 3
        ? { requestType: "fetch_agents_request" }
        : { responseType: "fetch_agents_response" }),
      atUnixMs: diagnosticIndex * 100 + phaseIndex,
    });
  }
}

let closing = false;
const release = installCase20DaemonRpcDiagnosticDrainHandler({
  source: {
    on: (_event, listener) => process.on("message", listener),
    off: (_event, listener) => process.off("message", listener),
  },
  collector,
  isClosing: () => closing,
  send: (message) => {
    process.send?.(message);
  },
});
const runtimeObservation = createCase20DaemonRuntimeObservationController();
const releaseRuntimeObservation = installCase20DaemonRuntimeObservationHandler({
  source: {
    on: (_event, listener) => process.on("message", listener),
    off: (_event, listener) => process.off("message", listener),
  },
  controller: runtimeObservation,
  isClosing: () => closing,
  send: (message) => {
    process.send?.(message);
  },
});
const onShutdown = (value: unknown) => {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "shutdown")
    return;
  closing = true;
  release();
  releaseRuntimeObservation();
  runtimeObservation.finish();
  process.off("message", onShutdown);
  process.send?.({ type: "smoke_closed" });
  process.disconnect?.();
};
process.on("message", onShutdown);
process.send?.({ type: "smoke_ready" });
