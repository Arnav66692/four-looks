// Build a compact word model for the browser from a public ARPA 2-gram file.
// Usage: node tools/build-lm.mjs data/raw/lm_mix_top3_2gram_abs0.0.arpa.gz public/lm.json [histories] [perHistory]
import { createReadStream, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

const [src, out, histArg = "70000", perArg = "100000"] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: node tools/build-lm.mjs <arpa.gz> <out.json> [histories] [perHistory]");
  process.exit(1);
}
const MAX_HISTORIES = Number(histArg);
const PER_HISTORY = Number(perArg);
const START_SUCCESSORS = 400;

const uni = new Map(); // word -> [logprob, backoff]
const bigramsByHist = new Map(); // hist -> [[word, lp], ...]
let section = "";

const rl = createInterface({ input: createReadStream(src).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  if (line.startsWith("\\")) { section = line.trim(); continue; }
  if (!line.trim()) continue;
  const parts = line.split("\t");
  if (section === "\\1-grams:") {
    uni.set(parts[1], [Number(parts[0]), parts[2] ? Number(parts[2]) : 0]);
  } else if (section === "\\2-grams:") {
    const [h, w] = parts[1].split(" ");
    let list = bigramsByHist.get(h);
    if (!list) { list = []; bigramsByHist.set(h, list); }
    list.push([w, Number(parts[0])]);
  }
}

const SPECIAL = new Set(["<s>", "</s>", "<unk>"]);
const words = [...uni.keys()].filter((w) => !SPECIAL.has(w) && /^[a-z']+$/.test(w) && /[a-z]/.test(w));
words.sort((a, b) => uni.get(b)[0] - uni.get(a)[0]);
const index = new Map(words.map((w, i) => [w, i]));

const r2 = (x) => Math.round(x * 100) / 100;
const histories = ["<s>", ...words.slice(0, MAX_HISTORIES)];
const bigrams = {};
let kept = 0;
for (const h of histories) {
  const list = (bigramsByHist.get(h) || []).filter(([w]) => index.has(w));
  list.sort((a, b) => b[1] - a[1]);
  const top = list.slice(0, h === "<s>" ? START_SUCCESSORS : PER_HISTORY);
  if (!top.length) continue;
  bigrams[h === "<s>" ? -1 : index.get(h)] = top.flatMap(([w, lp]) => [index.get(w), r2(lp)]);
  kept += top.length;
}

const model = {
  source: src.split("/").pop(),
  words,
  uni: words.map((w) => r2(uni.get(w)[0])),
  backoff: words.map((w) => r2(uni.get(w)[1])),
  startBackoff: r2((uni.get("<s>") || [0, 0])[1]),
  bigrams,
};
writeFileSync(out, JSON.stringify(model));
console.log(`words ${words.length}, histories ${histories.length}, bigrams kept ${kept}`);
