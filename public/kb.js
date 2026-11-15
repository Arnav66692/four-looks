// Four Looks keyboard: head pointer + hold to press + a decoder that fixes near misses.
import { Decoder, LETTER_GROUPS } from "/src/decoder.js";
import { KeyTyper, LETTERS } from "/src/keytyper.js";
import { startFace } from "./face.js";
import { HeadPointer } from "./pointer.js";
import { CUES, CUE_ORDER, DEFAULT_CUE, fitCue } from "./blink.js";
import { createAdmin } from "./admin.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DWELL_KEY = "fourlooks.dwell.v1";
const DWELL_STEPS = [1000, 800, 600];                   // hold times to choose from, ms
let DWELL = Number(params.get("dwell")) || (() => { try { const v = JSON.parse(localStorage.getItem(DWELL_KEY)); return DWELL_STEPS.includes(v) ? v : 800; } catch { return 800; } })();   // ms on a key to press it
const CUE_KEY = "fourlooks.cue.v1";                     // which face move presses, with its per-person line and length
const REACH_KEY = "fourlooks.reach.v3";
const TUNE_KEY = "fourlooks.tune.v2";                   // sensitivity and smoothing found by the tuning run
const REACH_STEPS = [0.7, 1, 1.3, 1.6, 2];                  // extra amplification, so smaller head turns cover the keyboard
const SIGMA = 0.45;                                     // press spread, in key widths
const GAP = 0.2;                                        // the gap between keys belongs to the nearest key within this (key sizes)
const ROW_HAIR = 0.28;                                  // and this much of its height against a slip to another row
const EDGE_HAIR = 0.08;                                 // an unlocked key keeps this much past its edge, to stop flicker on a boundary
const LOCK_AT = 1 / 3;                                  // a key locks once this share of the hold has been spent on it (he asked for a third, was half)
const STICKY_LOCKED = 0.5;                              // how far past its edge (in key sizes) a locked key still holds
const CORE_LOCKED = 0.3;                                // a locked key gives way only this deep inside another key
const LOCK_STEADY = 1.8;                                // while a key is locked, head tremor this much larger is ignored
const VOTE_MS = 350;                                    // a press goes to the key you were on most in this window
let holdEl = null, holdP = 0, holdT = 0, lockedEl = null, pressedEl = null, offSince = null;
const SLOW_KEYS = new Set(["shift", "123", "abc", "menu", "mouse", "undo", "fix", "speak", "send", "grokmode"]);
const STILL_MS = 150;                                   // settled means: in the last this many ms
const STILL_MOVE = 0.12;                                //   the cursor moved less than this many key widths (his own resting steps: median 0.05)
const FAST_MOVE = 0.45;                                 // moving this many key widths in that time, the fill is at its slowest
const MOVING_RATE = 0.15;                               // the slowest the fill ever runs
const fading = new Map();                               // keys you have left, with what remains of their fill
const holdAt = { x: 0, y: 0, n: 0 };                    // where the cursor rested while the current key filled
const SLOW_HOLD = 1.5;                                  // a slow key needs this many times the hold of a letter
const REARM_MS = 250;                                   // a pressed key can press again once the cursor has been off it this long
const HOLD_DRAIN = 1.6;                                 // a hold drains this many times slower than it builds
const SWITCH_MS = 40;                                   // a new key takes the selection after the pointer has been in it this long
let switchTo = null, switchSince = 0;
const NOD_AMP = Number(params.get("nod") || 0.3);        // a nod dips at least this much of your calibrated up-down range
const NOD_START = 0.07;                                 // a dip this big starts the nod clock
const NOD_MS = 550;                                     // and the head is back within this long
const IDLE_MS = 6000;                                   // gaps longer than this do not count as typing time
const CHIP_SLOTS = 5;
const CHIP_ORDER = [3, 1, 0, 2, 4];     // slot -> guess rank: the best guess sits in the middle of the row
const POINTER_KEY = "fourlooks.pointer.v4";      // v4: follow-the-dots fit, with a line-up check
const HOLD_KEY = "fourlooks.hold.v1";
const WORDS_KEY = "fourlooks.words.v1";
const USED_KEY = "fourlooks.used.v1";                    // how often each word has been used, so guesses learn the person
let usedSaved = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAYOUTS = {
  abc: [
    [..."qwertyuiop", "⌫"],
    [..."asdfghjkl", "'", "send"],
    ["shift", ..."zxcvbnm", ",", ".", "?"],
    ["123", "menu", "mouse", "space", "undo", "fix", "speak"],
  ],
  // Every letter on its own key, arranged for a head and not for hands. The ten most used letters
  // (e t a o i n s h r d) fill the middle row with the busiest in the centre, the next eight sit below
  // (nodding down is easier than up), and the eight rarest sit above.
  head: [
    ["⌫", ..."qjvpbkxz", "'", "send"],
    [..."rsiaetonhd"],
    ["shift", ..."gwulcmfy", ",", ".", "?"],
    ["123", "menu", "mouse", "space", "undo", "fix", "speak"],
  ],
  // Boxes, in phone-pad order: read left to right, top to bottom, a to z. Eight big keys with three or
  // four letters each, and the word guesser works out which letter was meant (97.9% first guess on the
  // dev sentences, tools/bigkeys-eval.mjs). The first box layout was arranged by letter frequency and
  // he found it random. This one has nothing to hunt for.
  big: [
    ["g:abc", "g:def", "g:ghi", "⌫"],
    ["g:jkl", "g:mno", "g:pqrs", "send"],
    ["g:tuv", "g:wxyz", "space", "undo"],
    ["shift", "123", "menu", "mouse", "'", ",", ".", "?", "fix", "speak"],
  ],
  sym: [
    [..."1234567890", "⌫"],
    ["-", "/", ":", ";", "(", ")", "$", "&", "@", "\"", "send"],
    ["#", "%", "*", "+", "=", "_", "!", ",", ".", "?"],
    ["abc", "menu", "mouse", "space", "undo", "fix", "speak"],
  ],
};
const FN = new Set(["⌫", "shift", "123", "abc", "speak", "undo", "fix", "menu", "layout", "mouse", "grok"]);
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  "⌫": svg('<path d="M9 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-6-6z"/><path d="M12.5 10l4 4m0-4l-4 4"/>'),
  shift: svg('<path d="M12 4l8 9h-5v7H9v-7H4z"/>'),
  caps: svg('<path d="M12 3l8 9h-5v5H9v-5H4z"/><path d="M9 21h6"/>'),
  menu: svg('<circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/>'),
};
const FACE = { "⌫": "⌫", shift: "⇧", send: "send", space: "space", "123": "123", abc: "ABC", speak: "speak", undo: "undo", fix: "fix", menu: "⋯", mouse: "mouse", grok: "grok" };

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
const LAYOUT_KEY = "fourlooks.layout.v3";
const LETTER_LAYOUTS = ["head", "big", "abc"];        // head-arranged letters, boxes (phone-pad order), and QWERTY
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
function prompt(text, big = false, stay = false) {      // a quiet line that fades once read, unless told to stay
  const el = $("prompt");
  el.textContent = text; el.classList.toggle("big", big); el.classList.add("show");
  clearTimeout(promptTimer);
  if (!big && !stay) promptTimer = setTimeout(() => el.classList.remove("show"), 5000);
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
    else label.textContent = isLetter ? k.toUpperCase() : (k === "send" && grokMode ? "do it" : (FACE[k] ?? k));
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
  $("ghostmore").textContent = g && g.more.length ? ` ${g.more.join(" ")}` : "";
  $("textbox").classList.toggle("empty", !typer.text());
  $("textbox").scrollTop = $("textbox").scrollHeight;
  const quick = grokMode && !typer.text();          // Grok is listening and nothing is typed: offer ready commands
  const sugg = quick ? QUICK : typer.suggestions(4);
  [...$("chips").children].forEach((el, i) => {
    const w = sugg[CHIP_ORDER[i]];
    el.classList.toggle("empty", !w);
    el.classList.toggle("lead", CHIP_ORDER[i] === 0 && !!w);
    el.dataset.word = w || "";
    el.dataset.cmd = quick && w ? w : "";
    el.textContent = w || "";
  });
}

