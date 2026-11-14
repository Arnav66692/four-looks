// Four Looks keyboard: head pointer + hold to press + a decoder that fixes near misses.
import { Decoder, LETTER_GROUPS } from "/src/decoder.js";
import { KeyTyper, LETTERS } from "/src/keytyper.js";
import { startFace } from "./face.js";
import { HeadPointer } from "./pointer.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DWELL = Number(params.get("dwell") || 650);      // ms on a key to press it
const BLINK_MS = 420;                                   // held blink presses the key under the cursor
const SIGMA = 0.45;                                     // press spread, in key widths
const MODEL_KEY = "fourlooks.pointer.v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAYOUTS = {
  abc: [
    [..."qwertyuiop", "⌫"],
    [..."asdfghjkl", "'", "send"],
    ["shift", ..."zxcvbnm", ",", ".", "?"],
    ["123", "space", "speak", "clear"],
  ],
  sym: [
    [..."1234567890", "⌫"],
    ["-", "/", ":", ";", "(", ")", "$", "&", "@", "\"", "send"],
    ["#", "%", "*", "+", "=", "_", "!", ",", ".", "?"],
    ["abc", "space", "speak", "clear"],
  ],
};
const WIDE = new Set(["⌫", "send", "shift", "123", "abc", "speak", "clear"]);

const log = [];
const record = (type, extra = {}) => log.push({ t: Date.now(), type, ...extra });
window.fourLooks = { log };

let typer = null;
let layer = "abc";
let pointer = loadPointer();
let letterCenters = [];     // [{ letter, x, y }] in px
let keyWidth = 60;
let lastFrame = null;
let usingCamera = false;
let calibrating = false;
const watchers = new Set();

function loadPointer() {
  try { return HeadPointer.from(JSON.parse(localStorage.getItem(MODEL_KEY))); } catch { return new HeadPointer(); }
}
function savePointer() { try { localStorage.setItem(MODEL_KEY, JSON.stringify(pointer)); } catch { /* storage off */ } }
function prompt(text, big = false) { $("prompt").textContent = text; $("prompt").classList.toggle("big", big); }

// ---------- rendering ----------
function label(k) {
  if (k.length === 1 && /[a-z]/.test(k)) return typer && typer.shift !== "off" ? k.toUpperCase() : k;
  return k;
}
function renderKeys() {
  $("keys").innerHTML = LAYOUTS[layer].map((row) => `<div class="row">${row.map((k) => {
    const cls = ["key", WIDE.has(k) ? "wide" : "", k === "space" ? "space" : "", k === "send" ? "send" : "",
      k === "shift" && typer?.shift !== "off" ? "on" : ""].join(" ");
    return `<div class="${cls}" data-key="${k === "\"" ? "&quot;" : k}">${k === "space" ? "" : label(k)}${k === "shift" && typer?.shift === "lock" ? " lock" : ""}</div>`;
  }).join("")}</div>`).join("");
  measure();
}
function measure() {
  letterCenters = [...document.querySelectorAll("#keys [data-key]")]
    .filter((el) => el.dataset.key.length === 1 && LETTERS.includes(el.dataset.key))
    .map((el) => { const r = el.getBoundingClientRect(); keyWidth = r.width; return { letter: el.dataset.key, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
}
function renderText() {
  if (!typer) return;
  $("done").textContent = typer.committed;
  $("typing").textContent = typer.typedWord() ? typer.caseLike(typer.typedWord()) : "";
  $("textbox").scrollTop = $("textbox").scrollHeight;
  const sugg = typer.suggestions(3);
  $("chips").innerHTML = sugg.map((w) => `<div data-key="pick" data-word="${w.replace(/"/g, "&quot;")}">${w}</div>`).join("");
}

// ---------- pressing ----------
// Probabilities over a-z from where the press landed: a Gaussian around each letter key.
function letterProbs(x, y) {
  const s = SIGMA * keyWidth;
  const w = new Array(26).fill(0);
  for (const c of letterCenters) w[LETTERS.indexOf(c.letter)] = Math.exp(-((x - c.x) ** 2 + (y - c.y) ** 2) / (2 * s * s));
  const z = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((v) => v / z);
}

function press(el, x, y) {
  const k = el.dataset.key;
  el.classList.add("pressed");
  setTimeout(() => el.classList.remove("pressed"), 180);
  if (k === "pick") { typer.pick(el.dataset.word); record("pick", { word: el.dataset.word }); }
  else if (k.length === 1 && LETTERS.includes(k)) {
    const probs = layer === "abc" ? letterProbs(x, y) : null;
    if (probs) typer.letter(probs);
    record("letter", { key: k, sure: probs ? +Math.max(...probs).toFixed(3) : 1 });
    const wasShift = typer.shift;
    if (wasShift !== "lock") renderKeys();
  }
  else if (k === "space") { typer.literal(" "); record("space"); }
  else if (k === "⌫") { typer.backspace(); record("backspace"); }
  else if (k === "shift") { typer.toggleShift(); renderKeys(); }
  else if (k === "123" || k === "abc") { layer = k === "123" ? "sym" : "abc"; renderKeys(); }
  else if (k === "speak") speak(false);
  else if (k === "send") send();
  else if (k === "clear") { typer.clear(); record("clear"); renderKeys(); }
  else { typer.literal(k); record("symbol", { key: k }); if (/[.!?]/.test(k)) renderKeys(); }
  renderText();
}

