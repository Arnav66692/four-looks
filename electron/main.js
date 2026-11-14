// Desktop app: the keyboard floats at the bottom of the screen, never takes focus, and on send
// types the text into whatever app is in front, then presses Return.
// Launch from the Terminal app (npm run app) so macOS can ask for Camera and Accessibility.
import { app, BrowserWindow, ipcMain, screen, session, systemPreferences } from "electron";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.PORT = process.env.PORT || "5174";
await import("../server.js");

const asAppleScript = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function typeIntoFrontApp(text, pressReturn) {
  const lines = [`tell application "System Events" to keystroke ${asAppleScript(text)}`];
  if (pressReturn) lines.push('tell application "System Events" to key code 36');
  return new Promise((resolve) => {
    execFile("osascript", lines.flatMap((l) => ["-e", l]), (err, _out, stderr) => {
      resolve(err ? { ok: false, error: String(stderr || err.message).trim() } : { ok: true });
    });
  });
}

ipcMain.handle("four-looks:type", (_e, text, pressReturn) => {
  if (typeof text !== "string" || text.length > 5000) return { ok: false, error: "bad text" };
  return typeIntoFrontApp(text, !!pressReturn);
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
    backgroundColor: "#f4f2ee",
    webPreferences: { preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)) },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  await win.loadURL(`http://localhost:${process.env.PORT}/?desktop=1`);
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