// ---------- pressing ----------
function letterProbs(x, y, sigma = SIGMA) {
  const s = sigma * keyWidth;
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
  freshFix = { ...f, at: performance.now() };
  prompt(`Changed "${f.from}" to "${f.to}". Shake your head or press undo to keep "${f.from}".`);
  $("textbox").classList.remove("flash"); void $("textbox").offsetWidth; $("textbox").classList.add("flash");
}

// Autocorrect runs by itself on every word. A head shake or undo straight after a change says no to it:
// the letters as typed come back, for that word only, and the word is remembered so it is not changed again.
let freshFix = null;
const FIX_SHAKE_MS = 6000;             // a shake counts as "no" for this long after the change
function keepFix(how) {
  const f = freshFix;
  freshFix = null;
  if (!f || !typer.keepTyped(f)) return false;
  tick();
  store(WORDS_KEY, [...typer.learned]);
  record("keep-typed", { from: f.from, to: f.to, how });
  prompt(`Kept "${f.from}". It will not be changed again.`);
  updateKeys(); renderText(); updatePrior(); mirror();
  return true;
}

function acceptGhost(how) {
  if (how === "nod" && study.capture) { study.onNod?.(performance.now()); return true; }
  if (how === "nod" && grok.busy) { answerGrok(true); return true; }
       // while Grok works, a nod only ever means yes
  if (how === "nod" && mode === "mouse") return true;        // a nod moves the cursor, so it does not click: the mouth does
  if (!typer || calibrating) return false;
  if (pendingFix) { applyFix(); return true; }
  // Two nods close together take the whole grey phrase: the second nod takes the words shown after the first.
  if (how === "nod" && phraseRest.length && performance.now() - phraseAt < DOUBLE_NOD_MS && !typer.pending.length) {
    const before = typer.text().length;
    typer.save();
    const rest = phraseRest; phraseRest = [];
    for (const w of rest) typer.pick(w);
    tick();
    record("ghost-phrase", { words: rest });
    countInput("ghost", before);
    updateKeys(); renderText(); updatePrior(); mirror();
    return true;
  }
  if (!typer.ghost()) return false;
  const before = typer.text().length;
  typer.save();
  const taken = typer.acceptGhost();
  const word = taken.word;
  phraseRest = taken.more; phraseAt = performance.now();
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
let lastTrace = 0;
const PRESS_KEY = "fourlooks.presshold.v1";
const PRESS_STEPS = { quick: 0, normal: 120, slow: 280 };  // extra time the press move must be held, ms
let pressName = (() => { try { const v = JSON.parse(localStorage.getItem(PRESS_KEY)); return v in PRESS_STEPS ? v : "normal"; } catch { return "normal"; } })();
let pressExtra = PRESS_STEPS[pressName];
let phraseRest = [], phraseAt = 0;                         // the rest of the grey phrase, for a second nod
const DOUBLE_NOD_MS = 1100;
let pendingFix = null;
let lastPress = null;                  // top letters of the last key press, for the admin view
async function askFix() {
  if (pendingFix) { applyFix(); return; }
  endWord();
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

function press(el, x, y, sure = false) {
  const k = el.dataset.key;
  if (k === "pick" && !el.dataset.word) return;
  tick();
  el.classList.add("pressed");
  setTimeout(() => el.classList.remove("pressed"), 120);
  if (k === "menu") { toggleMenu(); return; }
  if (k === "mouse") { setMode("mouse"); return; }
  if (k === "grokmode") { toggleGrokMode("icon"); return; }
  if (k === "pick" && el.dataset.cmd) { quickCommand(el.dataset.cmd); return; }
  if (k === "send" && grokMode) { runGrok(); return; }
  if (k === "dock:stop") { stopGrok("you"); return; }
  if (k === "dock:keyboard") { if (grok.busy) stopGrok("you"); setMode("keyboard"); return; }
  if (k === "dock:quit") { window.fourLooksOut?.quit?.(); return; }
  if (k.startsWith("set:")) { runSetting(k.slice(4)); return; }
  if (k !== "undo") freshFix = null;          // typing on means the change was accepted
  const before = typer.text().length;
  const edits = !["shift", "123", "abc", "layout", "speak", "undo", "fix"].includes(k);
  const sentNow = k === "send";
  if (edits) typer.save();
  if (k === "undo") {
    if (pendingFix) { pendingFix = null; prompt("Dismissed."); }
    else if (freshFix && keepFix("undo")) { /* the autocorrect was refused: nothing else to step back */ }
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
  if (typer.used.size !== usedSaved) { usedSaved = typer.used.size; store(USED_KEY, [...typer.used]); }
  else if (k === "pick" || k === "space") store(USED_KEY, [...typer.used]);
  updateKeys();
  renderText();
  updatePrior();
  mirror();
  if (sentNow && autoShown) setMode("mouse", "sent");      // the keyboard came up for a text box: step back once the message is sent
}

// A key that ends the word without a space (fix, speak) still leaves one, so the next word never glues on.
function endWord() {
  typer.commitWord();
  if (typer.committed && !/\s$/.test(typer.committed)) typer.committed += " ";
}
function speak(andClear) {
  endWord();
  const text = typer.text().trim();
  if (!text) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  record(andClear ? "send" : "speak", { text, chars: text.length });
  if (andClear) typer.clear();
}
// ---------- live typing into the app in front (desktop app only) ----------
// In the simulator a stand-in records exactly what would have been typed into the app in front.
const fakeApp = { text: "", returns: 0, calls: 0 };
const fakeOut = {
  edit: async (deletes, text) => { fakeApp.calls++; fakeApp.text = fakeApp.text.slice(0, fakeApp.text.length - deletes) + text; return { ok: true }; },
  type: async (text) => { fakeApp.calls++; fakeApp.text += text; return { ok: true }; },
  enter: async () => { fakeApp.returns++; fakeApp.text += "\n"; return { ok: true }; },
  send: async (text) => { fakeApp.text += `${text}\n`; fakeApp.returns++; return { ok: true }; },
};
window.fourLooks.app = fakeApp;
const out = window.fourLooksOut || (params.get("sim") && params.get("app") ? fakeOut : undefined);
const LIVE = !!out?.edit;
let mirrored = "";
let queue = Promise.resolve();
function mirror() {
  if (!LIVE || !typer || grokMode) return;      // a command for Grok is never typed into the app in front
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

function keyAt(x, y) {
  // The key under the cursor is the key selected. Nothing pulls the selection toward a likely letter:
  // that made unlikely letters hard to reach. The word model still corrects presses afterwards.
  const hit = document.elementFromPoint(x, y)?.closest("[data-key]") || null;
  if (hit) return hit;
  // Between two keys there is a thin gap. The nearest key within reach of the gap takes it, so there is no dead space.
  // Past the outer edge of the keyboard the nearest key takes it however far out the cursor is, so the
  // keys on the edges are the easiest to hit, not the hardest.
  const menuOpen = document.body.classList.contains("menu-open");
  let best = null, bestD = Infinity, bestSize = 1, box = null;
  for (const el of document.querySelectorAll(menuOpen ? "#menu [data-key]" : "#keys [data-key], #chips [data-key]")) {
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    box = box ? { l: Math.min(box.l, r.left), r: Math.max(box.r, r.right), t: Math.min(box.t, r.top), b: Math.max(box.b, r.bottom) } : { l: r.left, r: r.right, t: r.top, b: r.bottom };
    const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
    if (d < bestD) { bestD = d; best = el; bestSize = Math.min(r.width, r.height); }
  }
  if (!best) return null;
  // Only the sides and the bottom extend. Above the suggestions is the text box, where you rest to read.
  const outside = !menuOpen && y >= box.t && (x < box.l || x > box.r || y > box.b);
  return outside || bestD <= GAP * bestSize ? best : null;
}
// How much of the press time has been spent on the selected key, 0 to 1.
function lockShare(t) {
  if (!hoverEl) return 0;
  return holdToPress ? (holdEl === hoverEl ? holdP : 0) : Math.min(1, (t - hoverSince) / DWELL);
}
const isLocked = (t) => lockShare(t) >= LOCK_AT;
function stillOn(el, x, y, t) {
  if (!el || !el.isConnected) return false;
  // Before the lock a key keeps only a hair past its edge, enough to stop flicker on the line between two keys.
  // His traces show the cursor bouncing between rows far more than along a row (up-down head movement is
  // small and noisy), so before the lock a key holds further against a slip to the row above or below.
  const r = el.getBoundingClientRect(), locked = isLocked(t);
  const mx = locked ? STICKY_LOCKED * Math.min(r.width, r.height) : EDGE_HAIR * r.width;
  const my = locked ? STICKY_LOCKED * Math.min(r.width, r.height) : ROW_HAIR * r.height;
  return x > r.left - mx && x < r.right + mx && y > r.top - my && y < r.bottom + my;
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
  // Before the lock the selection is simply the key under the cursor. Once locked (a third of the hold spent),
  // the key holds through wobble past its edge and only a clear move deep into another key takes over.
  const zone = (el) => (el ? (el.closest("#chips") ? "chips" : el.closest("#keys") ? "keys" : "other") : null);
  if (top && hoverEl && zone(top) !== zone(hoverEl)) return top;      // the lock never reaches from a key into the suggestions, or back
  if (stillOn(hoverEl, x, y, t) && !(isLocked(t) && top && top !== hoverEl && inCore(top, x, y))) return hoverEl;
  return top;
}
function inCore(el, x, y) {
  const r = el.getBoundingClientRect(), mx = CORE_LOCKED * r.width, my = CORE_LOCKED * r.height;
  return x > r.left + mx && x < r.right - mx && y > r.top + my && y < r.bottom - my;
}
const onlyMenu = (el) => (el && el.closest("#menu") ? el : null);
function setFill(el, p) { if (el) el.style.setProperty("--p", String(p)); }
// Looking well past the side or the bottom of the keyboard (at the laptop, at someone, away) is resting,
// not aiming. In his 3:12 PM run undo fired three times and shift once while he rested past the edge,
// because the edge keys reach outward. They still do, but only this far.
const AWAY = 0.05;                     // past the window edge by this much (after edge softening) counts as away
let awayNow = false;
function movePointer(x, y, t, past = null) {
  cursorAt = [x, y];
  awayNow = !!past && Math.max(past.left, past.right, past.down) > AWAY;
  $("cursor").classList.toggle("away", awayNow);
  let el = awayNow ? null : pickHover(x, y, t);
  if (el !== hoverEl && hoverEl && el) {            // passing over a key is not selecting it: it must hold for a moment
    if (el !== switchTo) { switchTo = el; switchSince = t; }
    if (t - switchSince < SWITCH_MS) el = hoverEl;
  } else switchTo = null;
  history.push({ t, el, x, y });
  while (history.length && t - history[0].t > VOTE_MS * 2) history.shift();
  const c = $("cursor");
  c.style.display = "block";
  c.style.transform = `translate3d(${x}px, ${y}px, 0)`;      // drawn exactly where the head points
  if (el !== hoverEl) {
    setFill(hoverEl, 0);
    hoverEl?.classList.remove("hover");
    hoverEl = el; hoverSince = t; armed = true;
    el?.classList.add("hover");
  }
  // Hold to press. Each key keeps its own fill. The key under the cursor fills, and a key you have left
  // drains slowly in the background, so a brief slip costs little and coming back picks up where it was.
  // A key you move to starts filling at once: it never waits for the last one to empty.
  const dtHold = Math.min(120, Math.max(0, t - holdT)); holdT = t;
  let progress = 0;
  if (!calibrating && holdToPress && !study.capture) {
    if (holdEl && !holdEl.isConnected) { holdEl = null; holdP = 0; }
    if (hoverEl !== holdEl) {
      if (holdEl && holdP > 0) fading.set(holdEl, { p: holdP, x: holdAt.x, y: holdAt.y, n: holdAt.n });
      const back = hoverEl ? fading.get(hoverEl) : null;
      if (back) fading.delete(hoverEl);
      holdEl = hoverEl; holdP = back ? back.p : 0;
      holdAt.x = back ? back.x : 0; holdAt.y = back ? back.y : 0; holdAt.n = back ? back.n : 0;
    }
    for (const [el, f] of fading) {
      f.p -= dtHold / (DWELL * HOLD_DRAIN);
      if (f.p <= 0 || !el.isConnected) { setFill(el, 0); fading.delete(el); } else setFill(el, f.p);
    }
    // A key that was just pressed stays quiet until the cursor has clearly left it, so wobble on its edge cannot repeat it.
    if (pressedEl) {
      if (hoverEl === pressedEl) offSince = null;
      else if (offSince == null) offSince = t;
      else if (t - offSince > REARM_MS) pressedEl = null;
    }
    const quiet = hoverEl === pressedEl && hoverEl?.dataset.key !== "⌫";
    if (holdEl && !quiet) {
      // The fill runs at full speed while the head has settled and slows while it is still moving, so a key
      // you are crossing, or drifting onto on the way to its neighbour, barely fills. It never stops outright:
      // with a strong tremor the fill is slower, not stuck (a hard stop stalled keys in the tremor run).
      const then = history.find((h) => t - h.t <= STILL_MS) || history[history.length - 1];
      const moved = then ? Math.hypot(x - then.x, y - then.y) / keyWidth : 0;
      const rate = moved <= STILL_MOVE ? 1 : Math.max(MOVING_RATE, 1 - ((moved - STILL_MOVE) / (FAST_MOVE - STILL_MOVE)) * (1 - MOVING_RATE));
      // Keys that change things instead of typing (shift, undo, fix, send and the like) take half as long again.
      holdP += (rate * dtHold) / (DWELL * (SLOW_KEYS.has(holdEl.dataset.key) ? SLOW_HOLD : 1));
      holdAt.x += rate * x; holdAt.y += rate * y; holdAt.n += rate;
    }
    if (holdEl && holdP >= 1) {
      const r = holdEl.getBoundingClientRect();
      // The press is read from the average spot the cursor rested on while the key filled.
      const px = holdAt.n ? holdAt.x / holdAt.n : x, py = holdAt.n ? holdAt.y / holdAt.n : y;
      holdAt.x = holdAt.y = holdAt.n = 0;
      press(holdEl, Math.min(r.right, Math.max(r.left, px)), Math.min(r.bottom, Math.max(r.top, py)), true);
      pressedEl = holdEl; offSince = null;   // backspace is the one key that repeats while you stay on it
      holdP = 0; hoverSince = t;
    }
    progress = Math.max(0, Math.min(1, holdP));
    setFill(holdEl, progress);
  } else if (holdEl || fading.size) {
    setFill(holdEl, 0); holdEl = null; holdP = 0;
    for (const el of fading.keys()) setFill(el, 0);
    fading.clear();
  }
  const locked = !calibrating && isLocked(t);
  if (lockedEl && (lockedEl !== hoverEl || !locked)) { lockedEl.classList.remove("locked"); lockedEl = null; }
  if (locked && hoverEl && lockedEl !== hoverEl) { lockedEl = hoverEl; lockedEl.classList.add("locked"); }
  pointer.steady = locked ? LOCK_STEADY : 1;
  $("ring").style.strokeDashoffset = String(100.5 * (1 - progress));
}

// =====================================================================================
// Mouse mode: the head moves the real cursor over the whole screen. A nod clicks (so does the
// press move), two quick head shakes the same way switch apps, and the keyboard comes back
// by itself when a text box takes the focus. The window shrinks to a small dock.
// =====================================================================================
const SHAKE_AMP = 0.2;                 // a shake swings at least this much of your calibrated left-right range
const SHAKE_MS = 420;                  // out and back within this long
const SHAKE_PAIR_MS = 1300;            // two shakes the same way within this long switch apps
const CLICK_BACK_MS = 350;             // a click lands where the cursor was this long before the nod
const TEXT_ROLES = /AXTextField|AXTextArea|AXSearchField|AXComboBox/;
// In a browser there is no desktop bridge. With ?sim=1 a stand-in records what would have happened.
const fakeDesk = { calls: [], mouse: async (...a) => { fakeDesk.calls.push(a); return { ok: true }; }, mode: async (m) => { fakeDesk.calls.push(["mode", m]); return { screen: { width: 1470, height: 956 } }; }, focusRole: async () => fakeDesk.role || "" };
const desk = out?.mode ? out : (params.get("sim") ? fakeDesk : null);
window.fourLooks.desk = fakeDesk;
let mode = "keyboard";
let screenSize = { width: 1470, height: 956 };
let autoShown = false;                 // the keyboard came up by itself because a text box took focus
const sent = [];                       // where the real cursor has been sent lately: { t, x, y }

async function setMode(next, why = "you") {
  if (!desk) { prompt("Mouse mode needs the desktop app."); return; }
  if (next === mode) return;
  mode = next;
  autoShown = next === "keyboard" && why === "text box";
  document.body.classList.toggle("mousemode", mode === "mouse");
  toggleMenu(false);
  const info = await desk.mode(mode, adminOn ? 0.9 : 0.56);
  if (info?.screen) screenSize = info.screen;
  record("mode", { mode, why });
  if (mode === "mouse") { $("cursor").style.display = "none"; sent.length = 0; shake.rest = null; }
  else requestAnimationFrame(() => { measure(); updatePrior(); });
}
window.fourLooks.setMode = setMode;

// The pointer is calibrated over the window. Stretch that same head range over the whole screen.
function driveMouse(p, t) {
  const x = Math.round(Math.min(1, Math.max(0, p[0])) * (screenSize.width - 1)), y = Math.round(Math.min(1, Math.max(0, p[1])) * (screenSize.height - 1));
  const last = sent[sent.length - 1];
  if (last && last.x === x && last.y === y) { last.t2 = t; return; }
  sent.push({ t, x, y });
  while (sent.length > 2 && t - sent[0].t > 1500) sent.shift();
  desk.mouse("move", x, y);
}
// A nod dips the cursor before it is recognised, so click where the cursor was just before.
let lastClickAt = 0;
function clickAtRest(how, backMs = CLICK_BACK_MS) {
  const now = performance.now();
  if (now - lastClickAt < 450) return;                // one move, one click
  const before = [...sent].reverse().find((s) => s.t <= now - backMs) || sent[0];
  if (!before) return;
  lastClickAt = now;
  tick();
  record("click", { how, x: before.x, y: before.y });
  desk.mouse("move", before.x, before.y).then(() => desk.mouse("click", "left", 1));
  const d = $("dock"); d.classList.remove("clicked"); void d.offsetWidth; d.classList.add("clicked");
}
// A quick opening of the mouth clicks. The jaw moves without turning the head, so the cursor stays put.
const MOUTH_OPEN = 0.35;               // jaw-open score that counts as a deliberate opening (talking stays near 0.2)
const MOUTH_MS = 60;                   // held this long, so one noisy frame cannot click
const MOUTH_BACK_MS = 150;             // click where the cursor was just before the mouth opened
const mouth = { since: null, fired: false };
function detectMouthClick(f) {
  if ((f.scores.jawOpen || 0) <= MOUTH_OPEN) { mouth.since = null; mouth.fired = false; return; }
  if (mouth.since == null) mouth.since = f.t;
  if (!mouth.fired && f.t - mouth.since >= MOUTH_MS) { mouth.fired = true; if (!grok.busy) clickAtRest("mouth", MOUTH_BACK_MS); }
}
// Two quick shakes the same way: next app (right) or previous app (left).
const shake = { rest: null, state: "rest", since: 0, peak: 0, last: null };
function detectShake(f) {
  const raw = pointer.raw(f.pose, 1);
  if (!raw) return;
  const x = raw[0];
  if (shake.rest == null) { shake.rest = x; return; }
  const dx = x - shake.rest;
  if (shake.state === "rest") {
    if (Math.abs(dx) > 0.08) { shake.state = "out"; shake.since = f.t; shake.peak = dx; }
    else shake.rest += 0.15 * (x - shake.rest);
    return;
  }
  if (Math.abs(dx) > Math.abs(shake.peak)) shake.peak = dx;
  if (f.t - shake.since > SHAKE_MS) { shake.state = "rest"; shake.rest = x; return; }          // a real move, not a shake
  if (Math.abs(shake.peak) >= SHAKE_AMP && Math.abs(dx) < 0.35 * Math.abs(shake.peak)) {
    const dir = Math.sign(shake.peak);
    shake.state = "rest";
    if (grok.busy) { shake.last = null; if (grok.confirm != null) answerGrok(false); else stopGrok("shake"); return; }   // a shake says no, or stops Grok
    if (shake.last && shake.last.dir === dir && f.t - shake.last.t < SHAKE_PAIR_MS) {
      shake.last = null;
      tick();
      record("switch-app", { dir: dir > 0 ? "next" : "previous" });
      desk.mouse("key", 48, dir > 0 ? ["cmd"] : ["cmd", "shift"]);                               // Command+Tab
    } else shake.last = { dir, t: f.t };
  }
}
// The keyboard comes up by itself when a text box takes the focus.
let lastRole = "";
setInterval(async () => {
  if (!desk || mode !== "mouse" || calibrating || grok.busy) return;
  const role = await desk.focusRole();
  const isText = TEXT_ROLES.test(role);
  if (isText && !TEXT_ROLES.test(lastRole)) setMode("keyboard", "text box");
  lastRole = role;
}, 900);

// ---------- Grok does it: the sentence in the text box becomes a task on the computer ----------
// The window shrinks to the dock so Grok can see and use the whole screen. The head does not move
// the cursor while Grok works. A nod answers yes, a shake answers no, or stops Grok if it asked nothing.
const grok = { busy: false, confirm: null };
const dockHint = (text) => { const h = document.querySelector("#dock .hint"); if (h) h.textContent = text; };
const DOCK_IDLE = "open your mouth to click · shake twice to switch apps";
const fakeAgent = { runs: [], run: async (goal) => { fakeAgent.runs.push(goal); await sleep(300); return { ok: true, steps: 1, summary: `sim: ${goal}`, routed: true, modelCalls: 0, totalMs: 300 }; } };
window.fourLooks.agent = fakeAgent;
function answerGrok(yes) {
  if (grok.confirm == null) return;
  const id = grok.confirm; grok.confirm = null;
  tick();
  record("grok-answer", { yes });
  dockHint(yes ? "Grok: going ahead." : "Grok: not doing that.");
  out?.agentAnswer?.(id, yes);
}
function stopGrok(why) {
  if (!grok.busy) return;
  record("grok-stop", { why });
  dockHint("Stopping Grok.");
  out?.agentStop?.();
}
out?.onAgent?.((ev) => {
  if (!grok.busy) return;
  if (ev.type === "confirm") {
    grok.confirm = ev.id; tick(); dockHint(`${ev.text}  Nod or ${CUES[cueCfg.cue].name} = yes. Shake = no.`);
    if (grokAuto != null) setTimeout(() => answerGrok(grokAuto), 400);      // self-test only: no face to nod
  }
  else if (ev.type === "step") {
    dockHint(ev.action === "thinking" ? "Grok is thinking." : `Grok: ${ev.reason || ev.action}`);
    if (ev.action !== "thinking") record("grok-step", { action: ev.action, reason: String(ev.reason || "").slice(0, 120) });
  }
});
// A held frown (or the eye icon) makes Grok listen. The text box becomes the command line and the
// send key becomes "do it". Nothing typed here goes to the app in front. The same frown again cancels.
const QUICK = ["open gmail", "help", "search for", "mouse mode", "calibrate"];      // shown bold first, then outward
let grokMode = false, grokStash = "", grokFrom = "keyboard";
// Grok wakes on a deliberate lowering of the eyebrows (a frown), held for a moment. Blinks and nods came
// first and both failed him: blink bursts woke it by accident, and his own blinks and nods were not always
// seen. Nothing is assumed about his face: a four second lesson measures his resting brow level and his
// deliberate frown, and until that lesson succeeds the frown does nothing (the eye icon and the Grok tile
// still work). A wake needs, in order: a relaxed face, then a rise most of the way to his own frown, kept
// there for the hold. A face that was already frowning when tracking began, came back, or finished
// calibrating cannot wake it. The three dots under the eye fill while the hold builds.
const FROWN_KEY = "fourlooks.frown.v1";
const FROWN_START = 0.6;               // a frown begins this far from his resting level toward his taught frown
const FROWN_KEEP = 0.35;               // and the face counts as relaxed again below this
const FROWN_HOLD_MS = 450;             // held this long to wake Grok
const FROWN_CANCEL_MS = 1000;          // and this long to cancel or stop it, so a frown of concentration while typing a command does not throw it away
const FROWN_GAP_MS = 80;               // the hold must stay above the start level: dips shorter than this are forgiven
const FROWN_ARM_MS = 300;              // relaxed this long before a frown can begin
const FROWN_WARMUP_MS = 4000;          // nothing counts until the face has been tracked this long
const FROWN_DRIFT = 0.1;               // the resting level may drift this far from the taught one, no further
const FROWN_QUIET_MS = 300;            // closing the eyes pulls the brows down: ignored during and just after
let frownCfg = (() => { try { const v = JSON.parse(localStorage.getItem(FROWN_KEY)); return v && typeof v.rest === "number" ? v : null; } catch { return null; } })();
const frown = { base: frownCfg ? frownCfg.rest : 0.1, since: null, lastHigh: 0, fired: false, armed: false, relaxedSince: null, faceSince: null, lostAt: null, quietUntil: 0, level: 0 };
let dotsTimer = 0;
const browDown = (f) => ((f.scores.browDownLeft || 0) + (f.scores.browDownRight || 0)) / 2;
function showDots(n) { [...document.querySelectorAll("#grokbtn .blinks i")].forEach((el, i) => el.classList.toggle("on", i < n)); }
function frownLevels() {
  const span = Math.max(0.12, frownCfg.firm - frownCfg.rest);
  const drift = Math.max(-FROWN_DRIFT, Math.min(FROWN_DRIFT, frown.base - frownCfg.rest));
  return { high: frownCfg.rest + drift + FROWN_START * span, low: frownCfg.rest + drift + FROWN_KEEP * span };
}
// Forget any frown in progress. The face has to be seen relaxed again before the next one can begin.
function frownReset() {
  if (frown.since != null) { clearTimeout(dotsTimer); showDots(0); }
  frown.since = null; frown.fired = false; frown.armed = false; frown.relaxedSince = null;
}
function detectFrown(f, shut) {
  if (frown.faceSince == null) frown.faceSince = f.t;
  frown.lostAt = null;
  const v = (frown.level = browDown(f));
  if (!frownCfg || !frownCfg.ok) return;                          // not taught yet, or his frown could not be seen
  if (shut) frown.quietUntil = f.t + FROWN_QUIET_MS;
  if (f.t < frown.quietUntil || f.t - frown.faceSince < FROWN_WARMUP_MS) { frownReset(); return; }
  const { high, low } = frownLevels();
  if (frown.since == null) {
    if (v < high) frown.base += 0.02 * (v - frown.base);         // the resting level follows slowly, within FROWN_DRIFT
    if (v < low) {
      if (frown.relaxedSince == null) frown.relaxedSince = f.t;
      if (f.t - frown.relaxedSince >= FROWN_ARM_MS) { frown.armed = true; frown.fired = false; }
    } else frown.relaxedSince = null;
    if (!frown.armed || v <= high) return;
    frown.since = f.t; frown.lastHigh = f.t;
    clearTimeout(dotsTimer);
  }
  if (v > high) frown.lastHigh = f.t;
  if (v < low || f.t - frown.lastHigh > FROWN_GAP_MS) { frownReset(); return; }      // relaxed, or sagged below the start level
  if (frown.fired) return;                                        // one action per frown: relax before the next one counts
  const need = grokMode || grok.busy ? FROWN_CANCEL_MS : FROWN_HOLD_MS;
  const held = f.t - frown.since;
  showDots(Math.min(3, 1 + Math.floor((3 * held) / need)));
  if (held < need) return;
  frown.fired = true;
  dotsTimer = setTimeout(() => showDots(0), 500);
  if (grok.busy) { stopGrok("frown"); return; }
  if (calibrating || !typer) return;
  toggleGrokMode("frown");
}
// The lesson: two seconds relaxed, two seconds frowning. Sets where a frown starts for this face.
let frownAsked = false;
async function teachFrown() {
  if (!lastFrame || calibrating || grok.busy) return;
  frownAsked = true;
  if (grokMode) exitGrokMode();
  toggleMenu(false);
  calibrating = true;
  $("cursor").style.display = "none";
  const collect = async (ms) => {
    const xs = [];
    const w = (f) => { if (f.face) xs.push(browDown(f)); };
    watchers.add(w); await sleep(ms); watchers.delete(w);
    return xs.sort((x, y) => x - y);
  };
  prompt("Teaching Grok your frown. First relax your face.", true);
  await sleep(700);
  const rest = await collect(1500);
  prompt("Lower your eyebrows and hold now.", true);
  await sleep(600);
  const firm = await collect(2000);
  const r = rest.length ? rest[Math.floor(rest.length * 0.5)] : null, fm = firm.length ? firm[Math.floor(firm.length * 0.7)] : null;
  const ok = r != null && fm != null && fm - r >= 0.12;
  frownCfg = { rest: +(r ?? 0.1).toFixed(3), firm: +(fm ?? 0.1).toFixed(3), ok };
  store(FROWN_KEY, frownCfg);
  record("frown-teach", frownCfg);
  frown.base = frownCfg.rest;
  frownReset();
  calibrating = false;
  refreshMenu();
  prompt(ok ? "Got it. Lower your eyebrows and hold half a second to wake Grok."
    : "I could not see your frown clearly. Use the eye icon or the Grok tile in the dots menu, or choose Teach frown to try again.");
}
setInterval(() => {           // the first time the app is ready and no frown has been taught, teach it
  if (frownCfg || frownAsked || !usingCamera || !lastFrame?.face || !pointer.ready || calibrating || study.capture || params.get("study") || mode !== "keyboard" || grokMode || grok.busy || !typer) return;
  teachFrown();
}, 1500);
window.fourLooks.frown = () => ({ level: +frown.level.toFixed(2), taught: !!frownCfg?.ok, rest: frownCfg?.rest ?? null, firm: frownCfg?.firm ?? null, ...(frownCfg?.ok ? Object.fromEntries(Object.entries(frownLevels()).map(([k, x]) => [k, +x.toFixed(2)])) : {}), armed: frown.armed });
window.fourLooks.frownReset = frownReset;
window.fourLooks.exitGrok = () => { if (grokMode) exitGrokMode(); };
async function enterGrokMode(why) {
  if (grokMode || grok.busy || calibrating || !typer) return;
  grokFrom = mode;
  if (mode === "mouse") await setMode("keyboard", "grok");
  toggleMenu(false);
  typer.commitWord(); grokStash = typer.committed; typer.clear();      // what you were writing waits, untouched
  grokMode = true; typer.autoSpace = false;      // commands can hold web addresses
  document.body.classList.add("grokcmd");
  record("grok-mode", { on: true, why });
  tick();
  prompt("GROK IS LISTENING. This is not typed into your app. Type what you want done, press do it. Hold a frown one second to cancel.", false, true);
  updateKeys(); renderText(); updatePrior();
}
function exitGrokMode() {
  if (!grokMode) return;
  grokMode = false; typer.autoSpace = true;
  document.body.classList.remove("grokcmd");
  typer.clear(); typer.committed = grokStash; grokStash = "";
  updateKeys(); renderText(); updatePrior();
}
function toggleGrokMode(why) {
  if (grok.busy) { stopGrok(why); return; }
  if (!grokMode) { enterGrokMode(why); return; }
  exitGrokMode();
  record("grok-mode", { on: false, why });
  prompt("Grok cancelled.");
  if (grokFrom === "mouse") setMode("mouse", "grok cancelled");
}
window.fourLooks.grokMode = () => grokMode;
window.fourLooks.setting = (id) => runSetting(id);
window.fourLooks.away = () => awayNow;
window.fourLooks.hold = () => ({ key: holdEl?.dataset.key || null, p: +holdP.toFixed(2), pressed: pressedEl?.dataset.key || null, fading: [...fading].map(([el, f]) => [el.dataset.key, +f.p.toFixed(2)]), dwell: DWELL });
// Things the app does itself, at once, with no model: say them to Grok or pick them from the top row.
const APP_COMMANDS = [
  [/^(help|guide|what can (you|i) do)$/i, () => toggleHelp(true)],
  [/^(re)?calibrate$/i, () => calibrate()],
  [/^(teach|learn) (my )?frown$/i, () => teachFrown()],
  [/^(mouse|mouse mode|use the mouse)$/i, () => setMode("mouse")],
  [/^(boxes|box|box keys|big keys)$/i, () => setLayout("big")],
  [/^(qwerty|normal keyboard)$/i, () => setLayout("abc")],
  [/^(head|head keys|head layout)$/i, () => setLayout("head")],
  [/^(next |change )?theme$/i, () => { runSetting("theme"); prompt(`Theme: ${theme}`); }],
  [/^tune( to me)?$/i, () => startStudy("tune")],
  [/^(hold|hold to press)$/i, () => { runSetting("hold"); prompt(`Hold to press is ${holdToPress ? "on" : "off"}.`); }],
  [/^(quit|close four looks)$/i, () => out?.quit?.()],
];
function quickCommand(cmd) {
  tick();
  typer.clear(); typer.committed = /\bfor$/.test(cmd) ? `${cmd} ` : cmd;
  if (/\bfor$/.test(cmd)) { updateKeys(); renderText(); updatePrior(); prompt("Now type what to search for, then press do it."); return; }
  runGrok();
}
async function runGrok() {
  if (grok.busy) return;
  typer.commitWord();
  const goal = typer.text().trim();
  if (!goal) { prompt("Type what you want done, then press do it. Or pick one on top."); return; }
  const back = grokFrom;
  const local = APP_COMMANDS.find(([re]) => re.test(goal.replace(/[.!?]+$/, "")));
  if (local) { record("grok-local", { goal }); exitGrokMode(); local[1](); return { ok: true, local: true }; }
  const run = out?.agentRun || (params.get("sim") ? fakeAgent.run : null);
  if (!run || !desk) { prompt("Grok control needs the desktop app."); return { ok: false, stoppedWhy: "needs the desktop app" }; }
  exitGrokMode();
  grok.busy = true; grok.confirm = null;
  record("grok", { goal });
  const t0 = performance.now();
  let r;
  try {
    await setMode("mouse", "grok");
    document.body.classList.add("grokmode");
    await desk.mode("grok");
    dockHint("Grok is thinking.");
    r = await run(goal);
  } catch (err) { r = { ok: false, stoppedWhy: String(err?.message || err) }; }
  const sec = ((r.totalMs ?? performance.now() - t0) / 1000).toFixed(1);
  record("grok-end", { ok: !!r.ok, sec: +sec, steps: r.steps ?? 0, modelCalls: r.modelCalls ?? null, routed: !!r.routed, why: r.stoppedWhy || "" });
  grok.busy = false; grok.confirm = null;
  document.body.classList.remove("grokmode");
  const said = r.ok ? `Grok, ${sec} s: ${r.summary || "done"}` : `Grok stopped: ${r.stoppedWhy || "no result"}`;
  if (back === "mouse") {                       // it was woken from the dock: stay there and say the result there
    await desk.mode("mouse");
    dockHint(said);
    setTimeout(() => { if (!grok.busy) dockHint(DOCK_IDLE); }, 5000);
  } else {
    dockHint(DOCK_IDLE);
    await setMode("keyboard", "grok done");
    prompt(said);
  }
  return r;
}
window.fourLooks.runGrok = runGrok;
// The desktop app's self-test runs a goal through the very same path as the frown and "do it":
// Grok mode, the command line, the dock, the agent, and back. autoAnswer stands in for the nod.
let grokAuto = null;
window.fourLooks.grokGoal = async (goal, autoAnswer = null) => {
  grokAuto = autoAnswer;
  const steps = [];
  const watch = (ev) => { if (ev.type === "step" && ev.action !== "thinking") steps.push(ev.reason || ev.action); if (ev.type === "confirm") steps.push(`ASKED: ${ev.text}`); };
  out?.onAgent?.(watch);
  await enterGrokMode("self-test");
  typer.clear(); typer.committed = goal;
  const result = await runGrok();
  grokAuto = null;
  return { result, steps, dock: document.querySelector("#dock .hint")?.textContent, prompt: $("prompt").textContent, mode, grokMode };
};

// ---------- nod: a quick, clear dip and return of the head accepts the grey guess ----------
// Measured in the person's own calibrated range (not screen pixels), so moving down a key row or
// two never counts: a nod has to dip at least NOD_AMP of that range and be back within NOD_MS.
const nod = { rest: null, restX: null, state: "rest", since: 0, peak: 0, last: 0 };
let nodCount = 0;                      // nods recognised this session, for the test suite
window.fourLooks.nods = () => nodCount;
function detectNod(f) {
  const raw = pointer.raw(f.pose, 1);
  if (!raw) return;
  const [x, y] = raw;
  if (nod.rest == null) { nod.rest = y; nod.restX = x; return; }
  const dy = y - nod.rest;
  if (nod.state === "rest") {
    if (dy > NOD_START && f.t - nod.last > 400) { nod.state = "dip"; nod.since = f.t; nod.peak = dy; }
    else { nod.rest += 0.15 * (y - nod.rest); nod.restX += 0.15 * (x - nod.restX); }
    return;
  }
  nod.peak = Math.max(nod.peak, dy);
  // A nod may wander sideways by half its own depth, and never less than 0.12 of the range: his head
  // wobbles about 0.07 of the range side to side at rest, which used to cancel a nod as it began.
  const sideways = Math.abs(x - nod.restX) > Math.max(0.5 * nod.peak, 0.12);
  if (f.t - nod.since > NOD_MS || sideways) { nod.state = "rest"; nod.rest = y; nod.restX = x; return; }   // a real move
  if (nod.peak >= NOD_AMP && dy < 0.35 * nod.peak) { nod.state = "rest"; nod.last = f.t; nodCount++; acceptGhost("nod"); return; }
  // A small blip that has already come back up was tremor, not the start of a nod. Go straight back to
  // waiting, so it cannot block a real nod that begins a moment later (it used to hold the detector for
  // up to half a second, and a nod that started inside that window was missed).
  if (nod.peak < NOD_AMP && dy < 0.5 * NOD_START) nod.state = "rest";
}

// ---------- shake: one quick left-right flick of the head steps the grey guess to the next option ----------
const FLICK_AMP = 0.2, FLICK_MS = 420;
const flick = { rest: null, state: "rest", since: 0, peak: 0, last: 0 };
function detectFlick(f) {
  const raw = pointer.raw(f.pose, 1);
  if (!raw || study.capture || mode !== "keyboard") return;
  const x = raw[0];
  if (flick.rest == null) { flick.rest = x; return; }
  const dx = x - flick.rest;
  if (flick.state === "rest") {
    if (Math.abs(dx) > 0.08 && f.t - flick.last > 600) { flick.state = "out"; flick.since = f.t; flick.peak = dx; }
    else flick.rest += 0.15 * (x - flick.rest);
    return;
  }
  if (Math.abs(dx) > Math.abs(flick.peak)) flick.peak = dx;
  if (f.t - flick.since > FLICK_MS) { flick.state = "rest"; flick.rest = x; return; }            // a real move
  if (Math.abs(flick.peak) >= FLICK_AMP && Math.abs(dx) < 0.35 * Math.abs(flick.peak)) {
    flick.state = "rest"; flick.last = f.t;
    if (freshFix && f.t - freshFix.at < FIX_SHAKE_MS && keepFix("shake")) return;      // a shake right after an autocorrect says no to it
    const g = typer?.ghost();
    if (g && g.options > 1) { typer.nextGhost(); tick(); record("ghost-next", {}); renderText(); }
  }
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
  if (f.face && !calibrating && !study.capture) detectFrown(f, shut);
  else {
    frownReset();                                     // anything in progress is dropped, and the face must be seen relaxed again
    if (!f.face) {                                    // a brief dropout keeps the warm-up, a real absence restarts it
      if (frown.lostAt == null) frown.lostAt = f.t;
      else if (f.t - frown.lostAt > 2000) frown.faceSince = null;
    }
  }
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
  if (mode === "mouse") {
    if (!closing && !grok.busy) { const p = pointer.point(f.pose, f.t); if (p) driveMouse(p, f.t); }   // Grok has the cursor while it works
    detectMouthClick(f);
    detectShake(f);
  } else if (!closing) {
    const p = pointer.point(f.pose, f.t);
    if (p) movePointer(p[0] * innerWidth, p[1] * innerHeight, f.t, pointer.past);
  } else if (cursorAt) movePointer(cursorAt[0], cursorAt[1], f.t);
  detectNod(f);
  detectFlick(f);
  if (f.t - lastTrace > 100) {                 // a light trace of every session: where the cursor is, where the head points, what is selected
    lastTrace = f.t;
    record("p", { x: Math.round(cursorAt?.[0] ?? -1), y: Math.round(cursorAt?.[1] ?? -1), yaw: +f.pose[0].toFixed(4), pitch: +f.pose[1].toFixed(4), on: hoverEl ? (hoverEl.dataset.word ? "chip" : hoverEl.dataset.key) : "", c: +c.toFixed(2), b: +browDown(f).toFixed(2) });
  }
  study.watchers.forEach((w) => w(f, { cursor: cursorAt, score: c }));
  if (cueCfg.calibrated && c > cueCfg.thr) {
    if (blinkSince == null) blinkSince = f.t;
    const target = intended(blinkSince);       // where you were when the press move started
    if (!blinkFired && f.t - blinkSince > cueCfg.ms && study.capture) { blinkFired = true; study.onPress?.(performance.now()); }
    if (!blinkFired && f.t - blinkSince > cueCfg.ms && mode === "mouse") {
      blinkFired = true;
      if (grok.busy) { if (grok.confirm != null) answerGrok(true); }      // his nod is not always seen: the press move also says yes
      else clickAtRest("press move");
    }
    if (!blinkFired && f.t - blinkSince > cueCfg.ms + pressExtra && target) {
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
let tuned = { name: "medium", smoothing: { aMin: 0.05, band: 0.010, full: 0.04, deadzone: 0.003 } };
try { const t = JSON.parse(localStorage.getItem(TUNE_KEY)); if (t?.smoothing?.aMin) { tuned = t; pointer.smoothing(t.smoothing); } } catch { /* keep defaults */ }
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
    hover: hoverEl ? (hoverEl.dataset.word || hoverEl.dataset.key) : "", lock: lockShare(f.t),
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
function setLayout(name) {
  if (!LETTER_LAYOUTS.includes(name)) return;
  letters = name; layer = name;
  store(LAYOUT_KEY, letters);
  record("layout", { letters });
  buildKeys(); renderText(); updatePrior();
  prompt(name === "big" ? "Boxes: press the box that holds your letter. The word is worked out for you." : `Keys: ${LAYOUT_NAME[name]}.`);
}
const HELP_KEY = "fourlooks.help.v1";
const HELP_HTML = `<div class="help">
  <section><h3>Type</h3><ul>
    <li>Point your nose at a key.</li>
    <li>Hold still on it to press. After a third of the hold the key locks.</li>
    <li>The bold word on top is the best guess. Press it to take it.</li>
    <li>Nod takes the grey word. Nod twice takes the phrase.</li>
    <li>One quick shake shows the next guess.</li>
  </ul></section>
  <section><h3>Fix</h3><ul>
    <li>Undo steps back. The arrow key deletes.</li>
    <li>Eyes closed 1 second puts the cursor back in the middle.</li>
    <li>Eyes closed 3 seconds calibrates again.</li>
    <li>Fix asks Grok to check the sentence.</li>
  </ul></section>
  <section><h3>Grok</h3><ul>
    <li>Lower your eyebrows and hold half a second. The eye lights up.</li>
    <li>Type what you want, or pick one on top.</li>
    <li>Press do it. Try: open gmail.</li>
    <li>Nod is yes. Shake is no, or stop.</li>
    <li>Also works: help, calibrate, mouse mode, boxes, qwerty, theme, quit.</li>
  </ul></section>
  <section><h3>Mouse</h3><ul>
    <li>Press mouse. Your head moves the real cursor.</li>
    <li>Open your mouth quickly to click.</li>
    <li>Shake twice the same way to switch apps.</li>
    <li>The keyboard comes back in a text box.</li>
    <li>Quit: the dots menu, or Control Option Q.</li>
  </ul></section>
</div>`;
let helpOpen = false;
function toggleHelp(open = !helpOpen) {
  helpOpen = open;
  buildMenu();
  toggleMenu(open);
  if (open) store(HELP_KEY, true);
  record("help", { open });
}
const SETTINGS = [
  { id: "help", label: "Help", value: () => "how it all works", run: () => toggleHelp(true) },
  { id: "frown", label: "Teach frown", value: () => (frownCfg?.ok ? "wakes Grok" : frownCfg ? "not seen, try again" : "not taught"), run: () => { toggleMenu(false); teachFrown(); } },
  { id: "grok", label: "Grok", value: () => "or frown and hold", run: () => { toggleMenu(false); enterGrokMode("menu"); } },
  { id: "mouse", label: "Mouse mode", value: () => "head moves the cursor", run: () => { toggleMenu(false); setMode("mouse"); } },
  { id: "theme", label: "Theme", value: () => theme, run: () => { theme = cycle(THEMES, theme); store("fourlooks.theme.v1", theme); applyTheme(); } },
  { id: "cue", label: "Press with", value: () => CUES[cueCfg.cue].name, run: () => {
    cueCfg = { ...DEFAULT_CUE, cue: cycle(CUE_ORDER, cueCfg.cue) }; store(CUE_KEY, cueCfg);
    prompt(`Press move is now ${CUES[cueCfg.cue].name}. Choose Calibrate to fit it to you.`);
  } },
  { id: "presshold", label: "Press hold", value: () => pressName, run: () => { const names = Object.keys(PRESS_STEPS); pressName = names[(names.indexOf(pressName) + 1) % names.length]; pressExtra = PRESS_STEPS[pressName]; store(PRESS_KEY, pressName); } },
  { id: "layout", label: "Key layout", value: () => LAYOUT_NAME[letters], run: () => setLayout(LETTER_LAYOUTS[(LETTER_LAYOUTS.indexOf(letters) + 1) % LETTER_LAYOUTS.length]) },
  { id: "reach", label: "Head reach", value: () => `${pointer.gain}x`, run: () => { pointer.gain = REACH_STEPS.includes(pointer.gain) ? cycle(REACH_STEPS, pointer.gain) : 1; store(REACH_KEY, pointer.gain); } },
  { id: "dwell", label: "Hold time", value: () => `${DWELL / 1000} s`, run: () => { DWELL = DWELL_STEPS[(DWELL_STEPS.indexOf(DWELL) + 1) % DWELL_STEPS.length]; store(DWELL_KEY, DWELL); holdP = 0; } },
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
  $("menu").classList.toggle("helping", helpOpen);
  if (helpOpen) {
    $("menu").innerHTML = `${HELP_HTML}<div class="tile wide" data-key="set:helpclose" style="--i:0"><span class="name">Got it</span><span class="val">back to the keyboard</span></div>`;
    return;
  }
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
  if (!open && helpOpen) { helpOpen = false; buildMenu(); }
  document.body.classList.toggle("menu-open", open);
  history.length = 0;                       // old hover votes belong to the other layer
  record("menu", { open });
}
function runSetting(id) {
  if (id === "helpclose") { toggleHelp(false); return; }
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
    try { typer.used = new Map(JSON.parse(localStorage.getItem(USED_KEY)) || []); } catch { /* start fresh */ }
    usedSaved = typer.used.size;
    updatePrior();
    window.fourLooks.typer = typer;
    updateKeys(); renderText();
    prompt("Ready. The mouse works too.");
    startCamera();
  } catch (err) {
    prompt(`Word model failed to load: ${err.message}`);
  }
})();
