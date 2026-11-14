// Gives the keyboard page one safe way out: type text into the app in front.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fourLooksOut", {
  send: (text) => ipcRenderer.invoke("four-looks:type", text, true),
  type: (text) => ipcRenderer.invoke("four-looks:type", text, false),
  edit: (deletes, text) => ipcRenderer.invoke("four-looks:type", text, false, deletes),
  enter: () => ipcRenderer.invoke("four-looks:type", "", true),
  resize: (fraction) => ipcRenderer.invoke("four-looks:resize", fraction),
  mouse: (op, ...args) => ipcRenderer.invoke("four-looks:mouse", op, ...args),
  mode: (mode, fraction) => ipcRenderer.invoke("four-looks:mode", mode, fraction),
  focusRole: () => ipcRenderer.invoke("four-looks:focus-role"),
  agentRun: (goal) => ipcRenderer.invoke("four-looks:agent-run", goal),
  agentStop: () => ipcRenderer.invoke("four-looks:agent-stop"),
  agentAnswer: (id, yes) => ipcRenderer.invoke("four-looks:agent-answer", id, yes),
  onAgent: (fn) => ipcRenderer.on("four-looks:agent-event", (_e, payload) => fn(payload)),
  quit: () => ipcRenderer.invoke("four-looks:quit"),
});
