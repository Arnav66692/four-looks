// Measure the decoder on held-out AAC sentences.
// Usage: node tools/eval.mjs <dev|test> [noise] [seed] [slip]   (LM=path overrides the word model)
//   noise 0 = every signal right. noise > 0 = simulated camera, Gaussian noise on box scores.
// The user confirms each word, so the history is the true previous word (as in the live app).
import { readFileSync } from "node:fs";
import { Decoder, hardSlot, defaultConfusion } from "../src/decoder.js";

const [split = "dev", noiseArg = "0", seedArg = "1", slipArg = "0.0001"] = process.argv.slice(2);
const NOISE = Number(noiseArg);
let seed = Number(seedArg);
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

const model = JSON.parse(readFileSync(process.env.LM || new URL("../public/lm.json", import.meta.url)));
const dec = new Decoder(model, { confusion: defaultConfusion(Number(slipArg)) });
const lines = readFileSync(new URL(`../data/raw/aac_comm/sent_${split}_aac.txt`, import.meta.url), "utf8")
  .split("\n").map((l) => l.trim()).filter(Boolean);

const tokenize = (s) => s.toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/)
  .map((w) => w.replace(/^'+|'+$/g, "")).filter((w) => /[a-z]/.test(w));

// Simulated classifier: score 1 on the true box, plus noise, then softmax.
function noisySlot(box) {
  const s = Array.from({ length: 4 }, (_, i) => (i === box ? 1 : 0) + NOISE * gauss());
  const m = Math.max(...s);
  const e = s.map((x) => Math.exp((x - m) * 4));
  const z = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / z);
}

const stats = { words: 0, oov: 0, hard: { top1: 0, top3: 0 }, soft: { top1: 0, top3: 0 }, slips: 0, letters: 0,
  sent: { hard: 0, soft: 0, hardTop3: 0, softTop3: 0, n: 0 } };
for (const line of lines) {
  let hist = -1;
  const truth = tokenize(line);
  const sentSlots = { hard: [], soft: [] };
  for (const w of truth) {
    stats.words++;
    const code = [...w].filter((c) => c in dec.boxOf).map((c) => dec.boxOf[c]);
    const soft = code.map((b) => (NOISE > 0 ? noisySlot(b) : hardSlot(b)));
    const hard = soft.map((p) => hardSlot(p.indexOf(Math.max(...p))));
    soft.forEach((p, k) => { stats.letters++; if (p.indexOf(Math.max(...p)) !== code[k]) stats.slips++; });
    sentSlots.hard.push(hard);
    sentSlots.soft.push(soft);
    for (const [name, slots] of [["hard", hard], ["soft", soft]]) {
      const ranked = dec.decodeWord(slots, hist, { top: 3 }).map((c) => c.word);
      if (ranked[0] === w) stats[name].top1++;
      if (ranked.includes(w)) stats[name].top3++;
    }
    const id = dec.idOf(w);
    if (id < 0) stats.oov++;
    hist = id;
  }
  stats.sent.n++;
  for (const name of ["hard", "soft"]) {
    const hyps = dec.decodeSentence(sentSlots[name]).slice(0, 3).map((h) => h.words);
    hyps[0].forEach((w, i) => { if (w !== truth[i]) stats.sent[name]++; });
    if (hyps.some((h) => h.join(" ") === truth.join(" "))) stats.sent[`${name}Top3`]++;
  }
}
const pct = (x) => ((100 * x) / stats.words).toFixed(1);
console.log(`${split} | ${lines.length} sentences, ${stats.words} words, ${stats.oov} unknown | noise ${NOISE} | letter slips ${((100 * stats.slips) / stats.letters).toFixed(1)}%`);
for (const name of ["hard", "soft"]) {
  console.log(`  ${name}: word by word error ${pct(stats.words - stats[name].top1)}%, right word in top 3 ${pct(stats[name].top3)}%`
    + ` | whole sentence word error ${pct(stats.sent[name])}%, right sentence in top 3 ${((100 * stats.sent[`${name}Top3`]) / stats.sent.n).toFixed(1)}%`);
}
