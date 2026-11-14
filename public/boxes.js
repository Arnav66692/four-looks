// Four Looks, Speed mode. Camera or arrow keys -> boxes -> decoder -> spoken sentence.
import { Decoder } from "/src/decoder.js";
import { Typer } from "/src/typer.js";
import { startFace } from "./face.js";
import { HeadModel, GestureReader, dist } from "./gestures.js";

const $ = (id) => document.getElementById(id);
const BOX_NAMES = ["up", "left", "right", "down"];
const KEY_BOX = { ArrowUp: 0, ArrowLeft: 1, ArrowRight: 2, ArrowDown: 3 };
const MODEL_KEY = "fourlooks.head.v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = [];
window.fourLooks = { log };
const record = (type, extra = {}) => log.push({ t: Date.now(), type, ...extra });

let typer = null;
let head = loadHead();
let reader = null;
let lastFrame = null;
const frameWatchers = new Set();

function loadHead() {
  try { const o = JSON.parse(localStorage.getItem(MODEL_KEY)); return o ? HeadModel.from(o) : new HeadModel(); }
  catch { return new HeadModel(); }
}
function saveHead() { try { localStorage.setItem(MODEL_KEY, JSON.stringify(head)); } catch { /* storage off */ } }

function prompt(text, big = false) { $("prompt").textContent = text; $("prompt").classList.toggle("big", big); }

function flash(box, probs) {
  document.querySelectorAll(".box").forEach((el, i) => {
    el.querySelector(".bar").style.width = probs ? `${Math.round(probs[i] * 100) * 0.9}%` : "0";
  });
  const el = $(`box${box}`);
  el.classList.add("hit");
  setTimeout(() => el.classList.remove("hit"), 260);
}

function render() {
  if (!typer) return;
  $("slots").innerHTML = typer.letters.map((p) => `<i class="${Math.max(...p) > 0.8 ? "sure" : ""}"></i>`).join("");
  const live = typer.liveGuesses(3);
  $("chips").innerHTML = live.map((w) => `<span>${w}</span>`).join("");
  const done = typer.top().map((w, i) => (typer.locked.has(i) ? `<span class="locked">${w}</span>` : w)).join(" ");
  $("sentence").innerHTML = `${done}${live[0] ? ` <span class="live">${live[0]}</span>` : ""}`;
  $("alts").innerHTML = typer.alternatives(3).slice(1).map((s) => `<li>${s}</li>`).join("");
}

function speak() {
  const text = typer.sentence();
  if (!text) return;
  record("speak", { text, words: typer.top().length });
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  prompt(`said: ${text}`);
  typer.clear();
  render();
}

function onBox(probs) {
  const box = probs.indexOf(Math.max(...probs));
  typer.box(probs);
  record("box", { probs: probs.map((p) => +p.toFixed(3)) });
  flash(box, probs);
  render();
}

function onEvent(e) {
  if (!typer) return;
  if (e.type === "box") onBox(e.probs);
  else if (e.type === "blink") { if (typer.endWord()) { record("word"); render(); } }
  else if (e.type === "mouth") { record("undo", { what: typer.undoOrNext() }); render(); }
  else if (e.type === "brows") speak();
}

window.addEventListener("keydown", (ev) => {
  if (!typer || calibrating) return;
  if (ev.key in KEY_BOX) { ev.preventDefault(); onBox([0, 1, 2, 3].map((i) => (i === KEY_BOX[ev.key] ? 1 : 0))); }
  else if (ev.key === " ") { ev.preventDefault(); onEvent({ type: "blink" }); }
  else if (ev.key === "Backspace") { ev.preventDefault(); if (ev.shiftKey) { typer.deleteWord(); render(); } else onEvent({ type: "mouth" }); }
  else if (ev.key === "Enter") { ev.preventDefault(); speak(); }
});

function drawDot(f) {
  const c = $("dot").getContext("2d");
  c.clearRect(0, 0, 120, 90);
  if (!f.head || !head.ready) return;
  const s = 60 / (head.reach * 1.6);
  const px = (v) => [60 - (v[0] - head.rest[0]) * s, 45 + (v[1] - head.rest[1]) * s];
  c.fillStyle = "#1f7a5c";
  head.protos.forEach((p) => { const [x, y] = px(p); c.fillRect(x - 3, y - 3, 6, 6); });
  c.strokeStyle = "#999"; c.beginPath(); c.arc(60, 45, head.reach * (2 / 3) * s, 0, 7); c.stroke();
  const [x, y] = px(f.head);
  c.fillStyle = "#b5532f"; c.beginPath(); c.arc(x, y, 5, 0, 7); c.fill();
}

function onFrame(f) {
  lastFrame = f;
  frameWatchers.forEach((w) => w(f));
  $("status").textContent = f.face ? (head.ready ? "tracking" : "tracking, not calibrated") : "no face";
  drawDot(f);
  if (reader && !calibrating) reader.frame(f);
}

// Calibration: rest, then each direction 3 times. Fits the per-person head model.
let calibrating = false;
async function collect(ms, pick) {
  const out = [];
  const w = (f) => { if (f.head) out.push(f.head); };
  frameWatchers.add(w);
  await sleep(ms);
  frameWatchers.delete(w);
  return pick(out);
}
async function calibrate() {
  if (!lastFrame) { prompt("start the camera first"); return; }
  calibrating = true;
  prompt("look at the middle and hold still", true);
  await sleep(1200);
  const rest = await collect(2000, (xs) => xs);
  const restMean = [rest.reduce((a, v) => a + v[0], 0) / rest.length, rest.reduce((a, v) => a + v[1], 0) / rest.length];
  const dirs = [[], [], [], []];
  for (let round = 0; round < 3; round++) {
    for (let b = 0; b < 4; b++) {
      prompt(`turn ${BOX_NAMES[b]}`, true);
      $(`box${b}`).classList.add("hit");
      const peak = await collect(1500, (xs) => xs.reduce((best, v) => (dist(v, restMean) > dist(best, restMean) ? v : best), restMean));
      $(`box${b}`).classList.remove("hit");
      dirs[b].push(peak);
      prompt("back to the middle", true);
      await sleep(900);
    }
  }
  head.fit(rest, dirs);
  saveHead();
  record("calibrate", { model: head.toJSON() });
  calibrating = false;
  prompt("ready. turn your head to type");
}

$("start").addEventListener("click", async () => {
  $("start").disabled = true;
  prompt("starting camera");
  try {
    await startFace($("video"), onFrame);
    reader = new GestureReader(head, onEvent);
    prompt(head.ready ? "ready. turn your head to type" : "press calibrate");
  } catch (err) {
    prompt(`camera failed: ${err.message}`);
    $("start").disabled = false;
  }
});
$("calibrate").addEventListener("click", () => { if (!calibrating) calibrate().then(() => { reader = new GestureReader(head, onEvent); }); });

(async () => {
  try {
    const model = await (await fetch("/lm.json")).json();
    typer = new Typer(new Decoder(model));
    window.fourLooks.typer = typer;
    prompt("arrow keys work now. start the camera for head control");
  } catch (err) {
    prompt(`word model failed to load: ${err.message}`);
  }
})();
