// Gives the keyboard page one safe way out: type text into the app in front.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fourLooksOut", {
  send: (text) => ipcRenderer.invoke("four-looks:type", text, true),
  type: (text) => ipcRenderer.invoke("four-looks:type", text, false),
  edit: (deletes, text) => ipcRenderer.invoke("four-looks:type", text, false, deletes),
  enter: () => ipcRenderer.invoke("four-looks:type", "", true),
  quit: () => ipcRenderer.invoke("four-looks:quit"),
});
