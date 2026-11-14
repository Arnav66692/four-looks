// Gives the keyboard page one safe way out: type text into the app in front.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fourLooksOut", {
  send: (text) => ipcRenderer.invoke("four-looks:type", text, true),
  type: (text) => ipcRenderer.invoke("four-looks:type", text, false),
});