function speak(andClear) {
  typer.commitWord();
  const text = typer.text().trim();
  if (!text) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  record(andClear ? "send" : "speak", { text, chars: text.length });
  if (andClear) { typer.clear(); renderKeys(); }
  renderText();
}
function send() {
  if (window.fourLooksOut?.send) {           // set by the desktop app: types into the app in front
    typer.commitWord();
    const text = typer.text().trim();
    if (!text) return;
    window.fourLooksOut.send(text).then((r) => {
      if (r?.ok) { record("send", { text, chars: text.length, to: "app" }); prompt(`sent: ${text}`); typer.clear(); renderKeys(); renderText(); }
      else prompt(`could not type into the app: ${r?.error || "unknown"}. Allow Accessibility for this app in System Settings.`);
    });
    return;
  }
  speak(true);
}

// ---------- dwell ----------
let hoverEl = null, hoverSince = 0, armed = true, cursorAt = null;
function keyAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest("[data-key]") : null;
}
function movePointer(x, y, t) {
  cursorAt = [x, y];
  const c = $("cursor");
  c.style.display = "block";
  c.style.transform = `translate(${x}px, ${y}px)`;
  const el = keyAt(x, y);
  if (el !== hoverEl) {
    hoverEl?.classList.remove("hover");
    hoverEl = el; hoverSince = t; armed = true;
    el?.classList.add("hover");
  }
  let progress = 0;
  if (hoverEl && armed && !calibrating) {
    progress = Math.min(1, (t - hoverSince) / DWELL);
    if (progress >= 1) {
      press(hoverEl, x, y);
      armed = hoverEl.dataset.key === "⌫";   // backspace repeats while you stay on it
      hoverSince = t;
      progress = 0;
    }
  }
  $("ring").style.strokeDashoffset = String(113.1 * (1 - progress));
}

// ---------- camera ----------
let blinkSince = null, blinkFired = false;
function onFrame(f) {
  lastFrame = f;
  watchers.forEach((w) => w(f));
  $("status").textContent = f.face ? (pointer.ready ? "tracking" : "tracking, press calibrate") : "no face";
  if (!f.face || calibrating || !pointer.ready) return;
  const p = pointer.point(f.pose, f.t);
  if (p) movePointer(p[0] * innerWidth, p[1] * innerHeight, f.t);
  const blink = (f.scores.eyeBlinkLeft || 0) > 0.55 && (f.scores.eyeBlinkRight || 0) > 0.55;
  if (blink) {
    if (blinkSince == null) blinkSince = f.t;
    if (!blinkFired && f.t - blinkSince > BLINK_MS && hoverEl && cursorAt) {
      blinkFired = true;
      press(hoverEl, cursorAt[0], cursorAt[1]);
      hoverSince = f.t; armed = false;
    }
  } else { blinkSince = null; blinkFired = false; }
}

async function collectPose(ms) {
  const xs = [];
  const w = (f) => { if (f.pose) xs.push(f.pose); };
  watchers.add(w);
  await sleep(ms);
  watchers.delete(w);
  if (!xs.length) return null;
  return [xs.reduce((a, v) => a + v[0], 0) / xs.length, xs.reduce((a, v) => a + v[1], 0) / xs.length];
}

async function calibrate() {
  if (!lastFrame) { prompt("start the camera first"); return; }
  calibrating = true;
  $("cursor").style.display = "none";
  const targets = [[0.5, 0.5], [0.08, 0.1], [0.92, 0.1], [0.92, 0.9], [0.08, 0.9], [0.5, 0.5]];
  const poses = [], used = [];
  for (const [tx, ty] of targets) {
    const dot = $("target");
    dot.style.display = "block";
    dot.style.left = `${tx * innerWidth}px`;
    dot.style.top = `${ty * innerHeight}px`;
    prompt("point your nose at the dot", true);
    await sleep(1100);
    const pose = await collectPose(700);
    if (pose) { poses.push(pose); used.push([tx, ty]); }
  }
  $("target").style.display = "none";
  if (poses.length >= 4) {
    pointer.fit(poses, used);
    savePointer();
    record("calibrate", { points: poses.length });
    prompt("ready. hold on a key to press it, or hold a blink");
  } else prompt("calibration lost your face, try again with more light");
  calibrating = false;
}

$("start").addEventListener("click", async () => {
  $("start").disabled = true;
  prompt("starting camera");
  try {
    await startFace($("video"), onFrame);
    usingCamera = true;
    prompt(pointer.ready ? "ready. hold on a key to press it, or hold a blink" : "press calibrate");
  } catch (err) {
    prompt(`camera failed: ${err.message}`);
    $("start").disabled = false;
  }
});
$("calibrate").addEventListener("click", () => { if (!calibrating) calibrate(); });

// Mouse drives the same pointer when the camera is off, so the keyboard works for testing and for mouse users.
addEventListener("mousemove", (e) => { if (!usingCamera || !pointer.ready) movePointer(e.clientX, e.clientY, performance.now()); });
addEventListener("mousedown", (e) => {
  if (e.target.closest("#bar")) return;
  const el = keyAt(e.clientX, e.clientY);
  if (el && typer) { e.preventDefault(); press(el, e.clientX, e.clientY); armed = false; }
});
setInterval(() => { if (cursorAt && (!usingCamera || !pointer.ready)) movePointer(cursorAt[0], cursorAt[1], performance.now()); }, 50);
addEventListener("resize", measure);

(async () => {
  renderKeys();
  try {
    const model = await (await fetch("/lm.json")).json();
    typer = new KeyTyper(new Decoder(model, { groups: LETTER_GROUPS }));
    window.fourLooks.typer = typer;
    renderKeys(); renderText();
    prompt("mouse works now. start the camera for head control");
  } catch (err) {
    prompt(`word model failed to load: ${err.message}`);
  }
})();
