// Reads a saved guided test and reports where the person struggled.
// Usage: node tools/analyze-session.mjs [data/sessions/<file>.jsonl]   (default: the newest file with a finished test)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../data/sessions/", import.meta.url));
const load = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let path = process.argv[2];
if (!path) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  path = files.find((f) => load(f).some((e) => e.type === "study-start"));
  if (!path) { console.error("no saved test found in data/sessions"); process.exit(1); }
}
const ev = load(path);
const start = ev.find((e) => e.type === "study-start") || { w: 1470, h: 520 };
const frames = (tag) => ev.filter((e) => e.type === "s-frame" && e.tag === tag);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const deg = (r) => (r * 180) / Math.PI;
const out = [];
const say = (s = "") => out.push(s);
const flags = [];

say(`Session: ${path.split("/").pop()}   window ${start.w} x ${start.h}   test finished: ${ev.some((e) => e.type === "study-done") ? "yes" : "NO (partial)"}`);

// 1. rest
const rest = frames("rest");
if (rest.length > 20) {
  const jx = sd(rest.map((f) => f.x)), jy = sd(rest.map((f) => f.y));
  const third = Math.floor(rest.length / 3);
  const driftX = mean(rest.slice(-third).map((f) => f.x)) - mean(rest.slice(0, third).map((f) => f.x));
  const driftY = mean(rest.slice(-third).map((f) => f.y)) - mean(rest.slice(0, third).map((f) => f.y));
  const noiseYaw = sd(rest.map((f) => deg(f.yaw))), noisePitch = sd(rest.map((f) => deg(f.pitch)));
  say(`\n1. Holding still (6 s)`);
  say(`   cursor wobble      ${jx.toFixed(1)} px across, ${jy.toFixed(1)} px up-down`);
  say(`   slow drift         ${driftX.toFixed(0)} px across, ${driftY.toFixed(0)} px up-down over the 6 s`);
  say(`   head angle noise   ${noiseYaw.toFixed(2)} deg turn, ${noisePitch.toFixed(2)} deg nod`);
  if (Math.hypot(jx, jy) > 12) flags.push(`Cursor wobbles ${Math.hypot(jx, jy).toFixed(0)} px while holding still: needs more smoothing or bigger keys.`);
  if (Math.hypot(driftX, driftY) > 40) flags.push(`Cursor drifted ${Math.hypot(driftX, driftY).toFixed(0)} px in 6 s of holding still: posture drift is real, recenter often or switch to a relative pointer.`);
}

// 2. reach, measured during calibration
const cal = ev.filter((e) => e.type === "calibrate" && e.turnDeg != null).pop();
if (cal) {
  say(`\n2. Comfortable reach (from calibration)`);
  say(`   turn   ${cal.turnDeg} deg from left to right`);
  say(`   nod    ${cal.nodDeg} deg from up to down`);
  if (cal.turnDeg < 12) flags.push(`Comfortable turn is only ${cal.turnDeg} deg: keys across will be hard to tell apart.`);
  if (cal.nodDeg < 8) flags.push(`Comfortable nod range is only ${cal.nodDeg} deg: four rows will be hard to tell apart, use fewer rows.`);
}
const cue = ev.filter((e) => e.type === "cue-calibrate").pop();
if (cue) {
  say(`   press move "${cue.cue}": ${cue.ok ? `calibrated, line ${cue.thr}, relaxed ${cue.restTop}, firm ${cue.peak}` : `NOT calibrated (${cue.why})`}`);
  if (!cue.ok) flags.push(`The press move "${cue.cue}" could not be calibrated: ${cue.why}.`);
}

// 3. targets
const done = ev.filter((e) => e.type === "s-target-done");
if (done.length) {
  say(`\n3. Reaching and holding targets (each needs 0.9 s held)`);
  for (const size of ["small", "big"]) {
    const d = done.filter((e) => e.size === size);
    if (!d.length) continue;
    const ok = d.filter((e) => e.heldMs >= (e.need || 900));
    say(`   ${size.padEnd(5)} boxes: ${ok.length} of ${d.length} held, median ${Math.round(median(ok.map((e) => e.totalMs)))} ms to finish, median ${Math.round(median(d.filter((e) => e.reachedMs != null).map((e) => e.reachedMs)))} ms to first touch`);
    const slow = d.filter((e) => e.heldMs < (e.need || 900) || e.totalMs > 3500).map((e) => `${e.fy < 0.4 ? "top" : e.fy > 0.7 ? "bottom" : "middle"}-${e.fx < 0.3 ? "left" : e.fx > 0.7 ? "right" : "centre"}`);
    if (slow.length) say(`         hard spots: ${[...new Set(slow)].join(", ")}`);
    if (ok.length < d.length) flags.push(`Could not hold ${d.length - ok.length} of ${d.length} ${size} boxes: ${[...new Set(slow)].join(", ")}.`);
    const settle = ok.filter((e) => e.reachedMs != null).map((e) => e.totalMs - e.reachedMs - (e.need || 900));
    if (settle.length && median(settle) > 600) flags.push(`On ${size} boxes the cursor took a median ${Math.round(median(settle))} ms of slipping off and back before it held: aim is unsteady at that size.`);
  }
}

