// A short guided test that finds where a real person struggles. About 90 seconds.
// Every step records to the session log (saved under data/sessions), then tools/analyze-session.mjs reads it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SENTENCE = "can you help me";
const HOLD_MS = 600, TARGET_MS = 5000;

export async function runStudy(app) {
  const { prompt, record, target, onFrame, capture, typing, layout } = app;
  let tag = "";
  const stop = onFrame((f, ctx) => { if (tag) record("s-frame", { tag, x: Math.round(ctx.cursor?.[0] ?? -1), y: Math.round(ctx.cursor?.[1] ?? -1), yaw: +(f.pose?.[0] ?? 0).toFixed(4), pitch: +(f.pose?.[1] ?? 0).toFixed(4), score: +ctx.score.toFixed(3) }); });
  const say = async (text, ms) => { prompt(text, true); await sleep(ms); };
  const first = layout.get();
  record("study-start", { w: innerWidth, h: innerHeight, layout: first });
  capture(true);                                            // presses and nods go to the test, not the keyboard

  // 1. Rest: how steady is the cursor when the head is still?
  await say("Test 1 of 5. Face the middle and hold still.", 2000);
  tag = "rest"; await sleep(4000); tag = "";

  // 2. Targets: move onto each box and stay on it. Two sizes: one letter key, and a box three keys wide.
  const k = document.getElementById("keys").getBoundingClientRect();
  const spots = [[0.5, 0.5], [0.12, 0.2], [0.88, 0.2], [0.12, 0.85], [0.88, 0.85], [0.5, 0.2]];
  for (const size of ["small", "big"]) {
    const w = size === "small" ? k.width / 11 : k.width / 3.6, h = k.height / 4.4;
    await say(`Test 2 of 5. Move onto each ${size} box and stay on it.`, 2000);
    for (const [fx, fy] of spots) {
      const cx = k.left + fx * k.width, cy = k.top + fy * k.height;
      target.show(cx, cy, w, h);
      prompt("");
      const t0 = performance.now();
      record("s-target", { size, fx, fy, cx: Math.round(cx), cy: Math.round(cy), w: Math.round(w), h: Math.round(h) });
      tag = `target-${size}`;
      let inside = 0, reached = null;
      while (performance.now() - t0 < TARGET_MS) {
        await sleep(40);
        const c = app.cursor();
        const on = c && Math.abs(c[0] - cx) < w / 2 && Math.abs(c[1] - cy) < h / 2;
        if (on) { inside += 40; if (reached == null) reached = performance.now() - t0; } else inside = 0;
        if (inside >= HOLD_MS) break;
      }
      tag = "";
      record("s-target-done", { size, fx, fy, need: HOLD_MS, reachedMs: reached == null ? null : Math.round(reached), heldMs: inside, totalMs: Math.round(performance.now() - t0) });
      target.hide();
      await sleep(300);
    }
  }

  // 3. Press move: five prompted presses, then a quiet stretch to count accidental ones.
  const presses = [];
  capture(true, (t) => presses.push(t));
  await say("Test 3 of 5. Do your press move each time it says now.", 2200);
  for (let i = 1; i <= 5; i++) {
    await say("Get ready.", 900 + Math.random() * 600);
    const at = performance.now();
    tag = "press"; prompt(app.pressNow(), true);
    record("s-press-cue", { i });
    await sleep(1700);
    tag = "";
    const hit = presses.find((t) => t >= at && t <= at + 1700);
    record("s-press-result", { i, hit: !!hit, latencyMs: hit ? Math.round(hit - at) : null });
  }
  await say("Now just relax. Look around, talk a little.", 600);
  const quietFrom = performance.now();
  tag = "quiet"; await sleep(6000); tag = "";
  record("s-quiet", { ms: 6000, falsePresses: presses.filter((t) => t >= quietFrom).length });

  // 4. Nod: three prompted nods.
  const nods = [];
  capture(true, null, (t) => nods.push(t));
  await say("Test 4 of 5. Nod once each time it says now.", 2200);
  for (let i = 1; i <= 3; i++) {
    await say("Get ready.", 900 + Math.random() * 500);
    const at = performance.now();
    tag = "nod"; prompt("Nod now.", true);
    await sleep(1600);
    tag = "";
    const hit = nods.find((t) => t >= at && t <= at + 1600);
    record("s-nod-result", { i, hit: !!hit, latencyMs: hit ? Math.round(hit - at) : null });
  }
  record("s-nod-extra", { extraNods: Math.max(0, nods.length - 3) });
  capture(false);

  // 5. Typing: one sentence on the layout you were using.
  typing.clear();
  prompt(`Test 5 of 5. Type: ${SENTENCE}`);
  record("s-type-start", { layout: first, sentence: SENTENCE });
  const t0 = performance.now();
  tag = `type-${first}`;
  while (performance.now() - t0 < 60000) {
    await sleep(200);
    if (typing.text().trim().toLowerCase().replace(/[^a-z ]/g, "") === SENTENCE) break;
  }
  tag = "";
  record("s-type-done", { layout: first, sentence: SENTENCE, got: typing.text().trim(), ms: Math.round(performance.now() - t0) });
  typing.clear();
  stop();
  record("study-done", {});
  prompt("Test finished. It is saved.", true);
  await sleep(2000);
  prompt("Ready.");
}

