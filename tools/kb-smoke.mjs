// Near-miss typing through KeyTyper: each press lands with Gaussian noise on a qwerty grid.
import { readFileSync } from "node:fs";
import { Decoder, LETTER_GROUPS } from "../src/decoder.js";
import { KeyTyper, LETTERS } from "../src/keytyper.js";
const dec = new Decoder(JSON.parse(readFileSync(new URL("../public/lm.json", import.meta.url))), { groups: LETTER_GROUPS });
const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const pos = {}; rows.forEach((r, y) => [...r].forEach((c, x) => { pos[c] = [x + y * 0.4, y]; }));
const NOISE = Number(process.argv[2] || 0.45), SIG = 0.45;
let seed = 7; const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const g = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const probs = (x, y) => { const w = [...LETTERS].map((c) => Math.exp(-((x - pos[c][0]) ** 2 + (y - pos[c][1]) ** 2) / (2 * SIG * SIG))); const z = w.reduce((a, b) => a + b); return w.map((v) => v / z); };
const lines = readFileSync(new URL("../data/raw/aac_comm/sent_dev_aac.txt", import.meta.url), "utf8").split("\n").filter(Boolean).slice(0, 200);
let words = 0, typedRight = 0, fixedRight = 0;
for (const line of lines) {
  const t = new KeyTyper(dec); t.shift = "off";
  for (const w of line.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean)) {
    for (const c of w) { const [x, y] = pos[c]; t.letter(probs(x + NOISE * g(), y + NOISE * g())); }
    words++; if (t.typedWord() === w) typedRight++;
    if (t.bestWord().toLowerCase() === w) fixedRight++;
    t.literal(" ");
  }
}
console.log(`noise ${NOISE} key widths | ${words} words | raw keys right ${(100 * typedRight / words).toFixed(1)}% | after decoder ${(100 * fixedRight / words).toFixed(1)}%`);
