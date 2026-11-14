// Four Looks keyboard: head pointer + hold to press + a decoder that fixes near misses.
import { Decoder, LETTER_GROUPS } from "/src/decoder.js";
import { KeyTyper, LETTERS } from "/src/keytyper.js";
import { startFace } from "./face.js";
import { HeadPointer } from "./pointer.js";
import { CUES, CUE_ORDER, DEFAULT_CUE, fitCue } from "./blink.js";
import { createAdmin } from "./admin.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DWELL = Number(params.get("dwell") || 1000);     // ms on a key to press it
const CUE_KEY = "fourlooks.cue.v1";                     // which face move presses, with its per-person line and length
const REACH_KEY = "fourlooks.reach.v3";
const TUNE_KEY = "fourlooks.tune.v1";                   // sensitivity and smoothing found by the tuning run
const REACH_STEPS = [0.7, 1, 1.3, 1.6, 2];                  // extra amplification, so smaller head turns cover the keyboard
const SIGMA = 0.45;                                     // press spread, in key widths
const STICKY = 0.2;                                     // margin (in key sizes) a fresh hover keeps
const STICKY_LOCKED = 0.45;                             // margin once you have stayed on a key a moment
const CORE = 0.2;                                       // the middle of a key: this far in from each edge
const LOCK_MS = 250;                                    // time to grow from STICKY to STICKY_LOCKED
const VOTE_MS = 350;                                    // a press goes to the key you were on most in this window
const MAGNET = 0.35;                                    // how far the drawn cursor leans toward the key centre
const PRIOR_POW = 0.5;                                  // how much likely next letters grow their hidden target
const NOD_AMP = Number(params.get("nod") || 0.3);        // a nod dips at least this much of your calibrated up-down range
const NOD_START = 0.07;                                 // a dip this big starts the nod clock
const NOD_MS = 550;                                     // and the head is back within this long
const IDLE_MS = 6000;                                   // gaps longer than this do not count as typing time
const CHIP_SLOTS = 5;
const CHIP_ORDER = [3, 1, 0, 2, 4];     // slot -> guess rank: the best guess sits in the middle of the row
const POINTER_KEY = "fourlooks.pointer.v4";      // v4: follow-the-dots fit, with a line-up check
const HOLD_KEY = "fourlooks.hold.v1";
const WORDS_KEY = "fourlooks.words.v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAYOUTS = {
  abc: [
    [..."qwertyuiop", "⌫"],
    [..."asdfghjkl", "'", "send"],
    ["shift", ..."zxcvbnm", ",", ".", "?"],
    ["123", "layout", "menu", "space", "undo", "fix", "speak"],
  ],
  // Every letter on its own key, arranged for a head and not for hands. The ten most used letters
  // (e t a o i n s h r d) fill the middle row with the busiest in the centre, the next eight sit below
  // (nodding down is easier than up), and the eight rarest sit above.
  head: [
    ["⌫", ..."qjvpbkxz", "'", "send"],
    [..."rsiaetonhd"],
    ["shift", ..."gwulcmfy", ",", ".", "?"],
    ["123", "layout", "menu", "space", "undo", "fix", "speak"],
  ],
  // Boxes: built around where the head rests, not where hands rest. Share of English letters by key:
  // def 19%, mno 17%, ghi 15%, pqrs 14%, tuv 13%, abc 13%, jkl 5%, wxyz 5%. The busiest key is in the
  // middle. Turning is easier than nodding, so the next two sit left and right. Space, the most pressed
  // key of all, is straight below. The rare keys take the top corners.
  big: [
    ["⌫", "g:jkl", "g:pqrs", "g:wxyz", "send"],
    ["undo", "g:mno", "g:def", "g:ghi", "speak"],
    ["123", "g:tuv", "space", "g:abc", "menu"],
    ["shift", ",", ".", "?", "'", "fix", "layout"],
  ],
  sym: [
    [..."1234567890", "⌫"],
    ["-", "/", ":", ";", "(", ")", "$", "&", "@", "\"", "send"],
    ["#", "%", "*", "+", "=", "_", "!", ",", ".", "?"],
    ["abc", "menu", "space", "undo", "fix", "speak"],
  ],
};
const FN = new Set(["⌫", "shift", "123", "abc", "speak", "undo", "fix", "menu", "layout"]);
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  "⌫": svg('<path d="M9 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-6-6z"/><path d="M12.5 10l4 4m0-4l-4 4"/>'),
  shift: svg('<path d="M12 4l8 9h-5v7H9v-7H4z"/>'),
  caps: svg('<path d="M12 3l8 9h-5v5H9v-5H4z"/><path d="M9 21h6"/>'),
  menu: svg('<circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/>'),
};
const FACE = { "⌫": "⌫", shift: "⇧", send: "send", space: "space", "123": "123", abc: "ABC", speak: "speak", undo: "undo", fix: "fix", menu: "⋯" };

