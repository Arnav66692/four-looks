// Desktop app: the keyboard floats at the bottom of the screen, never takes focus, and on send
// types the text into whatever app is in front, then presses Return.
// Launch from the Terminal app (npm run app) so macOS can ask for Camera and Accessibility.
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, nativeImage, screen, session, shell, systemPreferences } from "electron";
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
  } else if (mode === "grok") {                                  // a wider dock while Grok works, so its question fits
    const width = Math.min(820, workArea.width - 40), height = 58;
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

// =====================================================================================
// Grok agent: one typed sentence, and Grok does it on the computer. Simple requests (open a site,
// search, draft an email) take a fast path with no model call. Anything that sends, buys or deletes
// waits for the person's nod. Grok has its own cursor, drawn in a click-through window over the screen.
// =====================================================================================
const FAST_GROK = "grok-4.20-0309-non-reasoning";
const SHOT_WIDTH = 1280;               // screenshots are scaled down to this width: smaller uploads, faster answers
const CONFIRM_MS = 15000;              // no nod within this long counts as no
let agentBusy = null, overlay = null, confirmSeq = 0, visionModel = null;
const confirms = new Map();
const PRELOAD = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const osa = (script, timeout = 2000) => new Promise((resolve) => execFile("osascript", ["-e", script], { timeout }, (err, out) => resolve(err ? "" : String(out).trim())));

function showOverlay() {
  if (overlay && !overlay.isDestroyed()) { overlay.showInactive(); return overlay; }
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    ...bounds, transparent: true, frame: false, focusable: false, hasShadow: false, resizable: false, show: false,
    alwaysOnTop: true, skipTaskbar: true, webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadURL(`http://localhost:${process.env.PORT}/overlay.html`);
  overlay.showInactive();
  return overlay;
}
const tell = (win, payload) => {
  for (const w of [win, overlay]) if (w && !w.isDestroyed()) w.webContents.send("four-looks:agent-event", payload);
};

async function takeScreenshot() {
  const display = screen.getPrimaryDisplay();
  const width = Math.min(SHOT_WIDTH, display.bounds.width), height = Math.round((width * display.bounds.height) / display.bounds.width);
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("Screen Recording is off. Allow it for the Terminal app in System Settings, Privacy and Security, Screen Recording, then start Four Looks again");
  }
  const jpeg = source.thumbnail.resize({ width, height, quality: "good" }).toJPEG(60);
  const real = nativeImage.createFromBuffer(jpeg).getSize();          // the true pixel size of what the model will see
  return { base64: jpeg.toString("base64"), mime: "image/jpeg", width: real.width, height: real.height };
}

ipcMain.handle("four-looks:agent-answer", (_e, id, yes) => { const done = confirms.get(id); if (done) { confirms.delete(id); done(!!yes); } });
ipcMain.handle("four-looks:agent-stop", () => { agentBusy?.stop(); for (const done of confirms.values()) done(false); confirms.clear(); return { ok: true }; });
ipcMain.handle("four-looks:agent-run", async (e, goal) => {
  if (typeof goal !== "string" || !goal.trim() || goal.length > 600) return { ok: false, steps: 0, summary: "", stoppedWhy: "Type what you want done first" };
  if (agentBusy) return { ok: false, steps: 0, summary: "", stoppedWhy: "Grok is already working" };
  const win = BrowserWindow.fromWebContents(e.sender);
  const started = Date.now();
  try {
    const [{ createAgent }, xai, hands] = await Promise.all([import("./agent.js"), import("./xai.js"), getMouse()]);
    const key = process.env.XAI_API_KEY || "";
    const ask = async (messages, tools) => {
      if (!key) throw new Error("Grok is off. Add XAI_API_KEY to four-looks/.env and start again");
      // The fastest model measured (see electron/xai.js) is used straight away: asking the API for its
      // model list first cost a round trip on every start, and once timed out for 20 seconds.
      visionModel ||= process.env.XAI_VISION_MODEL || FAST_GROK;
      try { return (await xai.askGrok({ key, model: visionModel, messages, tools })).message; }
      catch (err) {
        if (visionModel !== FAST_GROK || !/HTTP 4(00|04)|model/i.test(String(err?.message))) throw err;
        visionModel = await xai.chooseVisionModel(key);          // that model is gone for this key: pick from the list once
        return (await xai.askGrok({ key, model: visionModel, messages, tools })).message;
      }
    };
    showOverlay();
    const agent = createAgent({
      mouse: hands, ask, screenshot: takeScreenshot,
      // The named controls of the app in front, from the accessibility tree: Grok reads these before any screenshot.
      elements: () => hands.axList({ max: 60, budgetMs: 400 }),
      screenSize: screen.getPrimaryDisplay().bounds,
      typeText: (text) => typeIntoFrontApp(text, false),
      openUrl: (url) => (/^https?:\/\//i.test(url) ? shell.openExternal(url) : Promise.reject(new Error("Only web links can be opened"))),
      openApp: (name) => new Promise((resolve, reject) => execFile("open", ["-a", String(name)], { timeout: 5000 }, (err) => (err ? reject(new Error(`Could not open ${name}`)) : resolve({ ok: true })))),
      frontApp: () => osa('tell application "System Events" to get name of first application process whose frontmost is true'),
      onStep: (info) => { tell(win, { type: "step", ...info }); },
      confirm: (text) => new Promise((resolve) => {
        const id = ++confirmSeq;
        const timer = setTimeout(() => { confirms.delete(id); resolve(false); }, CONFIRM_MS);
        confirms.set(id, (yes) => { clearTimeout(timer); resolve(yes); });
        tell(win, { type: "confirm", id, text: String(text).slice(0, 160) });
      }),
    });
    agentBusy = agent;
    const result = await agent.run(goal.trim());
    const out = { ...result, totalMs: result.totalMs ?? Date.now() - started };
    process.stdout.write(`grok: ${out.ok ? "done" : "stopped"} in ${out.totalMs} ms, ${out.modelCalls ?? "?"} model calls${out.routed ? ", fast path" : ""}${out.stoppedWhy ? `, ${out.stoppedWhy}` : ""}\n`);
    tell(win, { type: "end", text: out.ok ? "Done" : (out.stoppedWhy || "Stopped") });
    return out;
  } catch (err) {
    tell(win, { type: "end", text: "Stopped" });
    return { ok: false, steps: 0, summary: "", stoppedWhy: String(err?.message || err), totalMs: Date.now() - started };
  } finally {
    agentBusy = null;
    setTimeout(() => { if (!agentBusy && overlay && !overlay.isDestroyed()) overlay.hide(); }, 2600);
  }
});

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
  win.on("closed", () => { if (overlay && !overlay.isDestroyed()) overlay.destroy(); });
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
