// A simulated face for testing the camera path without a camera (open the page with ?sim=1).
// It emits the same frames the real face engine does: head pose plus face scores, 30 a second,
// with human-like jitter. It "sees" the page like a person would: it turns toward the calibration
// dot and does the press move when the page asks for it.

const HZ = 33;
const POSE_X = 0.30, POSE_Y = 0.22;        // radians of head turn per screen width / height
const JITTER = 0.0012;                     // radians of tremor
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gauss = () => Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random());

const SCORES = {
  smile: ["mouthSmileLeft", "mouthSmileRight"], blink: ["eyeBlinkLeft", "eyeBlinkRight"],
  mouth: ["jawOpen"], pucker: ["mouthPucker"], brows: ["browInnerUp"],
};

export function startSimFace(onFrame, { cueName = () => "smile" } = {}) {
  const head = { x: 0.5, y: 0.5 };          // where the face points, in screen units
  const level = { smile: 0, blink: 0, mouth: 0, pucker: 0, brows: 0 };
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
    const pose = [(0.5 - head.x) * POSE_X + 0.6 * bias + JITTER * gauss(), (head.y + dip - 0.5) * POSE_Y + drift + bias + JITTER * gauss()];
    onFrame({ t: performance.now(), head: [0, 0], pose, scores, face: true });
  }, HZ);

  // What a person does without being told: look at the dot, do the move when asked.
  let lastPrompt = "";
  function follow() {
    const dot = document.getElementById("target");
    if (dot && dot.style.display === "block") {
      const tx = parseFloat(dot.style.left) / innerWidth, ty = parseFloat(dot.style.top) / innerHeight;
      head.x += 0.25 * (tx - head.x); head.y += 0.25 * (ty - head.y);
    }
    const p = document.getElementById("prompt");
    const text = p && p.classList.contains("big") ? p.textContent : "";
    if (text !== lastPrompt) {
      lastPrompt = text;
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
  async function lookAtKey(key, miss = 0.12) {
    const el = [...document.querySelectorAll("[data-key]")].find((e) => e.dataset.key === key || e.dataset.word === key);
    if (!el) throw new Error(`no key ${key}`);
    const r = el.getBoundingClientRect();
    const tx = (r.left + r.width / 2 + miss * r.width * gauss()) / innerWidth, ty = (r.top + r.height / 2 + miss * r.height * gauss()) / innerHeight;
    await lookAt(tx, ty);
    for (let i = 0; i < 40; i++) {
      const c = window.fourLooks.cursor && window.fourLooks.cursor();
      if (!c) break;
      const ex = tx - c[0] / innerWidth, ey = ty - c[1] / innerHeight;
      if (Math.abs(ex) * innerWidth < r.width * 0.2 && Math.abs(ey) * innerHeight < r.height * 0.2) break;
      if (LAZY && document.querySelector(".hover") === el) break;        // most people stop as soon as the key lights up
      const g = (window.fourLooks.reach && window.fourLooks.reach()) || 1;   // people adapt to how far the cursor travels
      head.x += (0.3 * ex) / g; head.y += (0.3 * ey) / g;
      await sleep(HZ * 3);
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
  async function rowHop() { const y0 = head.y; await lookAt(head.x, y0 + 0.17, 160); await lookAt(head.x, y0, 160); await sleep(300); }
  // A person only does the press move once the key they want is highlighted.
  const tally = { presses: 0, reAims: 0, gaveUp: 0, wrongKey: 0 };
  const findKey = (key) => [...document.querySelectorAll("[data-key]")].find((e) => e.dataset.key === key || e.dataset.word === key);
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
    if (aimed && !(gotKey === want || got?.type === want || (key === "menu" && got?.type === "menu"))) { tally.wrongKey++; (tally.misses ||= []).push(`${key}->${gotKey}`); }
  }
  async function type(text) {
    for (const ch of text) await press(ch === " " ? "space" : ch);
  }
  return { head, level, tally, lookAt, lookAtKey, cue, nod, rowHop, press, type, sleep, setAuto: (v) => { auto = v; } };
}
