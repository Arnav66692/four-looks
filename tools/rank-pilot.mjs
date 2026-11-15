// Pilot for In A Park's idea: does Grok rank the spelling candidates better than the app's own order?
// The pass bar is in pilots/grok-rank/PREREG.md, written before the first call.
//   PORT=5181 node server.js      (in one terminal)
//   PORT=5181 node tools/rank-pilot.mjs
// Each run makes about 31 small paid calls to xAI through the app's own spend guard.
import { readFileSync, writeFileSync } from "node:fs";
import { Decoder, LETTER_GROUPS } from "../src/decoder.js";
import { KeyTyper, LETTERS } from "../src/keytyper.js";

// [words before, what was typed, the word meant]. The first 11 are In A's, the other 20 were written before the run.
const CASES = [
  ["i need", "wter", "water"], ["i need", "hepl", "help"], ["i am", "tiredd", "tired"], ["my", "famly", "family"],
  ["i need", "rst", "rest"], ["i am", "hangry", "hungry"], ["i need", "hlp", "help"], ["i am", "coldd", "cold"],
  ["my", "glases", "glasses"], ["open the", "dor", "door"], ["go", "outsdie", "outside"],
  ["please close the", "windw", "window"], ["i want to drink some", "wter", "water"], ["my", "hed", "head"],
  ["turn off the", "ligt", "light"], ["i need to go to the", "bathrom", "bathroom"], ["call my", "docter", "doctor"],
  ["i am very", "tird", "tired"], ["what", "tme", "time"], ["i feel", "sck", "sick"], ["can you", "hlp", "help"],
  ["i want to", "wach", "watch"], ["the", "fod", "food"], ["i love my", "famly", "family"], ["turn the", "musc", "music"],
  ["my", "bak", "back"], ["i need my", "medicne", "medicine"], ["it is too", "cld", "cold"], ["read me a", "bok", "book"],
  ["i am", "thirty", "thirsty"], ["can i have some", "mor", "more"],
];
const HERS = 11;
const dec = new Decoder(JSON.parse(readFileSync(new URL("../public/lm.json", import.meta.url))), { groups: LETTER_GROUPS });
const hit = (c) => { const p = new Array(26).fill(0.004); p[LETTERS.indexOf(c)] = 0.9; return p; };
const port = process.env.PORT || 5181;

// LOCAL_ONLY=1 makes no calls: it prints only what the app's own order gives, to compare against a saved run.
if (process.env.LOCAL_ONLY) {
  let right = 0, hers = 0;
  CASES.forEach(([before, typed, want], i) => {
    const t = new KeyTyper(dec); t.shift = "off";
    for (const w of before.split(" ")) t.pick(w);
    for (const c of typed) t.letter(hit(c));
    const first = t.suggestions(4)[0].toLowerCase();
    if (first === want) { right++; if (i < HERS) hers++; } else console.log(`app alone misses: ${before} ${typed} -> ${first} (meant ${want})`);
  });
  console.log(`app alone, first choice right: ${right} of ${CASES.length} (In A's eleven: ${hers} of ${HERS})`);
  process.exit(0);
}

const rows = [];
for (const [before, typed, want] of CASES) {
  const t = new KeyTyper(dec); t.shift = "off";
  for (const w of before.split(" ")) t.pick(w);
  for (const c of typed) t.letter(hit(c));
  const chips = t.suggestions(4).map((w) => w.toLowerCase());
  // Only real words are ranked (run 2). The letters as typed stay on screen as a chip, but Grok does not see them.
  const candidates = [...new Set([...chips, ...t.spell(6)])].filter((w) => /^[a-z']+$/.test(w) && dec.idOf(w) >= 0).slice(0, 8);
  const r = await (await fetch(`http://localhost:${port}/api/rank`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sentence: `${before} ${typed}`, candidates }) })).json();
  rows.push({ before, typed, want, local: chips[0], grok: r.ranked[0], ok: r.ok, error: r.error || null, ms: r.ms ?? null, inList: candidates.includes(want), candidates });
  console.log(`${`${before} ${typed}`.padEnd(30)} want ${want.padEnd(9)} app ${String(chips[0]).padEnd(9)}${chips[0] === want ? "✓" : "✗"}  grok ${String(r.ranked[0]).padEnd(9)}${r.ranked[0] === want ? "✓" : "✗"}  ${r.ok ? r.ms + " ms" : "FELL BACK: " + r.error}${candidates.includes(want) ? "" : "   (not among the candidates)"}`);
}
const count = (list, who) => list.filter((r) => r[who] === r.want).length;
const times = rows.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b), median = times.length ? times[Math.floor(times.length / 2)] : null;
const all = { app: count(rows, "local"), grok: count(rows, "grok") }, hers = { app: count(rows.slice(0, HERS), "local"), grok: count(rows.slice(0, HERS), "grok") };
const bars = { gainAtLeast3: all.grok - all.app >= 3, notWorseOnHers: hers.grok >= hers.app, medianUnder900: median != null && median <= 900 };
const summary = { cases: rows.length, firstChoiceRight: all, onInAsEleven: hers, intendedAmongCandidates: rows.filter((r) => r.inList).length, fellBack: rows.filter((r) => !r.ok).length, medianMs: median, slowestMs: times[times.length - 1] ?? null, bars, pass: Object.values(bars).every(Boolean) };
console.log(JSON.stringify(summary, null, 1));
writeFileSync(new URL("../pilots/grok-rank/results.json", import.meta.url), JSON.stringify({ ranAt: new Date().toISOString(), summary, rows }, null, 1));
