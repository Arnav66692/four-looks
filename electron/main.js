// Desktop app: the keyboard floats at the bottom of the screen, never takes focus, and on send
// types the text into whatever app is in front, then presses Return.
// Launch from the Terminal app (npm run app) so macOS can ask for Camera and Accessibility.
import { app, BrowserWindow, globalShortcut, ipcMain, screen, session, systemPreferences } from "electron";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!app.requestSingleInstanceLock()) {
  process.stdout.write("four looks is already running. Quit that one first (Control+Option+Q).\n");
  app.exit(0);
}
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

const quit = (why) => { process.stdout.write(`four looks quit: ${why}\n`); app.quit(); };
ipcMain.handle("four-looks:quit", () => quit("quit button"));

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
  globalShortcut.register("Control+Alt+Q", () => quit("Control+Option+Q"));   // the window never takes focus, so quit is global
  return createWindow();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => quit("window closed"));
app.on("render-process-gone", (_e, _wc, d) => process.stdout.write(`four looks page crashed: ${d.reason} ${d.exitCode}\n`));
app.on("child-process-gone", (_e, d) => process.stdout.write(`four looks helper gone: ${d.type} ${d.reason}\n`));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => quit(`stopped from outside (${sig})`));
process.on("uncaughtException", (err) => { process.stdout.write(`four looks error: ${err.stack || err}\n`); });
app.on("quit", (_e, code) => process.stdout.write(`four looks exited with code ${code}\n`));
