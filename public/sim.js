// A simulated face for testing the camera path without a camera (open the page with ?sim=1).
// It emits the same frames the real face engine does: head pose plus face scores, 30 a second,
// with human-like jitter. It "sees" the page like a person would: it turns toward the calibration
// dot and does the press move when the page asks for it.

const HZ = 33;
const POSE_X = 0.30, POSE_Y = 0.22;        // radians of head turn per screen width / height
const Q = new URLSearchParams(location.search);
const JITTER = Number(Q.get("noise") || 0.0012);   // radians of tremor (a real face measured nearer 0.004)
const LAG_MS = Number(Q.get("lag") || 0);          // camera pipeline delay to simulate, ms
const delayed = [];
const SPIKE = Number(Q.get("spike") || 0);         // chance per frame of a single-frame jump of 5 times the tremor
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A person corrects an aim, then waits to SEE the cursor answer before correcting again. With a camera
// delay the cursor answers late, so the wait is the delay plus a moment to notice. Correcting faster than
// the delay (as this used to, every 133 ms against a 150 ms delay) made the simulated head swing back and
// forth past the key, wider each time: in the 11:19 PM tremor run it swung 290 px around the E key.
const SEE_MS = Math.max(HZ * 4, LAG_MS + 100);
const AIM_OK = 0.3;       // close enough: the cursor is inside the middle 60% of the key
const gauss = () => Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random());

const SCORES = {
  smile: ["mouthSmileLeft", "mouthSmileRight"], blink: ["eyeBlinkLeft", "eyeBlinkRight"],
  mouth: ["jawOpen"], pucker: ["mouthPucker"], brows: ["browInnerUp"], frown: ["browDownLeft", "browDownRight"],
};

