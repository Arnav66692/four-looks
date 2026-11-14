// Four Looks keyboard: head pointer + hold to press + a decoder that fixes near misses.
import { Decoder, LETTER_GROUPS } from "/src/decoder.js";
import { KeyTyper, LETTERS } from "/src/keytyper.js";
import { startFace } from "./face.js";
import { HeadPointer } from "./pointer.js";
import { CUES, CUE_ORDER, DEFAULT_CUE, fitCue } from "./blink.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DWELL = Number(params.get("dwell") || 1000);     // ms on a key to press it
const CUE_KEY = "fourlooks.cue.v1";                     // which face move presses, with its per-person line and length
const REACH_KEY = "fourlooks.reach.v1";
const REACH_STEPS = [1, 1.3, 1.6, 2];                  // extra amplification, so smaller head turns cover the keyboard
const SIGMA = 0.45;                                     // press spread, in key widths
const STICKY = 0.2;                                     // margin (in key sizes) a fresh hover keeps
const STICKY_LOCKED = 0.6;                              // margin once you have stayed on a key a moment
const LOCK_MS = 250;                                    // time to grow from STICKY to STICKY_LOCKED
const VOTE_MS = 350;                                    // a press goes to the key you were on most in this window
const MAGNET = 0.35;                                    // how far the drawn cursor leans toward the key centre
const PRIOR_POW = 0.5;                                  // how much likely next letters grow their hidden target
const STICKY_UNUSED = 0;                                    // hover stays until the pointer is this far into a new key
const CHIP_SLOTS = 4;
const POINTER_KEY = "fourlooks.pointer.v1";
const HOLD_KEY = "fourlooks.hold.v1";
const WORDS_KEY = "fourlooks.words.v1";
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
const FN = new Set(["⌫", "shift", "123", "abc", "speak", "clear"]);
const FACE = { "⌫": "⌫", shift: "⇧", send: "send", space: "space", "123": "123", abc: "ABC", speak: "speak", clear: "clear" };

const log = [];
const record = (type, extra = {}) => log.push({ t: Date.now(), type, ...extra });
window.fourLooks = { log };

let typer = null;
let layer = "abc";
let pointer = loadPointer();
let letterCenters = [];
let keyWidth = 60;
let lastFrame = null;
let usingCamera = false;
let calibrating = false;
let cueCfg = loadCue();
let holdToPress = loadHold();   // off by default: blink presses, holding only highlights
const watchers = new Set();

function loadPointer() {
  try { return HeadPointer.from(JSON.parse(localStorage.getItem(POINTER_KEY))); } catch { return new HeadPointer(); }
}
function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage off */ } }
function loadCue() { try { const o = JSON.parse(localStorage.getItem(CUE_KEY)); return o && CUES[o.cue] ? { ...DEFAULT_CUE, ...o } : { ...DEFAULT_CUE }; } catch { return { ...DEFAULT_CUE }; } }
function loadReach() { try { return Number(JSON.parse(localStorage.getItem(REACH_KEY))) || 1.3; } catch { return 1.3; } }
function loadHold() { try { return JSON.parse(localStorage.getItem(HOLD_KEY)) === true; } catch { return false; } }
function loadWords() { try { return JSON.parse(localStorage.getItem(WORDS_KEY)) || []; } catch { return []; } }
function prompt(text, big = false) { $("prompt").textContent = text; $("prompt").classList.toggle("big", big); }

// ---------- sound: one short soft tick per press ----------
let audio = null;
function tick() {
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.type = "sine"; o.frequency.setValueAtTime(1500, t); o.frequency.exponentialRampToValueAtTime(700, t + 0.03);
    g.gain.setValueAtTime(0.045, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.06);
  } catch { /* no audio */ }
}