const log = [];
const record = (type, extra = {}) => log.push({ t: Date.now(), type, ...extra });
const SESSION = `${new Date().toISOString().replace(/[:.]/g, "-")}`;
let logSent = 0;
setInterval(() => {                        // every session is saved on this computer, so real use can be studied
  if (logSent >= log.length) return;
  const batch = log.slice(logSent);
  logSent = log.length;
  fetch("/api/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: SESSION, events: batch }) }).catch(() => { logSent -= batch.length; });
}, 3000);
window.fourLooks = { log };

let typer = null;
const LAYOUT_KEY = "fourlooks.layout.v2";
const LETTER_LAYOUTS = ["head", "abc", "big"];        // head-arranged letters, QWERTY, letter-group boxes
const LAYOUT_NAME = { head: "head", abc: "qwerty", big: "boxes" };
let letters = (() => { try { const v = JSON.parse(localStorage.getItem(LAYOUT_KEY)); return LETTER_LAYOUTS.includes(v) ? v : "head"; } catch { return "head"; } })();
let layer = letters;
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
let promptTimer = 0;
function prompt(text, big = false) {      // a quiet line that fades once read
  const el = $("prompt");
  el.textContent = text; el.classList.toggle("big", big); el.classList.add("show");
  clearTimeout(promptTimer);
  if (!big) promptTimer = setTimeout(() => el.classList.remove("show"), 5000);
}

// ---------- sound: one short soft tick per press ----------
let audio = null;
function tick() {
  try {
    audio = audio || new AudioContext();
    const t = audio.currentTime;
    // The body of the key bottoming out: a short low thump.
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.06);
    g.gain.setValueAtTime(0.22, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.1);
    // The click of the cap: a few milliseconds of filtered noise.
    const n = audio.createBufferSource(), buf = audio.createBuffer(1, 600, audio.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const f = audio.createBiquadFilter(), ng = audio.createGain();
    f.type = "bandpass"; f.frequency.value = 2400; f.Q.value = 0.9; ng.gain.value = 0.11;
    n.buffer = buf; n.connect(f).connect(ng).connect(audio.destination); n.start(t);
  } catch { /* no audio */ }
}

// ---------- rendering: build once per layer, then update in place ----------
function buildKeys() {
  $("keys").innerHTML = LAYOUTS[layer].map((row) => `<div class="row">${row.map((k) => {
    const cls = ["key", FN.has(k) ? "fn" : "", k === "space" ? "space" : "", k === "send" ? "send" : "", k.startsWith("g:") ? "group" : ""].join(" ").trim();
    return `<div class="${cls}" data-key="${k === "\"" ? "&quot;" : k}"><span class="cap"><span class="label"></span></span></div>`;
  }).join("")}</div>`).join("");
  const chips = $("chips");
  if (!chips.children.length) chips.innerHTML = Array.from({ length: CHIP_SLOTS }, () => `<div data-key="pick" class="empty"></div>`).join("");
  document.body.classList.toggle("centred", layer === "big");
  updateKeys();
  measure();
}
function updateKeys() {
  const upper = typer && typer.shift !== "off";
  document.querySelectorAll("#keys .key[data-key]").forEach((el) => {
    const k = el.dataset.key;
    const isLetter = k.length === 1 && /[a-z]/.test(k);
    const label = el.querySelector(".label");
    if (k === "shift") {
      el.classList.toggle("on", upper);
      label.innerHTML = typer?.shift === "lock" ? ICONS.caps : ICONS.shift;
    } else if (ICONS[k]) { if (!label.firstChild) label.innerHTML = ICONS[k]; }
    else if (k.startsWith("g:")) label.textContent = [...k.slice(2)].join(" ").toUpperCase();
    else if (k === "layout") label.textContent = LAYOUT_NAME[LETTER_LAYOUTS[(LETTER_LAYOUTS.indexOf(letters) + 1) % LETTER_LAYOUTS.length]];
    else label.textContent = isLetter ? k.toUpperCase() : (FACE[k] ?? k);
  });
}
function measure() {
  letterCenters = [...document.querySelectorAll("#keys .key[data-key]")]
    .filter((el) => el.dataset.key.length === 1 && LETTERS.includes(el.dataset.key))
    .map((el) => { const r = el.getBoundingClientRect(); keyWidth = r.width; return { letter: el.dataset.key, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
}
function renderText() {
  if (!typer) return;
  $("done").textContent = typer.committed;
  $("typing").textContent = typer.typingDisplay();
  const g = typer.ghost();
  $("ghost").textContent = g ? g.tail : "";
  $("textbox").classList.toggle("empty", !typer.text());
  $("textbox").scrollTop = $("textbox").scrollHeight;
  const sugg = typer.suggestions(3);
  [...$("chips").children].forEach((el, i) => {
    const w = sugg[CHIP_ORDER[i]];
    el.classList.toggle("empty", !w);
    el.classList.toggle("lead", CHIP_ORDER[i] === 0 && !!w);
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

// ---------- metrics: speed and effort, from what was actually typed ----------
const stats = { produced: 0, presses: 0, undone: 0, activeMs: 0, lastAt: 0, fixes: 0 };
function countInput(kind, before) {
  const now = Date.now();
  if (stats.lastAt) stats.activeMs += Math.min(now - stats.lastAt, IDLE_MS);
  stats.lastAt = now;
  stats.presses++;
  if (kind === "undo") stats.undone++;
  const grew = typer.text().length - before;
  if (grew > 0) stats.produced += grew;
  renderStats();
}
function metrics() {
  const min = stats.activeMs / 60000;
  return {
    wpm: min > 0.05 ? +(stats.produced / 5 / min).toFixed(1) : 0,
    keysSaved: stats.produced > 0 ? Math.max(0, Math.round(100 * (1 - stats.presses / stats.produced))) : 0,
    undone: stats.presses > 0 ? Math.round((100 * stats.undone) / stats.presses) : 0,
    chars: stats.produced, presses: stats.presses, fixes: stats.fixes, minutes: +min.toFixed(2),
  };
}
function renderStats() {
  const m = metrics();
  $("stats").textContent = stats.presses ? `${m.wpm} wpm · ${m.keysSaved}% keys saved · ${m.undone}% undone` : "";
}
window.fourLooks.metrics = metrics;
window.fourLooks.cursor = () => cursorAt;
window.fourLooks.reach = () => pointer.gain;

function noteFix() {
  const f = typer.lastFix;
  if (!f) return;
  typer.lastFix = null;
  stats.fixes++;
  prompt(`Changed "${f.from}" to "${f.to}". Press undo to keep "${f.from}".`);
  $("textbox").classList.remove("flash"); void $("textbox").offsetWidth; $("textbox").classList.add("flash");
}

function acceptGhost(how) {
  if (how === "nod" && study.capture) { study.onNod?.(performance.now()); return true; }
  if (!typer || calibrating) return false;
  if (pendingFix) { applyFix(); return true; }
  if (!typer.ghost()) return false;
  const before = typer.text().length;
  typer.save();
  const word = typer.acceptGhost();
  tick();
  record("ghost", { word, how });
  countInput("ghost", before);
  updateKeys(); renderText(); updatePrior(); mirror();
  return true;
}

// ---------- Grok check: grammar and sense, through the local server (needs XAI_API_KEY in .env) ----------
window.fourLooks.offset = () => pointer.offset;
// The guided test borrows the pointer, the press move and the nod while it runs.
const study = { capture: false, onPress: null, onNod: null, watchers: new Set() };
let pendingFix = null;
let lastPress = null;                  // top letters of the last key press, for the admin view
async function askFix() {
  if (pendingFix) { applyFix(); return; }
  typer.commitWord();
  const text = typer.text().trim();
  if (!text) return;
  prompt("Checking with Grok.");
  try {
    const r = await (await fetch("/api/fix", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })).json();
    if (!r.ok) { prompt(r.error === "no key" ? "Grok is off. Add XAI_API_KEY to four-looks/.env and restart." : `Grok check failed: ${r.error}`); return; }
    record("fix-check", { text, fixed: r.text });
    if (r.text.trim() === text) { prompt("Grok: reads fine."); return; }
    pendingFix = r.text.trim();
    prompt(`Grok suggests: ${pendingFix}  Nod or press fix again to use it. Undo to dismiss.`);
  } catch (err) { prompt(`Grok check failed: ${err.message}`); }
}
function applyFix() {
  if (!pendingFix) return;
  typer.save();
  typer.committed = pendingFix + " ";
  typer.pending = [];
  record("fix-apply", { text: pendingFix });
  pendingFix = null;
  prompt("Used Grok's version.");
  updateKeys(); renderText(); updatePrior(); mirror();
}

function press(el, x, y) {
  const k = el.dataset.key;
  if (k === "pick" && !el.dataset.word) return;
  tick();
  el.classList.add("pressed");
  setTimeout(() => el.classList.remove("pressed"), 120);
  if (k === "menu") { toggleMenu(); return; }
  if (k.startsWith("set:")) { runSetting(k.slice(4)); return; }
  const before = typer.text().length;
  const edits = !["shift", "123", "abc", "layout", "speak", "undo", "fix"].includes(k);
  if (edits) typer.save();
  if (k === "undo") {
    if (pendingFix) { pendingFix = null; prompt("Dismissed."); }
    else { const ok = typer.undo(); record("undo"); prompt(ok ? "Undone." : "Nothing to undo."); }
    countInput("undo", before);
  } else if (k === "fix") { askFix(); }
  else if (k === "pick") {
    typer.pick(el.dataset.word);
    store(WORDS_KEY, [...typer.learned]);
    record("pick", { word: el.dataset.word });
  } else if (k.startsWith("g:")) {                    // a big key: the press only says "one of these letters"
    const group = k.slice(2);
    typer.letter([...LETTERS].map((c) => (group.includes(c) ? 1 / group.length : 0)), { group: true });
    lastPress = [...group].map((c) => [c, 1 / group.length]);
    record("letter", { key: k });
  } else if (k.length === 1 && LETTERS.includes(k)) {
    const probs = letterProbs(x, y);
    lastPress = probs.map((p, i) => [LETTERS[i], p]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    typer.letter(probs);
    record("letter", { key: k });
  } else if (k === "space") { typer.literal(" "); record("space"); }
  else if (k === "⌫") { typer.backspace(); record("backspace"); }
  else if (k === "shift") typer.toggleShift();
  else if (k === "123" || k === "abc") { layer = k === "123" ? "sym" : letters; buildKeys(); }
  else if (k === "layout") { letters = LETTER_LAYOUTS[(LETTER_LAYOUTS.indexOf(letters) + 1) % LETTER_LAYOUTS.length]; layer = letters; store(LAYOUT_KEY, letters); record("layout", { letters }); buildKeys(); }
  else if (k === "speak") speak(false);
  else if (k === "send") send();
  else { typer.literal(k); record("symbol", { key: k }); }
  if (edits && k !== "send") countInput(k === "⌫" ? "undo" : "key", before);
  noteFix();
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
  if (!typer || (layer !== "abc" && layer !== "head")) { letterPrior = null; return; }
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
  const peak = letterPrior ? Math.max(...letterPrior) : 0;
  document.querySelectorAll("#keys .key[data-key]").forEach((el) => {      // admin view tints keys by how likely they are next
    const i = el.dataset.key.length === 1 ? LETTERS.indexOf(el.dataset.key) : -1;
    el.style.setProperty("--prior", i >= 0 && peak > 0 ? String(letterPrior[i] / peak) : "0");
  });
}

const letterEls = () => document.querySelectorAll("#keys .key[data-key]");
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
// Which key the pointer is on. While the settings panel is open only its tiles count, so nothing
// underneath can be pressed through it. Sticky hover never holds a key in a different layer.
function pickHover(x, y, t) {
  const menuOpen = document.body.classList.contains("menu-open");
  const inMenu = (el) => !!el && !!el.closest("#menu");
  if (hoverEl && inMenu(hoverEl) !== menuOpen) return menuOpen ? onlyMenu(keyAt(x, y)) : keyAt(x, y);
  const top = menuOpen ? onlyMenu(keyAt(x, y)) : keyAt(x, y);
  // The lock holds through wobble at a key's edge, but a clear move into the middle of another key wins.
  if (stillOn(hoverEl, x, y, t) && !(top && top !== hoverEl && inCore(top, x, y))) return hoverEl;
  return top;
}
function inCore(el, x, y) {
  const r = el.getBoundingClientRect(), mx = CORE * r.width, my = CORE * r.height;
  return x > r.left + mx && x < r.right - mx && y > r.top + my && y < r.bottom - my;
}
const onlyMenu = (el) => (el && el.closest("#menu") ? el : null);
function setFill(el, p) { if (el) el.style.setProperty("--p", String(p)); }
function movePointer(x, y, t) {
  cursorAt = [x, y];
  const el = pickHover(x, y, t);
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
  if (hoverEl && armed && !calibrating && holdToPress && !study.capture) {
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

// ---------- nod: a quick, clear dip and return of the head accepts the grey guess ----------
// Measured in the person's own calibrated range (not screen pixels), so moving down a key row or
// two never counts: a nod has to dip at least NOD_AMP of that range and be back within NOD_MS.
const nod = { rest: null, restX: null, state: "rest", since: 0, peak: 0, last: 0 };
function detectNod(f) {
  const raw = pointer.raw(f.pose, 1);
  if (!raw) return;
  const [x, y] = raw;
  if (nod.rest == null) { nod.rest = y; nod.restX = x; return; }
  const dy = y - nod.rest;
  if (nod.state === "rest") {
    if (dy > NOD_START && f.t - nod.last > 700) { nod.state = "dip"; nod.since = f.t; nod.peak = dy; }
    else { nod.rest += 0.15 * (y - nod.rest); nod.restX += 0.15 * (x - nod.restX); }
    return;
  }
  nod.peak = Math.max(nod.peak, dy);
  const sideways = Math.abs(x - nod.restX) > 0.5 * Math.max(nod.peak, NOD_START);
  if (f.t - nod.since > NOD_MS || sideways) { nod.state = "rest"; nod.rest = y; nod.restX = x; return; }   // a real move
  if (nod.peak >= NOD_AMP && dy < 0.35 * nod.peak) { nod.state = "rest"; nod.last = f.t; acceptGhost("nod"); }
}

// ---------- camera ----------
let blinkSince = null, blinkFired = false, eyesShutSince = null, recentered = false, freezeSince = null;
const FREEZE_MAX_MS = 500;              // the cursor holds still at most this long while a press move rises
const RECENTER_MS = 1100;               // eyes closed this long: the way you face now becomes the middle of the keyboard
function onFrame(f) {
  lastFrame = f;
  watchers.forEach((w) => w(f));
  $("status").textContent = f.face ? (pointer.ready ? "tracking" : "calibrate") : "no face";
  $("status").classList.toggle("live", f.face && pointer.ready);
  const c = f.face ? CUES[cueCfg.cue].score(f.scores) : 0;
  $("meter").style.setProperty("--c", String(c));
  $("meter").style.setProperty("--thr", String(cueCfg.thr));
  $("cuebar").style.setProperty("--c", String(c));
  if (adminOn && admin) drawAdmin(f, c);
  const shut = f.face && ((f.scores.eyeBlinkLeft || 0) + (f.scores.eyeBlinkRight || 0)) / 2 > 0.5;
  if (shut && !calibrating) {
    if (eyesShutSince == null) { eyesShutSince = f.t; recentered = false; }
    else if (f.t - eyesShutSince > 3000) { eyesShutSince = null; toggleMenu(false); calibrate(); return; }
    else if (!recentered && f.t - eyesShutSince > RECENTER_MS && pointer.ready) {
      recentered = true;
      const k = document.querySelector('#keys [data-key="g"]')?.getBoundingClientRect();      // the middle of the keyboard
      if (pointer.recenter(f.pose, k ? (k.left + k.width / 2) / innerWidth : 0.5, k ? (k.top + k.height / 2) / innerHeight : 0.5)) { record("recenter"); tick(); prompt("Recentered."); }
    }
  } else eyesShutSince = null;
  if (!f.face || calibrating || !pointer.ready) return;
  if (!cueCfg.calibrated || c <= cueCfg.freeze) freezeSince = null; else if (freezeSince == null) freezeSince = f.t;
  const closing = freezeSince != null && f.t - freezeSince < FREEZE_MAX_MS;
  if (!closing) {
    const p = pointer.point(f.pose, f.t);
    if (p) movePointer(p[0] * innerWidth, p[1] * innerHeight, f.t);
  } else if (cursorAt) movePointer(cursorAt[0], cursorAt[1], f.t);
  detectNod(f);
  study.watchers.forEach((w) => w(f, { cursor: cursorAt, score: c }));
  if (cueCfg.calibrated && c > cueCfg.thr) {
    if (blinkSince == null) blinkSince = f.t;
    const target = intended(blinkSince);       // where you were when the press move started
    if (!blinkFired && f.t - blinkSince > cueCfg.ms && study.capture) { blinkFired = true; study.onPress?.(performance.now()); }
    if (!blinkFired && f.t - blinkSince > cueCfg.ms && target) {
      blinkFired = true;
      // For studying drift on a real face: where the head was in the camera frame at this press.
      if (f.lm) record("aim", { key: target.el.dataset.key, pose: f.pose.map((v) => +v.toFixed(4)), nose: [+f.lm[1].x.toFixed(4), +f.lm[1].y.toFixed(4)],
        eyes: +Math.hypot(f.lm[33].x - f.lm[263].x, f.lm[33].y - f.lm[263].y).toFixed(4), cursor: [Math.round(target.x), Math.round(target.y)], offset: pointer.offset.map((v) => +v.toFixed(3)) });
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
  // Follow the dots: the cursor is fitted to where you actually point, so no direction can flip.
  const targets = [[0.5, 0.55], [0.08, 0.12], [0.92, 0.12], [0.92, 0.9], [0.08, 0.9], [0.5, 0.55]];
  const dot = $("target");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const poses = [], used = [];
    for (const [tx, ty] of targets) {
      dot.style.display = "block";
      dot.style.left = `${tx * innerWidth}px`;
      dot.style.top = `${ty * innerHeight}px`;
      prompt(attempt === 1 ? "Point your nose at the dot. Keep it comfortable." : "Once more. Turn your head a bit further toward each dot.", true);
      await sleep(700);
      const pose = await collectSettledPose();
      if (pose) { poses.push(pose); used.push([tx, ty]); }
    }
    dot.style.display = "none";
    if (poses.length < 5) continue;
    pointer.fit(poses, used);
    // Line-up check: put each pose back through the fit. A person who followed the dots lands near them.
    const miss = Math.sqrt(poses.reduce((s, p, i) => { const at = pointer.project(p, 1); return s + (at[0] - used[i][0]) ** 2 + (at[1] - used[i][1]) ** 2; }, 0) / poses.length);
    const deg = (r) => +((r * 180) / Math.PI).toFixed(1);
    const yaws = poses.map((p) => p[0]), pitches = poses.map((p) => p[1]);
    record("calibrate", { attempt, points: poses.length, missScreen: +miss.toFixed(3), turnDeg: deg(Math.max(...yaws) - Math.min(...yaws)), nodDeg: deg(Math.max(...pitches) - Math.min(...pitches)) });
    // The line-up number is recorded for study, never used to refuse. Only a head that barely moved gets one more try.
    const barelyMoved = Math.max(...yaws) - Math.min(...yaws) < 0.09 || Math.max(...pitches) - Math.min(...pitches) < 0.045;
    if (!barelyMoved || attempt === 2) {
      store(POINTER_KEY, pointer);
      calibrating = false;
      await calibrateCue();
      return;
    }
  }
  prompt("Could not see your face for calibration. It will try again when it sees you.");
  calibrating = false;
}

// Waits until the head has settled on the dot (or 2 seconds pass), then averages the next 0.7 seconds.
async function collectSettledPose() {
  const recent = [];
  const w = (f) => { if (f.pose) { recent.push({ t: f.t, p: f.pose }); if (recent.length > 60) recent.shift(); } };
  watchers.add(w);
  const t0 = performance.now();
  while (performance.now() - t0 < 2000) {
    await sleep(100);
    const last = recent.filter((r) => performance.now() - r.t < 400);
    if (last.length < 6) continue;
    const spread = (k) => Math.max(...last.map((r) => r.p[k])) - Math.min(...last.map((r) => r.p[k]));
    if (spread(0) < 0.02 && spread(1) < 0.02) break;            // within about one degree for 0.4 s
  }
  watchers.delete(w);
  return collectPose(700);
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
  document.body.classList.add("cue-test");          // shows a large live bar of the press move
  let fit = null;
  for (let attempt = 1; attempt <= 2 && !(fit && fit.ok); attempt++) {
    prompt(attempt === 1 ? "Relax your face. Watch the bar at the bottom." : `I did not see it. Relax, then ${cue.name} clearly when it says now.`, true);
    await sleep(attempt === 1 ? 1400 : 2600);
    const rest = (await collectCue(2000)).map((x) => x.c);
    const firm = [];
    for (let i = 1; i <= 3; i++) {
      prompt(`Get ready, ${i} of 3.`, true);
      await sleep(1300);
      prompt(cue.firm, true);
      firm.push(await collectCue(2000));
    }
    prompt(cue.normal, true);
    await sleep(600);
    const normal = await collectCue(4000);
    fit = fitCue(cueCfg.cue, rest, firm, normal);
    record("cue-calibrate", { attempt, ...fit });
  }
  document.body.classList.remove("cue-test");
  if (fit.ok) {
    cueCfg = fit;
    store(CUE_KEY, cueCfg);
    prompt(fit.clean ? `Set. A short ${cue.name} presses a key.` : `Set, but everyday movement comes close. Make a ${cue.name} a bit stronger to press.`);
  } else {                                            // never run on a press move the camera cannot see
    cueCfg = { ...DEFAULT_CUE, cue: cueCfg.cue, calibrated: false };
    store(CUE_KEY, cueCfg);
    holdToPress = true; store(HOLD_KEY, true); refreshMenu();
    prompt(`I could not see your ${cue.name}. For now, hold on a key to press it. Pick another press move in the menu.`);
  }
  calibrating = false;
}

async function startCamera() {
  if (usingCamera) return;
  prompt("Starting the camera.");
  try {
    if (params.get("sim")) {             // simulated face, for testing the camera path without a camera
      const { startSimFace } = await import("./sim.js");
      window.fourLooks.sim = startSimFace(onFrame, { cueName: () => cueCfg.cue });
    } else await startFace($("video"), onFrame);
    usingCamera = true;
    refreshMenu();
    if (pointer.ready) prompt(LIVE ? `Ready. Click into any text box, then ${CUES[cueCfg.cue].name} to press keys.` : `Ready. ${CUES[cueCfg.cue].name} to press keys.`);
    else prompt("Sit in front of the camera. Calibration starts when it sees you.");
  } catch (err) {
    prompt(`Camera did not start (${err.message}). Open the menu and choose Camera.`);
  }
}

// ---------- settings: a side panel opened by the dots key, usable with the head pointer ----------
const THEMES = ["launch", "obsidian", "carrara", "linen", "contrast", "auto"];
let theme = (() => { try { const t = JSON.parse(localStorage.getItem("fourlooks.theme.v1")); return THEMES.includes(t) ? t : "launch"; } catch { return "launch"; } })();
let themeTimer = 0;
function applyTheme() {
  const html = document.documentElement;
  html.classList.add("theming");                  // every surface cross-fades to the new theme
  clearTimeout(themeTimer);
  themeTimer = setTimeout(() => html.classList.remove("theming"), 520);
  if (theme === "auto") delete html.dataset.theme; else html.dataset.theme = theme;
  requestAnimationFrame(measure);
}
applyTheme();
pointer.gain = loadReach() >= 0.4 && loadReach() <= 2.5 ? loadReach() : 1.3;
let tuned = { name: "medium", smoothing: { minCutoff: 0.35, beta: 2.2, deadzone: 0.005 } };
try { const t = JSON.parse(localStorage.getItem(TUNE_KEY)); if (t?.smoothing) { tuned = t; pointer.smoothing(t.smoothing); } } catch { /* keep defaults */ }
// ---------- camera view and admin view ----------
const flag = (key, fallback) => { try { const v = JSON.parse(localStorage.getItem(key)); return typeof v === "boolean" ? v : fallback; } catch { return fallback; } };
let camView = flag("fourlooks.camview.v1", true);
let adminOn = params.get("admin") === "1" || flag("fourlooks.admin.v1", false);
let admin = null;
function applyViews() {
  document.body.classList.toggle("camview", camView && !adminOn);
  document.body.classList.toggle("admin", adminOn);
  if (adminOn && !admin) admin = createAdmin($("admin"), $("video"));
  window.fourLooksOut?.resize?.(adminOn ? 0.9 : 0.56);
  requestAnimationFrame(() => { measure(); updatePrior(); });
}
function drawAdmin(f, c) {
  const raw = pointer.raw(f.pose), unit = pointer.raw(f.pose, 1);
  const dot = $("rawdot");
  if (raw) { dot.style.display = "block"; dot.style.transform = `translate3d(${Math.min(1, Math.max(0, raw[0])) * innerWidth}px, ${Math.min(1, Math.max(0, raw[1])) * innerHeight}px, 0)`; }
  const vote = intended(f.t);
  const top = letterPrior ? letterPrior.map((p, i) => [LETTERS[i], p]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, p]) => `${l.toUpperCase()} ${Math.round(100 * p)}%`).join(" ") : "";
  const words = typer && typer.pending.length
    ? [...typer.ranked(4), ...typer.dec.completeWord(typer.letterSlots().map((p) => p.probs), typer.history(), { top: 2 }).map((w) => ({ ...w, longer: true }))].sort((a, b) => b.score - a.score)
    : [];
  admin.draw(f, {
    raw, shown: cursorAt ? [cursorAt[0] / innerWidth, cursorAt[1] / innerHeight] : null, reach: pointer.gain, calibrated: pointer.ready,
    cue: { name: CUES[cueCfg.cue].name, score: c, thr: cueCfg.thr, freeze: cueCfg.freeze, needMs: cueCfg.ms, heldMs: blinkSince == null ? 0 : f.t - blinkSince },
    nod: { state: nod.state, dip: unit && nod.rest != null ? Math.max(0, unit[1] - nod.rest) : 0, need: NOD_AMP, ms: NOD_MS },
    eyesShutMs: eyesShutSince == null ? 0 : f.t - eyesShutSince,
    hover: hoverEl ? (hoverEl.dataset.word || hoverEl.dataset.key) : "", lock: hoverEl ? Math.min(1, (f.t - hoverSince) / LOCK_MS) : 0,
    vote: vote ? (vote.el.dataset.word || vote.el.dataset.key) : "", lastPress, nextLetters: top, words,
  });
}
applyViews();

let studyRunning = false;
async function startStudy(kind = "study") {
  if (studyRunning || !usingCamera || !pointer.ready) { prompt("Start the camera and calibrate first."); return; }
  studyRunning = true;
  const { runStudy, runTune } = await import("./study.js");
  const box = $("studybox");
  try {
    await (kind === "tune" ? runTune : runStudy)({
      tune: {
        get: () => ({ gain: pointer.gain, name: tuned.name, smoothing: tuned.smoothing }),
        set: (gain, smoothing) => { pointer.gain = gain; pointer.smoothing(smoothing); },
        apply: (gain, smoothing, name) => { pointer.gain = gain; pointer.smoothing(smoothing); tuned = { name, smoothing }; store(REACH_KEY, gain); store(TUNE_KEY, tuned); refreshMenu(); },
      },
      prompt, record, cursor: () => cursorAt, pressNow: () => CUES[cueCfg.cue].firm,
      onFrame: (fn) => { study.watchers.add(fn); return () => study.watchers.delete(fn); },
      capture: (on, onPress = null, onNod = null) => { study.capture = on; study.onPress = onPress; study.onNod = onNod; },
      target: {
        show: (cx, cy, w, h) => { Object.assign(box.style, { display: "block", left: `${cx - w / 2}px`, top: `${cy - h / 2}px`, width: `${w}px`, height: `${h}px` }); },
        hide: () => { box.style.display = "none"; },
      },
      typing: { text: () => typer.text(), clear: () => { typer.clear(); mirrored = ""; updateKeys(); renderText(); updatePrior(); } },
      layout: { get: () => letters, set: (v) => { letters = v; layer = v; buildKeys(); renderText(); } },
    });
  } finally { study.capture = false; box.style.display = "none"; studyRunning = false; }
}
window.fourLooks.startStudy = startStudy;
let faceSince = 0, cueTried = false;
setInterval(() => {                         // no calibration yet: start one once a face has been in view for a second
  if (usingCamera && pointer.ready && !calibrating && !cueCfg.calibrated && !holdToPress && !cueTried && lastFrame?.face) { cueTried = true; calibrateCue(); return; }
  if (!usingCamera || pointer.ready || calibrating) { faceSince = 0; return; }
  const seen = lastFrame?.face && performance.now() - lastFrame.t < 500;
  if (!seen) { faceSince = 0; prompt("Sit in front of the camera. Calibration starts when it sees you."); return; }
  if (!faceSince) faceSince = performance.now();
  else if (performance.now() - faceSince > 1000) { faceSince = 0; calibrate(); }
}, 500);
if (params.get("study")) {                   // "npm run study" or "npm run tune": begin once the camera and calibration are ready
  const kind = params.get("study") === "tune" ? "tune" : "study";
  const wait = setInterval(() => {
    const pressReady = cueCfg.calibrated || holdToPress || kind === "tune";
    if (usingCamera && pointer.ready && pressReady && !calibrating) { clearInterval(wait); setTimeout(() => startStudy(kind), 1500); }
  }, 1000);
}

const cycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
function saveLog() {
  const blob = new Blob([JSON.stringify({ metrics: metrics(), log }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `four-looks-session-${Date.now()}.json`; a.click();
}
const SETTINGS = [
  { id: "theme", label: "Theme", value: () => theme, run: () => { theme = cycle(THEMES, theme); store("fourlooks.theme.v1", theme); applyTheme(); } },
  { id: "cue", label: "Press with", value: () => CUES[cueCfg.cue].name, run: () => {
    cueCfg = { ...DEFAULT_CUE, cue: cycle(CUE_ORDER, cueCfg.cue) }; store(CUE_KEY, cueCfg);
    prompt(`Press move is now ${CUES[cueCfg.cue].name}. Choose Calibrate to fit it to you.`);
  } },
  { id: "reach", label: "Head reach", value: () => `${pointer.gain}x`, run: () => { pointer.gain = REACH_STEPS.includes(pointer.gain) ? cycle(REACH_STEPS, pointer.gain) : 1; store(REACH_KEY, pointer.gain); } },
  { id: "hold", label: "Hold to press", value: () => (holdToPress ? "on" : "off"), run: () => { holdToPress = !holdToPress; store(HOLD_KEY, holdToPress); hoverSince = performance.now(); } },
  { id: "camview", label: "Camera view", value: () => (camView ? "on" : "off"), run: () => { camView = !camView; store("fourlooks.camview.v1", camView); applyViews(); } },
  { id: "admin", label: "Admin view", value: () => (adminOn ? "on" : "off"), run: () => { adminOn = !adminOn; store("fourlooks.admin.v1", adminOn); applyViews(); } },
  { id: "tune", label: "Tune to me", value: () => `${tuned.name} smoothing`, run: () => { toggleMenu(false); startStudy("tune"); } },
  { id: "study", label: "Run the test", value: () => "90 seconds", run: () => { toggleMenu(false); startStudy(); } },
  { id: "calibrate", label: "Calibrate", value: () => "pointer, then press move", run: () => { toggleMenu(false); calibrate(); } },
  { id: "camera", label: "Camera", value: () => (usingCamera ? "on" : "off"), run: () => startCamera() },
  { id: "clear", label: "Clear text", value: () => "", run: () => { typer.save(); typer.clear(); mirrored = ""; record("clear"); renderText(); updatePrior(); } },
  { id: "log", label: "Save session log", value: () => "for scoring", run: saveLog },
  { id: "boxes", label: "4 box mode", value: () => "for four movements", run: () => { location.href = "/boxes.html"; } },
  ...(window.fourLooksOut?.quit ? [{ id: "quit", label: "Quit", value: () => "", run: () => window.fourLooksOut.quit() }] : []),
  { id: "close", label: "Close menu", value: () => "", run: () => toggleMenu(false) },
];
if (window.fourLooksOut?.quit) {            // a plain close button, for the mouse only so a head move cannot quit
  $("close").hidden = false;
  $("close").addEventListener("mousedown", (e) => { e.stopPropagation(); window.fourLooksOut.quit(); });
}
function buildMenu() {
  $("menu").innerHTML = `<p class="hint">Eyes closed 1 second recentres the cursor. 3 seconds recalibrates.</p>` + SETTINGS.map((it, i) =>
    `<div class="tile" data-key="set:${it.id}" style="--i:${i}"><span class="name">${it.label}</span><span class="val"></span></div>`).join("");
  refreshMenu();
}
function refreshMenu() {
  for (const it of SETTINGS) {
    const el = document.querySelector(`[data-key="set:${it.id}"] .val`);
    if (!el) continue;
    const next = it.value();
    if (el.textContent === next) continue;
    const first = el.dataset.ready !== "1";
    el.textContent = next; el.dataset.ready = "1";
    if (!first) { el.classList.remove("swap"); void el.offsetWidth; el.classList.add("swap"); }
  }
}
function toggleMenu(open = !document.body.classList.contains("menu-open")) {
  document.body.classList.toggle("menu-open", open);
  history.length = 0;                       // old hover votes belong to the other layer
  record("menu", { open });
}
function runSetting(id) {
  const it = SETTINGS.find((x) => x.id === id);
  if (!it) return;
  it.run();
  record("setting", { id });
  refreshMenu();
}

// The mouse drives the same pointer when the camera is off, for testing and for mouse users.
addEventListener("mousemove", (e) => { if (!usingCamera || !pointer.ready) movePointer(e.clientX, e.clientY, performance.now()); });
addEventListener("mousedown", (e) => {
  const el = keyAt(e.clientX, e.clientY);
  if (el && typer) { e.preventDefault(); press(el, e.clientX, e.clientY); armed = false; hoverSince = performance.now(); }
});
setInterval(() => { if (cursorAt && (!usingCamera || !pointer.ready)) movePointer(cursorAt[0], cursorAt[1], performance.now()); }, 33);
addEventListener("keydown", (e) => { if (e.key === "Tab") { e.preventDefault(); acceptGhost("tab"); } });
$("stats").addEventListener("click", saveLog);
addEventListener("resize", measure);
setInterval(() => {                        // health report for checking the app from outside
  const body = JSON.stringify({
    camera: usingCamera, face: !!lastFrame?.face, frameAgeMs: lastFrame ? Math.round(performance.now() - lastFrame.t) : null,
    calibrated: pointer.ready, pressMove: cueCfg.cue, pressCalibrated: !!cueCfg.calibrated, theme, admin: adminOn, desktop: !!window.fourLooksOut,
    prompt: $("prompt").textContent.slice(0, 120),
  });
  fetch("/api/status", { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => {});
}, 2000);

(async () => {
  buildKeys();
  buildMenu();
  try {
    const model = await (await fetch("/lm.json")).json();
    typer = new KeyTyper(new Decoder(model, { groups: LETTER_GROUPS }));
    typer.learn(loadWords());
    updatePrior();
    window.fourLooks.typer = typer;
    updateKeys(); renderText();
    prompt("Ready. The mouse works too.");
    startCamera();
  } catch (err) {
    prompt(`Word model failed to load: ${err.message}`);
  }
})();
