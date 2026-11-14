// How well does the word guesser do with big keys that each hold several letters (phone keypad style)?
// Every press says only "one of these letters". Usage: node tools/bigkeys-eval.mjs [dev|test]
import { readFileSync } from "node:fs";
import { Decoder, LETTER_GROUPS } from "../src/decoder.js";
import { KeyTyper, LETTERS } from "../src/keytyper.js";

const split = process.argv[2] || "dev";
const LAYOUTS = {
  "8 keys (abc def ghi jkl mno pqrs tuv wxyz)": ["abc", "def", "ghi", "jkl", "mno", "pqrs", "tuv", "wxyz"],
  "6 keys (abcd efgh ijkl mnop qrst uvwxyz)": ["abcd", "efgh", "ijkl", "mnop", "qrst", "uvwxyz"],
};
const dec = new Decoder(JSON.parse(readFileSync(new URL("../public/lm.json", import.meta.url))), { groups: LETTER_GROUPS });
const lines = readFileSync(new URL(`../data/raw/aac_comm/sent_${split}_aac.txt`, import.meta.url), "utf8").split("\n").filter(Boolean);

for (const [name, groups] of Object.entries(LAYOUTS)) {
  const probsOf = {};
  for (const g of groups) { const p = [...LETTERS].map((c) => (g.includes(c) ? 1 / g.length : 0)); for (const c of g) probsOf[c] = p; }
  let words = 0, top1 = 0, top3 = 0, unknown = 0;
  for (const line of lines) {
    const t = new KeyTyper(dec); t.shift = "off";
    for (const w of line.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean)) {
      for (const c of w) t.letter(probsOf[c], { group: true });
      const ranked = t.ranked(3).map((c) => c.word);
      words++;
      if (ranked[0] === w) top1++;
      if (ranked.includes(w)) top3++;
      if (dec.idOf(w) < 0) unknown++;
      t.pending = []; t.committed += w + " ";       // the person confirms each word, so the next guess sees the true one
    }
  }
  console.log(`${split} | ${name}: ${words} words | first guess right ${(100 * top1 / words).toFixed(1)}% | right word in top 3 ${(100 * top3 / words).toFixed(1)}% | unknown words ${unknown}`);
}
