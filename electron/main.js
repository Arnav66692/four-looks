// Desktop app: the keyboard floats at the bottom of the screen, never takes focus, and on send
// types the text into whatever app is in front, then presses Return.
// Launch from the Terminal app (npm run app) so macOS can ask for Camera and Accessibility.
import { app, BrowserWindow, globalShortcut, ipcMain, screen, session, systemPreferences } from "electron";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.PORT = process.env.PORT || "5174";
await import("../server.js");

const asAppleScript = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Deletes some characters, types text, and optionally presses Return, in the app in front.
function typeIntoFrontApp(text, pressReturn, deletes = 0) {
  const lines = [];
  if (deletes > 0) lines.push(`tell application "System Events" to repeat ${deletes} times\nkey code 51\nend repeat`);
  if (text) lines.push(`tell application "System Events" to keystroke ${asAppleScript(text)}`);
  if (pressReturn) lines.push('tell application "System Events" to key code 36');
  if (!lines.length) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    execFile("osascript", lines.flatMap((l) => ["-e", l]), (err, _out, stderr) => {
      resolve(err ? { ok: false, error: String(stderr || err.message).trim() } : { ok: true });
    });
  });
}

ipcMain.handle("four-looks:quit", () => app.quit());

ipcMain.handle("four-looks:type", (_e, text, pressReturn, deletes = 0) => {
  if (typeof text !== "string" || text.length > 5000) return { ok: false, error: "bad text" };
  const n = Math.max(0, Math.min(500, Math.floor(Number(deletes) || 0)));
  return typeIntoFrontApp(text, !!pressReturn, n);
});

async function createWindow() {
  if (process.platform === "darwin") {
    await systemPreferences.askForMediaAccess("camera");
    systemPreferences.isTrustedAccessibilityClient(true);   // shows the Accessibility prompt once
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission === "media"));

  const { workArea } = screen.getPrimaryDisplay();
  const height = Math.round(workArea.height * Number(process.env.FL_HEIGHT || 0.56));
  const win = new BrowserWindow({
    x: workArea.x, y: workArea.y + workArea.height - height, width: workArea.width, height,
    alwaysOnTop: true, focusable: false, frame: false, hasShadow: true, resizable: false,
    backgroundColor: "#ecebe7",
    webPreferences: { preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)) },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  await win.loadURL(`http://localhost:${process.env.PORT}/?desktop=1`);
}

app.whenReady().then(() => {
  globalShortcut.register("Control+Alt+Q", () => app.quit());   // the window never takes focus, so quit is global
  return createWindow();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