// ---------------------------------------------------------------------------------------------
// Tuning run: the same targets under each mix of sensitivity and smoothing, to find what suits
// this person. Measures speed, slips off the target, overshoot, and drift of the rest position.
// ---------------------------------------------------------------------------------------------
const GAINS = [0.7, 1.0, 1.4];
const SMOOTHING = {
  light: { aMin: 0.12, band: 0.007, full: 0.03, deadzone: 0.002 },
  medium: { aMin: 0.05, band: 0.010, full: 0.04, deadzone: 0.003 },
  heavy: { aMin: 0.03, band: 0.014, full: 0.06, deadzone: 0.004 },
};
const TUNE_SPOTS = [[0.14, 0.22], [0.84, 0.8], [0.5, 0.2], [0.16, 0.82], [0.86, 0.24]];
const TUNE_HOLD = 500, TUNE_CAP = 4500;

export async function runTune(app) {
  const { prompt, record, target, onFrame, capture, tune } = app;
  let tag = "";
  const stop = onFrame((f, ctx) => { if (tag) record("s-frame", { tag, x: Math.round(ctx.cursor?.[0] ?? -1), y: Math.round(ctx.cursor?.[1] ?? -1), yaw: +(f.pose?.[0] ?? 0).toFixed(4), pitch: +(f.pose?.[1] ?? 0).toFixed(4) }); });
  const say = async (text, ms) => { prompt(text, true); await sleep(ms); };
  const k = document.getElementById("keys").getBoundingClientRect();
  const w = k.width / 11, h = k.height / 4.4;                          // one letter key
  const before = tune.get();
  record("tune-start", { w: innerWidth, h: innerHeight, keyW: Math.round(w), keyH: Math.round(h), before });
  capture(true);

  // Rest position, measured three times: any change from first to last is drift.
  const rests = [];
  const rest = async (label) => {
    await say("Face the middle and hold still.", 1800);
    const xs = [], ys = [], yaw = [], pitch = [];
    const off = onFrame((f, ctx) => { if (ctx.cursor) { xs.push(ctx.cursor[0]); ys.push(ctx.cursor[1]); } if (f.pose) { yaw.push(f.pose[0]); pitch.push(f.pose[1]); } });
    tag = `rest-${label}`; await sleep(3000); tag = ""; off();
    const mean = (a) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0);
    const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
    const r = { label, x: mean(xs), y: mean(ys), wobble: Math.hypot(sd(xs), sd(ys)), yaw: mean(yaw), pitch: mean(pitch) };
    rests.push(r);
    record("tune-rest", { label, x: Math.round(r.x), y: Math.round(r.y), wobblePx: +r.wobble.toFixed(1), yawDeg: +((r.yaw * 180) / Math.PI).toFixed(2), pitchDeg: +((r.pitch * 180) / Math.PI).toFixed(2) });
  };

  tune.set(1.0, SMOOTHING.medium);
  await rest("start");
  const results = [];
  const order = [];
  for (const g of GAINS) for (const s of Object.keys(SMOOTHING)) order.push([g, s]);
  for (let n = 0; n < order.length; n++) {
    const [gain, smooth] = order[n];
    tune.set(gain, SMOOTHING[smooth]);
    await say(`Setting ${n + 1} of ${order.length}. Move onto each box and stay on it.`, 1700);
    const trials = [];
    for (const [fx, fy] of TUNE_SPOTS) {
      const cx = k.left + fx * k.width, cy = k.top + fy * k.height;
      target.show(cx, cy, w, h);
      prompt("");
      const t0 = performance.now();
      const start = app.cursor() || [cx, cy];
      const dist0 = Math.hypot(start[0] - cx, start[1] - cy);
      let inside = 0, reached = null, slips = 0, wasOn = false, path = 0, last = start, far = 0;
      tag = `tune-${gain}-${smooth}`;
      while (performance.now() - t0 < TUNE_CAP) {
        await sleep(33);
        const c = app.cursor();
        if (!c) continue;
        path += Math.hypot(c[0] - last[0], c[1] - last[1]); last = c;
        const on = Math.abs(c[0] - cx) < w / 2 && Math.abs(c[1] - cy) < h / 2;
        if (on) { inside += 33; if (reached == null) reached = performance.now() - t0; }
        else { if (wasOn) slips++; inside = 0; if (reached != null) far = Math.max(far, Math.hypot(c[0] - cx, c[1] - cy)); }
        wasOn = on;
        if (inside >= TUNE_HOLD) break;
      }
      tag = "";
      const trial = { ok: inside >= TUNE_HOLD, ms: Math.round(performance.now() - t0), reachedMs: reached == null ? null : Math.round(reached), slips, pathRatio: +(path / Math.max(dist0, 1)).toFixed(2), overshootPx: Math.round(far) };
      trials.push(trial);
      record("tune-trial", { gain, smooth, fx, fy, ...trial });
      target.hide();
      await sleep(250);
    }
    const okT = trials.filter((t) => t.ok);
    const mean = (a) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0);
    const row = {
      gain, smooth, held: okT.length, of: trials.length,
      meanMs: Math.round(mean(trials.map((t) => (t.ok ? t.ms : TUNE_CAP + 1500)))),
      slips: +mean(trials.map((t) => t.slips)).toFixed(1), pathRatio: +mean(trials.map((t) => t.pathRatio)).toFixed(2), overshootPx: Math.round(mean(trials.map((t) => t.overshootPx))),
    };
    row.cost = Math.round(row.meanMs + 400 * row.slips);            // slower or slipping more costs more
    results.push(row);
    record("tune-setting", row);
    if (n === Math.floor(order.length / 2)) { tune.set(1.0, SMOOTHING.medium); await rest("middle"); }
  }
  tune.set(1.0, SMOOTHING.medium);
  await rest("end");
  const best = [...results].sort((a, b) => a.cost - b.cost)[0];
  const drift = { px: Math.round(Math.hypot(rests[rests.length - 1].x - rests[0].x, rests[rests.length - 1].y - rests[0].y)),
    yawDeg: +(((rests[rests.length - 1].yaw - rests[0].yaw) * 180) / Math.PI).toFixed(2), pitchDeg: +(((rests[rests.length - 1].pitch - rests[0].pitch) * 180) / Math.PI).toFixed(2) };
  const usable = best.held >= Math.ceil(best.of * 0.6);
  if (usable) tune.apply(best.gain, SMOOTHING[best.smooth], best.smooth); else tune.apply(before.gain, before.smoothing, before.name);
  record("tune-result", { best, usable, drift, results });
  capture(false);
  stop();
  prompt(usable ? `Tuned to you: reach ${best.gain}x with ${best.smooth} smoothing. Drift over the run: ${drift.px} px.` : "No setting let you hold enough boxes, so nothing was changed. The run is saved.", true);
  await sleep(3500);
  prompt("Ready.");
}
