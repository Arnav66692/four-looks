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
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
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

let quitWhy = null;
const quit = (why) => { quitWhy = why; process.stdout.write(`four looks quit: ${why}\n`); app.quit(); };
app.on("before-quit", () => { if (!quitWhy) process.stdout.write("four looks quit: Command+Q or the Dock\n"); });
ipcMain.handle("four-looks:quit", () => quit("quit button"));

ipcMain.handle("four-looks:resize", (e, fraction) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const f = Math.max(0.3, Math.min(0.95, Number(fraction) || 0.56));
  const { workArea } = screen.getPrimaryDisplay();
  const height = Math.round(workArea.height * f);
  win?.setBounds({ x: workArea.x, y: workArea.y + workArea.height - height, width: workArea.width, height });
});

// ---------- mouse mode: the head drives the real cursor through the native helper ----------
let mouse = null;
async function getMouse() {
  if (!mouse) { const { startMouse } = await import("./mouse.js"); mouse = startMouse({ log: (m) => process.stdout.write(`mouse: ${m}\n`) }); }
  return mouse;
}
const MOUSE_OPS = new Set(["ping", "screen", "pos", "move", "click", "down", "up", "scroll", "key"]);
ipcMain.handle("four-looks:mouse", async (_e, op, ...args) => {
  if (!MOUSE_OPS.has(op)) return { ok: false, error: "bad op" };
  try { return await (await getMouse())[op](...args); } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// The window is either the keyboard panel along the bottom, or a small dock.
ipcMain.handle("four-looks:mode", (e, mode, fraction = 0.56) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { workArea, bounds } = screen.getPrimaryDisplay();
  if (mode === "mouse") {
    const width = 430, height = 58;
    win?.setBounds({ x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + workArea.height - height - 12, width, height });
  } else {
    const height = Math.round(workArea.height * Math.max(0.3, Math.min(0.95, Number(fraction) || 0.56)));
    win?.setBounds({ x: workArea.x, y: workArea.y + workArea.height - height, width: workArea.width, height });
  }
  return { screen: { width: bounds.width, height: bounds.height } };
});

// What kind of control has the keyboard focus in the app in front. Used to pop the keyboard up in text boxes.
ipcMain.handle("four-looks:focus-role", () => new Promise((resolve) => {
  const script = 'tell application "System Events" to tell (first application process whose frontmost is true) to get role of (value of attribute "AXFocusedUIElement")';
  execFile("osascript", ["-e", script], { timeout: 1500 }, (err, out) => resolve(err ? "" : String(out).trim()));
}));

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
    // The window never takes focus, and Chromium slows down unfocused pages. Keep the camera loop at full speed.
    webPreferences: { preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)), backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  await win.loadURL(`http://localhost:${process.env.PORT}/?desktop=1${process.env.FL_STUDY ? `&study=${process.env.FL_STUDY}` : ""}`);
}

app.whenReady().then(() => {
  globalShortcut.register("Control+Alt+Q", () => quit("Control+Option+Q"));   // the window never takes focus, so quit is global
  return createWindow();
});
app.on("will-quit", () => { globalShortcut.unregisterAll(); mouse?.stop(); });
app.on("window-all-closed", () => quit("window closed"));
app.on("render-process-gone", (_e, _wc, d) => process.stdout.write(`four looks page crashed: ${d.reason} ${d.exitCode}\n`));
app.on("child-process-gone", (_e, d) => process.stdout.write(`four looks helper gone: ${d.type} ${d.reason}\n`));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => quit(`stopped from outside (${sig})`));
process.on("uncaughtException", (err) => { process.stdout.write(`four looks error: ${err.stack || err}\n`); });
app.on("quit", (_e, code) => process.stdout.write(`four looks exited with code ${code}\n`));