// 4. press move
const pr = ev.filter((e) => e.type === "s-press-result");
if (pr.length) {
  const hits = pr.filter((e) => e.hit);
  const quiet = ev.find((e) => e.type === "s-quiet");
  const pf = frames("press");
  const shift = [];
  for (const cue of ev.filter((e) => e.type === "s-press-cue")) {
    const seg = pf.filter((f) => f.t === undefined ? false : true);
    void seg; void cue;
  }
  say(`\n4. Press move`);
  say(`   prompted presses   ${hits.length} of ${pr.length} registered, median ${Math.round(median(hits.map((e) => e.latencyMs)))} ms after the cue`);
  say(`   score while asked  peak ${Math.max(0, ...pf.map((f) => f.score)).toFixed(2)}, median ${median(pf.map((f) => f.score)).toFixed(2)}`);
  if (quiet) say(`   accidental presses ${quiet.falsePresses} in ${quiet.ms / 1000} s of relaxing and talking`);
  if (pf.length > 10) {
    const moved = Math.hypot(sd(pf.map((f) => f.x)), sd(pf.map((f) => f.y)));
    say(`   cursor movement    ${moved.toFixed(0)} px of wobble while pressing`);
    if (moved > 25) flags.push(`The cursor moves ${moved.toFixed(0)} px while doing the press move: the press pulls the head off the key.`);
  }
  if (hits.length < pr.length * 0.9) flags.push(`Press move registered only ${hits.length} of ${pr.length} times: recalibrate it or pick another move.`);
  if (quiet && quiet.falsePresses > 0) flags.push(`${quiet.falsePresses} accidental presses in 10 s of relaxing: the press line is too low for this person.`);
}

// 5. nod
const nr = ev.filter((e) => e.type === "s-nod-result");
if (nr.length) {
  const hits = nr.filter((e) => e.hit), extra = ev.find((e) => e.type === "s-nod-extra");
  say(`\n5. Nod`);
  say(`   prompted nods      ${hits.length} of ${nr.length} registered${extra ? `, ${extra.extraNods} extra` : ""}`);
  if (hits.length < nr.length * 0.8) flags.push(`Nod registered only ${hits.length} of ${nr.length} times: lower the nod depth or drop the nod.`);
}

// 6. typing
const ty = ev.filter((e) => e.type === "s-type-done");
if (ty.length) {
  say(`\n6. Typing the same sentences`);
  for (const which of ["head", "abc", "big"]) {
    const d = ty.filter((e) => e.layout === which);
    if (!d.length) continue;
    const right = d.filter((e) => e.got.toLowerCase().replace(/[^a-z ]/g, "") === e.sentence);
    const wpm = right.map((e) => (e.sentence.length / 5) / (e.ms / 60000));
    const t0 = ev.filter((e) => e.type === "s-type-start" && e.layout === which).map((e) => e.t), t1 = d.map((e) => e.t);
    const undos = ev.filter((e) => (e.type === "undo" || e.type === "backspace") && t0.some((a, i) => e.t >= a && e.t <= t1[i])).length;
    say(`   ${({ head: "head layout", abc: "QWERTY", big: "boxes" })[which]}  ${right.length} of ${d.length} sentences exact, ${wpm.length ? mean(wpm).toFixed(1) : "-"} words a minute, ${undos} undo or delete presses`);
    if (right.length < d.length) flags.push(`${({ head: "Head layout", abc: "QWERTY", big: "Boxes" })[which]}: ${d.length - right.length} of ${d.length} sentences not finished exactly in 75 s (got "${d.find((e) => !right.includes(e)).got}").`);
  }
}

say(`\nChokepoints, worst first`);
if (flags.length) flags.forEach((f, i) => say(`   ${i + 1}. ${f}`)); else say("   none crossed a warning line in this run");
console.log(out.join("\n"));