export function startSimFace(onFrame, { cueName = () => "smile" } = {}) {
  const head = { x: 0.5, y: 0.5 };          // where the face points, in screen units
  const level = { smile: 0, blink: 0, mouth: 0, pucker: 0, brows: 0, frown: 0 };
  let dip = 0;                              // extra downward pitch, for nods
  let auto = true;                          // follow calibration prompts like a person
  const DRIFT = Number(new URLSearchParams(location.search).get("drift") || 0);   // posture drift, radians per minute
  let driftStart = null;
  const LAZY = new URLSearchParams(location.search).get("lazy") === "1";

  setInterval(() => {
    if (auto) follow();
    const scores = {};
    for (const [name, keys] of Object.entries(SCORES)) for (const k of keys) scores[k] = Math.min(1, Math.max(0, level[name] + 0.04 + 0.015 * gauss()));
    const drift = level.smile > 0.3 ? 0.004 : 0;          // the head shifts a little during a smile
    // Slouching: once typing starts, the whole head slowly settles down and to one side.
    const bias = DRIFT && driftStart != null ? (DRIFT * (performance.now() - driftStart)) / 60000 : 0;
    const jump = () => (Math.random() < SPIKE ? 5 * JITTER * (Math.random() < 0.5 ? -1 : 1) : 0);
    const pose = [(0.5 - head.x) * POSE_X + 0.6 * bias + JITTER * gauss() + jump(), (0.5 - head.y - dip) * POSE_Y - drift - bias + JITTER * gauss() + jump()];
    if (LAG_MS > 0) {                           // the app sees the head as it was LAG_MS ago, like a real camera pipeline
      delayed.push({ at: performance.now(), pose, scores });
      while (delayed.length > 1 && performance.now() - delayed[1].at >= LAG_MS) delayed.shift();
      if (performance.now() - delayed[0].at < LAG_MS) return;
      onFrame({ t: performance.now(), head: [0, 0], pose: delayed[0].pose, scores: delayed[0].scores, face: true });
      return;
    }
    onFrame({ t: performance.now(), head: [0, 0], pose, scores, face: true });
  }, HZ);

  // What a person does without being told: look at the dot, do the move when asked.
  let lastPrompt = "", steering = false;
  function follow() {
    const dot = document.getElementById("target");
    if (dot && dot.style.display === "block") {
      const tx = parseFloat(dot.style.left) / innerWidth, ty = parseFloat(dot.style.top) / innerHeight;
      head.x += 0.25 * (tx - head.x); head.y += 0.25 * (ty - head.y);
    }
    const box = document.getElementById("studybox");                 // the guided test's target box
    if (box && box.style.display === "block" && !steering) {
      const r = box.getBoundingClientRect(), c = window.fourLooks.cursor && window.fourLooks.cursor();
      const g = (window.fourLooks.reach && window.fourLooks.reach()) || 1;
      if (c) { head.x += (0.12 * ((r.left + r.width / 2) - c[0])) / innerWidth / g; head.y += (0.12 * ((r.top + r.height / 2) - c[1])) / innerHeight / g; }
    }
    const p = document.getElementById("prompt");
    const big = p && p.classList.contains("big");
    const text = p ? p.textContent : "";
    if (text !== lastPrompt) {
      lastPrompt = text;
      const turn = big && text.match(/Turn (left|right|up|down) as far/);
      if (turn) { const to = { left: [0.05, head.y], right: [0.95, head.y], up: [head.x, 0.05], down: [head.x, 0.95] }[turn[1]]; lookAt(to[0], to[1], 500); }
      if (big && /Back to the middle|hold still/.test(text)) lookAt(0.5, 0.6, 400);
      if (big && /^Nod now/.test(text)) nod();
      const typeIt = !big && text.match(/Type: (.+)$/);
      if (typeIt) { steering = true; type(typeIt[1] + " ").finally(() => { steering = false; }); }
      if (!big) return;
      if (/lower your eyebrows/i.test(text)) { cue("frown", 3200, 0.7); return; }      // the frown lesson, step 2
      if (/ now\.$/.test(text) && !/normally|relax/i.test(text)) cue(cueName(), 520);
      if (/talk a little|look around|blink normally/i.test(text)) chatter();
    }
  }
  async function chatter() {                              // everyday movement: small, short
    for (let i = 0; i < 6; i++) { level.mouth = 0.18; await sleep(120); level.mouth = 0; await sleep(500); }
  }

  async function lookAt(x, y, ms = 320) {
    const x0 = head.x, y0 = head.y, steps = Math.max(1, Math.round(ms / HZ));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps, e = k * k * (3 - 2 * k);
      head.x = x0 + (x - x0) * e; head.y = y0 + (y - y0) * e;
      await sleep(HZ);
    }
  }
  // Like a person: glance toward the key, then watch the cursor and steer until it sits on the key.
  // done: an optional check for "it has been pressed". A person stops adjusting the moment the key goes off.
  async function lookAtKey(key, miss = 0.12, done = null) {
    const el = findKey(key);
    if (!el) throw new Error(`no key ${key}`);
    const r = el.getBoundingClientRect();
    const tx = (r.left + r.width / 2 + miss * r.width * gauss()) / innerWidth, ty = (r.top + r.height / 2 + miss * r.height * gauss()) / innerHeight;
    await lookAt(tx, ty);
    for (let i = 0; i < 40; i++) {
      const c = window.fourLooks.cursor && window.fourLooks.cursor();
      if (!c || (done && done())) break;
      const ex = tx - c[0] / innerWidth, ey = ty - c[1] / innerHeight;
      if (Math.abs(ex) * innerWidth < r.width * AIM_OK && Math.abs(ey) * innerHeight < r.height * AIM_OK) break;
      if (LAZY && document.querySelector(".hover") === el) break;        // most people stop as soon as the key lights up
      const g = (window.fourLooks.reach && window.fourLooks.reach()) || 1;   // people adapt to how far the cursor travels
      // People correct an aim in one or two quick moves, not by creeping: most of the error at once.
      head.x += (0.6 * ex) / g; head.y += (0.6 * ey) / g;
      await sleep(SEE_MS);
    }
    await sleep(260);
  }
  async function cue(name = cueName(), ms = 380, strength = 0.8) {
    for (let i = 1; i <= 3; i++) { level[name] = (strength * i) / 3; await sleep(HZ); }
    await sleep(ms);
    for (let i = 2; i >= 0; i--) { level[name] = (strength * i) / 3; await sleep(HZ); }
    await sleep(220);
  }
  async function nod(depth = 0.42) {
    for (let i = 1; i <= 5; i++) { dip = (depth * i) / 5; await sleep(HZ); }
    for (let i = 4; i >= 0; i--) { dip = (depth * i) / 5; await sleep(HZ); }
    await sleep(300);
  }
  // One quick shake: out to the side and straight back.
  async function shake(dir = 1, size = 0.3) { const x0 = head.x; await lookAt(x0 + dir * size, head.y, 130); await lookAt(x0, head.y, 130); await sleep(180); }
  async function rowHop() { const y0 = head.y; await lookAt(head.x, y0 + 0.17, 160); await lookAt(head.x, y0, 160); await sleep(300); }
  // A person only does the press move once the key they want is highlighted.
  const tally = { presses: 0, reAims: 0, gaveUp: 0, wrongKey: 0 };
  // The keyboard's own keys come first, so the letter o means the O key, not a guess that happens to read "o".
  const findKey = (key) => {
    const all = [...document.querySelectorAll("#keys [data-key]"), ...document.querySelectorAll("[data-key]")];
    return all.find((e) => e.dataset.key === key) || all.find((e) => e.dataset.word === key)
      || (key.length === 1 ? all.find((e) => e.dataset.key.startsWith("g:") && e.dataset.key.slice(2).includes(key)) : undefined);   // big keys hold several letters
  };
  async function press(key) {
    if (driftStart == null) driftStart = performance.now();
    let aimed = false;
    for (let tries = 0; tries < 4 && !aimed; tries++) {
      await lookAtKey(key, tries ? 0.05 : 0.12);
      aimed = document.querySelector(".hover") === findKey(key);
      if (!aimed) tally.reAims++;
    }
    if (!aimed) tally.gaveUp++;
    // Effort: how far the head must be held away from where it would point with no drift.
    const g = (window.fourLooks.reach && window.fourLooks.reach()) || 1, c = window.fourLooks.cursor && window.fourLooks.cursor();
    if (c) (tally.holdOff ||= []).push(Math.round(Math.hypot((c[0] / innerWidth - (0.5 + g * (head.x - 0.5))) * innerWidth, (c[1] / innerHeight - (0.5 + g * (head.y - 0.5))) * innerHeight)));
    const n0 = window.fourLooks.log.length;
    await cue();
    tally.presses++;
    const got = window.fourLooks.log.slice(n0).find((e) => ["letter", "space", "symbol", "backspace", "undo", "setting", "pick", "speak", "menu"].includes(e.type));
    const want = key === "space" ? "space" : key.startsWith("set:") ? key.slice(4) : key;
    const gotKey = got ? (got.key || got.id || got.type) : "(nothing)";
    if (aimed && !(gotKey === want || (String(gotKey).startsWith("g:") && String(gotKey).includes(key)) || got?.type === want || (key === "menu" && got?.type === "menu"))) { tally.wrongKey++; (tally.misses ||= []).push(`${key}->${gotKey}`); }
  }
  async function type(text) {
    for (const ch of text) await press(ch === " " ? "space" : ch);
  }
  return { head, level, tally, lookAt, lookAtKey, cue, nod, shake, rowHop, press, type, sleep, setAuto: (v) => { auto = v; } };
}
