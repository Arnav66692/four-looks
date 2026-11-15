// In A Park's spelling test: each misspelling should bring up the intended word among the guesses.
// Her list (Nov 14, 2026 email "word suggestions"), typed with clean presses after "i need".
//   node tools/spell-check.mjs
import { readFileSync } from "node:fs";
import { Decoder, LETTER_GROUPS } from "../src/decoder.js";
import { KeyTyper, LETTERS } from "../src/keytyper.js";

const CASES = { wter: "water", hepl: "help", tiredd: "tired", famly: "family", rst: "rest", hangry: "hungry", hlp: "help", coldd: "cold", glases: "glasses", dor: "door", outsdie: "outside" };
const CONTEXT = { wter: "i need", hepl: "i need", tiredd: "i am", famly: "my", rst: "i need", hangry: "i am", hlp: "i need", coldd: "i am", glases: "my", dor: "open the", outsdie: "go" };
const dec = new Decoder(JSON.parse(readFileSync(new URL("../public/lm.json", import.meta.url))), { groups: LETTER_GROUPS });
const hit = (c) => { const p = new Array(26).fill(0.004); p[LETTERS.indexOf(c)] = 0.9; return p; };

let shown = 0, first = 0, noContext = 0;
for (const [typed, want] of Object.entries(CASES)) {
  const t = new KeyTyper(dec); t.shift = "off";
  for (const w of CONTEXT[typed].split(" ")) t.pick(w);
  for (const c of typed) t.letter(hit(c));
  const chips = t.suggestions(4).map((w) => w.toLowerCase());
  const bare = new KeyTyper(dec); bare.shift = "off";
  for (const c of typed) bare.letter(hit(c));
  const bareChips = bare.suggestions(4).map((w) => w.toLowerCase());
  const at = chips.indexOf(want);
  if (at >= 0) shown++;
  if (at === 0) first++;
  if (bareChips.includes(want)) noContext++;
  console.log(`${at >= 0 ? "PASS" : "FAIL"} ${typed.padEnd(8)} -> ${want.padEnd(8)} after "${CONTEXT[typed]}": ${chips.join(", ")}${at === 0 ? "  (bold)" : ""}   | no words before: ${bareChips.join(", ")}`);
}
const n = Object.keys(CASES).length;
console.log(`intended word among the five guesses: ${shown} of ${n} (bold first guess: ${first}). With no words before it: ${noContext} of ${n}.`);
process.exitCode = shown === n ? 0 : 1;