// ---------- rendering: build once per layer, then update in place ----------
function buildKeys() {
  $("keys").innerHTML = LAYOUTS[layer].map((row) => `<div class="row">${row.map((k) => {
    const cls = ["key", FN.has(k) ? "fn" : "", k === "space" ? "space" : "", k === "send" ? "send" : ""].join(" ").trim();
    return `<div class="${cls}" data-key="${k === "\"" ? "&quot;" : k}"><span class="label"></span></div>`;
  }).join("")}</div>`).join("");
  $("chips").innerHTML = Array.from({ length: CHIP_SLOTS }, () => `<div data-key="pick" class="empty"></div>`).join("");
  updateKeys();
  measure();
}
function updateKeys() {
  const upper = typer && typer.shift !== "off";
  document.querySelectorAll("#keys [data-key]").forEach((el) => {
    const k = el.dataset.key;
    const isLetter = k.length === 1 && /[a-z]/.test(k);
    el.querySelector(".label").textContent = isLetter ? (upper ? k.toUpperCase() : k) : (FACE[k] ?? k);
    if (k === "shift") {
      el.classList.toggle("on", !!typer && typer.shift !== "off");
      el.querySelector(".label").textContent = typer?.shift === "lock" ? "⇪" : "⇧";
    }
  });
}
function measure() {
  letterCenters = [...document.querySelectorAll("#keys [data-key]")]
    .filter((el) => el.dataset.key.length === 1 && LETTERS.includes(el.dataset.key))
    .map((el) => { const r = el.getBoundingClientRect(); keyWidth = r.width; return { letter: el.dataset.key, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
}
function renderText() {
  if (!typer) return;
  $("done").textContent = typer.committed;
  $("typing").textContent = typer.pending.length ? typer.exactCase(typer.typedWord()) : "";
  $("textbox").classList.toggle("empty", !typer.text());
  $("textbox").scrollTop = $("textbox").scrollHeight;
  const sugg = typer.suggestions(3);
  [...$("chips").children].forEach((el, i) => {
    const w = sugg[i];
    el.classList.toggle("empty", !w);
    el.classList.toggle("lead", i === 0 && !!w);
    el.dataset.word = w || "";
    el.textContent = w || "";
  });
}

// ---------- pressing ----------
function letterProbs(x, y) {
  const s = SIGMA * keyWidth;
  const w = new Array(26).fill(0);
  for (const c of letterCenters) w[LETTERS.indexOf(c.letter)] = Math.exp(-((x - c.x) ** 2 + (y - c.y) ** 2) / (2 * s * s));
  const z = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((v) => v / z);
}

function press(el, x, y) {
  const k = el.dataset.key;
  if (k === "pick" && !el.dataset.word) return;
  tick();
  el.classList.add("pressed");
  setTimeout(() => el.classList.remove("pressed"), 120);
  if (k === "pick") {
    typer.pick(el.dataset.word);
    store(WORDS_KEY, [...typer.learned]);
    record("pick", { word: el.dataset.word });
  } else if (k.length === 1 && LETTERS.includes(k)) {
    typer.letter(letterProbs(x, y));
    record("letter", { key: k });
  } else if (k === "space") { typer.literal(" "); record("space"); }
  else if (k === "⌫") { typer.backspace(); record("backspace"); }
  else if (k === "shift") typer.toggleShift();
  else if (k === "123" || k === "abc") { layer = k === "123" ? "sym" : "abc"; buildKeys(); }
  else if (k === "speak") speak(false);
  else if (k === "send") send();
  else if (k === "clear") { typer.clear(); mirrored = ""; record("clear"); }
  else { typer.literal(k); record("symbol", { key: k }); }
  updateKeys();
  renderText();
  updatePrior();
  mirror();
}

function speak(andClear) {
  typer.commitWord();
  const text = typer.text().trim();
  if (!text) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  record(andClear ? "send" : "speak", { text, chars: text.length });
  if (andClear) typer.clear();
}
// ---------- live typing into the app in front (desktop app only) ----------
const out = window.fourLooksOut;
const LIVE = !!out?.edit;
let mirrored = "";
let queue = Promise.resolve();
function mirror() {
  if (!LIVE || !typer) return;
  const target = typer.committed;
  let k = 0;
  while (k < mirrored.length && k < target.length && mirrored[k] === target[k]) k++;
  const deletes = mirrored.length - k, add = target.slice(k);
  if (!deletes && !add) return;
  mirrored = target;
  queue = queue.then(() => out.edit(deletes, add)).then((r) => {
    if (r && !r.ok) prompt("Could not type into the app. Allow Accessibility for Terminal in System Settings.");
  });
}

function send() {
  if (LIVE) {
    typer.commitWord();
    mirror();
    const text = typer.text().trim();
    queue = queue.then(() => out.enter());
    record("send", { text, chars: text.length, to: "app" });
    prompt(text ? `Sent: ${text}` : "Pressed return.");
    typer.clear(); mirrored = "";
    updateKeys(); renderText();
    return;
  }
  if (!window.fourLooksOut?.send) { speak(true); return; }
  typer.commitWord();
  const text = typer.text().trim();
  if (!text) return;
  window.fourLooksOut.send(text).then((r) => {
    if (r?.ok) { record("send", { text, chars: text.length, to: "app" }); prompt(`Sent: ${text}`); typer.clear(); updateKeys(); renderText(); }
    else prompt("Could not type into the app. Allow Accessibility for Terminal in System Settings.");
  });
}

// ---------- hover: sticky keys, hidden target growth, press voting ----------
let hoverEl = null, hoverSince = 0, armed = true, cursorAt = null;
let letterPrior = null;                // probability of each next letter, from the word model
const history = [];                    // recent { t, el, x, y } for press voting

// Next-letter odds after the letters typed so far, weighted by how common each word is.
function updatePrior() {
  if (!typer || layer !== "abc") { letterPrior = null; return; }
  const prefix = typer.typedWord().toLowerCase().replace(/[^a-z]/g, "");
  const w = new Array(26).fill(0);
  const words = typer.dec.words, uni = typer.dec.uni;
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/'/g, "");
    if (word.length <= prefix.length || !word.startsWith(prefix)) continue;
    const k = LETTERS.indexOf(word[prefix.length]);
    if (k >= 0) w[k] += 10 ** uni[i];
  }
  const z = w.reduce((a, b) => a + b, 0);
  letterPrior = z > 0 ? w.map((v) => v / z) : null;
}

const letterEls = () => document.querySelectorAll("#keys [data-key]");
function keyAt(x, y) {
  const hit = document.elementFromPoint(x, y)?.closest("[data-key]") || null;
  const onLetters = !hit || (hit.dataset.key.length === 1 && LETTERS.includes(hit.dataset.key));
  if (!letterPrior || !onLetters || !letterCenters.length) return hit;
  // Letters near the pointer compete: closeness times how likely the word model says they are next.
  const s = 0.5 * keyWidth;
  let best = null, bestScore = 0;
  for (const c of letterCenters) {
    const d2 = (x - c.x) ** 2 + (y - c.y) ** 2;
    if (d2 > (1.1 * keyWidth) ** 2) continue;
    const score = Math.exp(-d2 / (2 * s * s)) * (letterPrior[LETTERS.indexOf(c.letter)] + 0.02) ** PRIOR_POW;
    if (score > bestScore) { bestScore = score; best = c.letter; }
  }
  if (!best) return hit;
  return [...letterEls()].find((el) => el.dataset.key === best) || hit;
}
function stillOn(el, x, y, t) {
  if (!el || !el.isConnected) return false;
  const grow = Math.min(1, (t - hoverSince) / LOCK_MS);
  const r = el.getBoundingClientRect(), m = (STICKY + (STICKY_LOCKED - STICKY) * grow) * Math.min(r.width, r.height);
  return x > r.left - m && x < r.right + m && y > r.top - m && y < r.bottom + m;
}
// The key you were on for most of the last VOTE_MS, and where you were on it.
function intended(t) {
  const tally = new Map();
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (t - h.t > VOTE_MS || !h.el) continue;
    const dt = (history[i + 1]?.t ?? t) - h.t;
    const e = tally.get(h.el) || { ms: 0, x: 0, y: 0, n: 0 };
    tally.set(h.el, { ms: e.ms + dt, x: e.x + h.x, y: e.y + h.y, n: e.n + 1 });
  }
  let best = null;
  for (const [el, e] of tally) if (!best || e.ms > best.ms) best = { el, ms: e.ms, x: e.x / e.n, y: e.y / e.n };
  return best;
}
function setFill(el, p) { if (el) el.style.setProperty("--p", String(p)); }
function movePointer(x, y, t) {
  cursorAt = [x, y];
  const el = stillOn(hoverEl, x, y, t) ? hoverEl : keyAt(x, y);
  history.push({ t, el, x, y });
  while (history.length && t - history[0].t > VOTE_MS * 2) history.shift();
  let dx = x, dy = y;
  if (el) { const r = el.getBoundingClientRect(); dx += MAGNET * (r.left + r.width / 2 - x); dy += MAGNET * (r.top + r.height / 2 - y); }
  const c = $("cursor");
  c.style.display = "block";
  c.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
  if (el !== hoverEl) {
    setFill(hoverEl, 0);
    hoverEl?.classList.remove("hover");
    hoverEl = el; hoverSince = t; armed = true;
    el?.classList.add("hover");
  }
  let progress = 0;
  if (hoverEl && armed && !calibrating && holdToPress) {
    progress = Math.min(1, (t - hoverSince) / DWELL);
    if (progress >= 1) {
      press(hoverEl, x, y);
      armed = hoverEl.dataset.key === "⌫";   // backspace repeats while you stay on it
      hoverSince = t;
      progress = 0;
    }
  }
  setFill(hoverEl, progress);
  $("ring").style.strokeDashoffset = String(100.5 * (1 - progress));
}

// ---------- camera ----------
let blinkSince = null, blinkFired = false;
function onFrame(f) {
  lastFrame = f;
  watchers.forEach((w) => w(f));
  $("status").textContent = f.face ? (pointer.ready ? "tracking" : "calibrate") : "no face";
  $("status").classList.toggle("live", f.face && pointer.ready);
  const c = f.face ? CUES[cueCfg.cue].score(f.scores) : 0;
  $("meter").style.setProperty("--c", String(c));
  $("meter").style.setProperty("--thr", String(cueCfg.thr));
  if (!f.face || calibrating || !pointer.ready) return;
  const closing = c > cueCfg.freeze;
  if (!closing) {
    const p = pointer.point(f.pose, f.t);
    if (p) movePointer(p[0] * innerWidth, p[1] * innerHeight, f.t);
  } else if (cursorAt) movePointer(cursorAt[0], cursorAt[1], f.t);
  if (c > cueCfg.thr) {
    if (blinkSince == null) blinkSince = f.t;
    const target = intended(blinkSince);       // where you were when the press move started
    if (!blinkFired && f.t - blinkSince > cueCfg.ms && target) {
      blinkFired = true;
      press(target.el, target.x, target.y);
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
  if (!lastFrame) { prompt("Start the camera first."); return; }
  calibrating = true;
  $("cursor").style.display = "none";
  const targets = [[0.5, 0.5], [0.08, 0.1], [0.92, 0.1], [0.92, 0.9], [0.08, 0.9], [0.5, 0.5]];
  const poses = [], used = [];
  for (const [tx, ty] of targets) {
    const dot = $("target");
    dot.style.display = "block";
    dot.style.left = `${tx * innerWidth}px`;
    dot.style.top = `${ty * innerHeight}px`;
    prompt("Turn your head a little toward the dot. Keep it comfortable.", true);
    await sleep(1100);
    const pose = await collectPose(700);
    if (pose) { poses.push(pose); used.push([tx, ty]); }
  }
  $("target").style.display = "none";
  if (poses.length >= 4) {
    pointer.fit(poses, used);
    store(POINTER_KEY, pointer);
    record("calibrate", { points: poses.length });
    calibrating = false;
    await calibrateCue();
    return;
  } else prompt("Lost your face during calibration. Add light and try again.");
  calibrating = false;
}

async function collectCue(ms) {
  const score = CUES[cueCfg.cue].score;
  const xs = [];
  const w = (f) => { if (f.face) xs.push({ t: f.t, c: score(f.scores) }); };
  watchers.add(w);
  await sleep(ms);
  watchers.delete(w);
  return xs;
}

async function calibrateCue() {
  if (!lastFrame) { prompt("Start the camera first."); return; }
  const cue = CUES[cueCfg.cue];
  calibrating = true;
  $("cursor").style.display = "none";
  prompt("Relax your face and look at the screen.", true);
  await sleep(900);
  const rest = (await collectCue(2000)).map((x) => x.c);
  const firm = [];
  for (let i = 1; i <= 3; i++) {
    prompt(`Get ready, ${i} of 3.`, true);
    await sleep(1100);
    prompt(cue.firm, true);
    firm.push(await collectCue(1600));
  }
  prompt(cue.normal, true);
  await sleep(600);
  const normal = await collectCue(4500);
  const fit = fitCue(cueCfg.cue, rest, firm, normal);
  record("cue-calibrate", fit);
  if (fit.ok) {
    cueCfg = fit;
    store(CUE_KEY, cueCfg);
    prompt(fit.clean ? `Set. A short ${cue.name} presses a key.` : `Set, but everyday movement comes close. Make a ${cue.name} a bit stronger to press.`);
  } else prompt(`Could not see a clear ${cue.name} (${fit.why}). Try another press move, or add light.`);
  calibrating = false;
}

$("start").addEventListener("click", async () => {
  $("start").disabled = true;
  prompt("Starting the camera.");
  try {
    await startFace($("video"), onFrame);
    usingCamera = true;
    prompt(pointer.ready ? (LIVE ? `Ready. Click into any text box, then ${CUES[cueCfg.cue].name} to press keys.` : `Ready. ${CUES[cueCfg.cue].name} to press keys.`) : "Press calibrate.");
  } catch (err) {
    prompt(`Camera failed: ${err.message}`);
    $("start").disabled = false;
  }
});
$("calibrate").addEventListener("click", () => { if (!calibrating) calibrate(); });
function showCue() { $("cuebtn").textContent = `press with: ${CUES[cueCfg.cue].name}`; }
$("cuebtn").addEventListener("click", () => {
  if (calibrating) return;
  const next = CUE_ORDER[(CUE_ORDER.indexOf(cueCfg.cue) + 1) % CUE_ORDER.length];
  cueCfg = { ...DEFAULT_CUE, cue: next };
  store(CUE_KEY, cueCfg);
  showCue();
  if (lastFrame) calibrateCue(); else prompt(`Press move is now ${CUES[next].name}. Start the camera to calibrate it.`);
});
showCue();
function showReach() { $("reach").textContent = `reach ${pointer.gain}x`; }
$("reach").addEventListener("click", () => {
  pointer.gain = REACH_STEPS[(REACH_STEPS.indexOf(pointer.gain) + 1) % REACH_STEPS.length] || 1;
  store(REACH_KEY, pointer.gain);
  showReach();
});
pointer.gain = REACH_STEPS.includes(loadReach()) ? loadReach() : 1.3;
showReach();
function showHold() { $("hold").textContent = holdToPress ? "hold to press: on" : "hold to press: off"; $("hold").classList.toggle("on", holdToPress); }
$("hold").addEventListener("click", () => { holdToPress = !holdToPress; store(HOLD_KEY, holdToPress); hoverSince = performance.now(); showHold(); });
showHold();
if (window.fourLooksOut?.quit) { $("quit").hidden = false; $("quit").addEventListener("click", () => window.fourLooksOut.quit()); }

// The mouse drives the same pointer when the camera is off, for testing and for mouse users.
addEventListener("mousemove", (e) => { if (!usingCamera || !pointer.ready) movePointer(e.clientX, e.clientY, performance.now()); });
addEventListener("mousedown", (e) => {
  if (e.target.closest("#bar")) return;
  const el = keyAt(e.clientX, e.clientY);
  if (el && typer) { e.preventDefault(); press(el, e.clientX, e.clientY); armed = false; hoverSince = performance.now(); }
});
setInterval(() => { if (cursorAt && (!usingCamera || !pointer.ready)) movePointer(cursorAt[0], cursorAt[1], performance.now()); }, 33);
addEventListener("resize", measure);

(async () => {
  buildKeys();
  try {
    const model = await (await fetch("/lm.json")).json();
    typer = new KeyTyper(new Decoder(model, { groups: LETTER_GROUPS }));
    typer.learn(loadWords());
    updatePrior();
    window.fourLooks.typer = typer;
    updateKeys(); renderText();
    prompt(usingCamera ? "" : "The mouse works now. Start the camera for head control.");
  } catch (err) {
    prompt(`Word model failed to load: ${err.message}`);
  }
})();
