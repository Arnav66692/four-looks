// A guided test that finds where a real person struggles. About three minutes.
// Every step records to the session log (saved under data/sessions), then tools/analyze-session.mjs reads it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SENTENCES = ["can you help me", "i need my glasses"];

export async function runStudy(app) {
  const { prompt, record, target, onFrame, capture, typing, layout } = app;
  const frames = [];
  let tag = "";
  const stop = onFrame((f, ctx) => { if (tag) record("s-frame", { tag, x: Math.round(ctx.cursor?.[0] ?? -1), y: Math.round(ctx.cursor?.[1] ?? -1), yaw: +(f.pose?.[0] ?? 0).toFixed(4), pitch: +(f.pose?.[1] ?? 0).toFixed(4), score: +ctx.score.toFixed(3) }); frames.push(1); });
  const say = async (text, ms) => { prompt(text, true); await sleep(ms); };
  record("study-start", { w: innerWidth, h: innerHeight, layout: layout.get() });
  capture(true);                                            // presses and nods go to the test, not the keyboard

  // 1. Rest: how steady is the cursor when the head is still?
  await say("Test 1 of 7. Face the middle and hold still.", 2500);
  tag = "rest"; await sleep(6000); tag = "";

  // 2. Reach: how far is comfortable in each direction?
  for (const dir of ["left", "right", "up", "down"]) {
    await say(`Test 2 of 7. Turn ${dir} as far as is still comfortable, and hold.`, 2600);
    tag = `reach-${dir}`; await sleep(1500); tag = "";
    await say("Back to the middle.", 1500);
  }

  // 3. Targets: reach each one and hold on it. Sizes: a QWERTY key and a big key.
  const k = document.getElementById("keys").getBoundingClientRect();
  const spots = [[0.12, 0.2], [0.5, 0.2], [0.88, 0.2], [0.12, 0.55], [0.88, 0.55], [0.12, 0.9], [0.5, 0.9], [0.88, 0.9], [0.5, 0.55]];
  for (const size of ["small", "big"]) {
    const w = size === "small" ? k.width / 11 : k.width / 4, h = size === "small" ? k.height / 4.4 : k.height / 4.4;
    await say(`Test 3 of 7. Move onto each ${size} box and stay on it.`, 2600);
    for (const [fx, fy] of spots) {
      const cx = k.left + fx * k.width, cy = k.top + fy * k.height;
      target.show(cx, cy, w, h);
      prompt("");
      const t0 = performance.now();
      record("s-target", { size, fx, fy, cx: Math.round(cx), cy: Math.round(cy), w: Math.round(w), h: Math.round(h) });
      tag = `target-${size}`;
      let inside = 0, reached = null;
      while (performance.now() - t0 < 6000) {
        await sleep(40);
        const c = app.cursor();
        const on = c && Math.abs(c[0] - cx) < w / 2 && Math.abs(c[1] - cy) < h / 2;
        if (on) { inside += 40; if (reached == null) reached = performance.now() - t0; } else inside = 0;
        if (inside >= 900) break;
      }
      tag = "";
      record("s-target-done", { size, fx, fy, reachedMs: reached == null ? null : Math.round(reached), heldMs: inside, totalMs: Math.round(performance.now() - t0) });
      target.hide();
      await sleep(350);
    }
  }

  // 4. Press move: ten prompted presses, then a quiet stretch to count accidental ones.
  const presses = [];
  capture(true, (t) => presses.push(t));
  await say("Test 4 of 7. Do your press move each time it says now.", 2600);
  for (let i = 1; i <= 8; i++) {
    await say("Get ready.", 900 + Math.random() * 700);
    const at = performance.now();
    tag = "press"; prompt(app.pressNow(), true);
    record("s-press-cue", { i });
    await sleep(1700);
    tag = "";
    const hit = presses.find((t) => t >= at && t <= at + 1700);
    record("s-press-result", { i, hit: !!hit, latencyMs: hit ? Math.round(hit - at) : null });
  }
  await say("Test 5 of 7. Now just relax. Look around, talk a little.", 800);
  const quietFrom = performance.now();
  tag = "quiet"; await sleep(10000); tag = "";
  record("s-quiet", { ms: 10000, falsePresses: presses.filter((t) => t >= quietFrom).length });

  // 5. Nod: five prompted nods.
  const nods = [];
  capture(true, null, (t) => nods.push(t));
  await say("Test 6 of 7. Nod once each time it says now.", 2600);
  for (let i = 1; i <= 5; i++) {
    await say("Get ready.", 900 + Math.random() * 600);
    const at = performance.now();
    tag = "nod"; prompt("Nod now.", true);
    await sleep(1600);
    tag = "";
    const hit = nods.find((t) => t >= at && t <= at + 1600);
    record("s-nod-result", { i, hit: !!hit, latencyMs: hit ? Math.round(hit - at) : null });
  }
  record("s-nod-extra", { extraNods: Math.max(0, nods.length - 5) });
  capture(false);

  // 6. Typing: the same two sentences on each layout.
  for (const which of ["big", "abc"]) {
    layout.set(which);
    for (const sentence of SENTENCES) {
      typing.clear();
      prompt(`Test 7 of 7. Type: ${sentence}`);
      record("s-type-start", { layout: which, sentence });
      const t0 = performance.now();
      tag = `type-${which}`;
      while (performance.now() - t0 < 75000) {
        await sleep(200);
        if (typing.text().trim().toLowerCase().replace(/[^a-z ]/g, "") === sentence) break;
      }
      tag = "";
      record("s-type-done", { layout: which, sentence, got: typing.text().trim(), ms: Math.round(performance.now() - t0) });
      await sleep(600);
    }
  }
  layout.set("big");
  typing.clear();
  stop();
  record("study-done", {});
  prompt("Test finished. Thank you. It is saved.", true);
  await sleep(2500);
  prompt("Ready.");
}
