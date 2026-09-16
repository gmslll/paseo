// Mirrors the production preload's constraints: sandboxed, context-isolated, and loading nothing
// but "electron". It forwards each inbound frame to the main world and never decodes it here,
// because the shipped bridge decodes in the main world too.

const { contextBridge, ipcRenderer } = require("electron");

let frameHandler = null;

ipcRenderer.on("bench:frame", (_event, payload) => {
  frameHandler?.(payload);
});

// contextBridge cannot hand a MessagePort to the main world, so the port is consumed here and the
// bytes cross by callback. That extra hop is precisely what the dedicated channel has to justify.
ipcRenderer.on("bench:port", (event) => {
  const port = event.ports[0];
  if (!port) return;
  port.start();
  port.addEventListener("message", (message) => {
    frameHandler?.(message.data);
  });
  ipcRenderer.send("bench:port-ready");
});

contextBridge.exposeInMainWorld("bench", {
  onFrame: (handler) => {
    frameHandler = handler;
  },
  ack: (id) => ipcRenderer.send("bench:ack", id),
  ready: () => ipcRenderer.send("bench:ready"),
});
