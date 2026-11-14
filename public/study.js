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
