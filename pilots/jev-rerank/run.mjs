// Jev reranking pilot. Rules are in PREREG.md. Usage: TYPESAFE_API_KEY=... node pilots/jev-rerank/run.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { Decoder, LETTER_GROUPS } from "../../src/decoder.js";
import { KeyTyper, LETTERS } from "../../src/keytyper.js";

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error("TYPESAFE_API_KEY is not set"); process.exit(1); }
const SENTENCES = 60, SIG = 0.45, NOISES = [0.35, 0.5];
const root = new URL("../../", import.meta.url);
const dec = new Decoder(JSON.parse(readFileSync(new URL("public/lm.json", root))), { groups: LETTER_GROUPS });
const lines = readFileSync(new URL("data/raw/aac_comm/sent_dev_aac.txt", root), "utf8").split("\n").filter(Boolean).slice(0, SENTENCES);

const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const pos = {};
rows.forEach((r, y) => [...r].forEach((c, x) => { pos[c] = [x + y * 0.4, y]; }));
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
const pressProbs = (x, y) => {
  const w = [...LETTERS].map((c) => Math.exp(-((x - pos[c][0]) ** 2 + (y - pos[c][1]) ** 2) / (2 * SIG * SIG)));
  const z = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / z);
};

async function askJev(soFar, typed, options) {
  const criteria = Object.fromEntries(options.map((w, i) => [`option_${i + 1}`, `The word is "${w}"`]));
  const body = {
    model: "jev-latest",
    state: { message_so_far: soFar || "(start of the message)", letters_typed_roughly: typed },
    questions: { word: { type: "choice", instructions: "A person is typing an everyday message on a keyboard that is hard to aim at, so `letters_typed_roughly` may have wrong letters. Which word did they most likely mean as the next word after `message_so_far`?", criteria } },
  };
  const t0 = performance.now();
  const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const ms = performance.now() - t0;
  if (!r.ok) throw new Error(`Jev replied ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { probs: options.map((_, i) => j.answers.word.probabilities[`option_${i + 1}`] ?? 0), ms, tokens: j.usage?.input_tokens ?? 0 };
}

const out = { when: new Date().toString(), sentences: SENTENCES, levels: [] };
for (const noise of NOISES) {
  const rand = rng(7), gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const shuffle = rng(99);
  const s = { noise, words: 0, decoderRight: 0, jevRight: 0, combinedRight: 0, truthInTop4: 0, ms: [], tokens: 0, flips: [] };
  for (const line of lines) {
    const truthWords = line.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean);
    const t = new KeyTyper(dec); t.shift = "off";
    const soFar = [];
    for (const w of truthWords) {
      for (const c of w) { const [x, y] = pos[c]; t.letter(pressProbs(x + noise * gauss(), y + noise * gauss())); }
      const ranked = t.ranked(4);
      const typed = t.typedWord();
      s.words++;
      if (ranked[0].word === w) s.decoderRight++;
      if (ranked.some((c) => c.word === w)) s.truthInTop4++;
      const order = ranked.map((c, i) => [shuffle(), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
      const options = order.map((i) => ranked[i].word);
      const { probs, ms, tokens } = await askJev(soFar.join(" "), typed, options);
      s.ms.push(ms); s.tokens += tokens;
      const jevPick = options[probs.indexOf(Math.max(...probs))];
      const top = Math.max(...ranked.map((c) => c.score));
      const prior = ranked.map((c) => 10 ** (c.score - top)), z = prior.reduce((a, b) => a + b, 0);
      const combined = order.map((i, k) => probs[k] * (prior[i] / z));
      const combinedPick = options[combined.indexOf(Math.max(...combined))];
      if (jevPick === w) s.jevRight++;
      if (combinedPick === w) s.combinedRight++;
      if ((combinedPick === w) !== (ranked[0].word === w)) s.flips.push({ truth: w, typed, decoder: ranked[0].word, combined: combinedPick, after: soFar.slice(-3).join(" ") });
      soFar.push(w);
      t.pending = []; t.committed += w + " ";
    }
  }
  const sorted = [...s.ms].sort((a, b) => a - b);
  const err = (right) => +(100 * (1 - right / s.words)).toFixed(1);
  const level = {
    noise, words: s.words, truthInTop4: +(100 * s.truthInTop4 / s.words).toFixed(1),
    wrongDecoder: err(s.decoderRight), wrongJevAlone: err(s.jevRight), wrongCombined: err(s.combinedRight),
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]), p90Ms: Math.round(sorted[Math.floor(sorted.length * 0.9)]),
    inputTokens: s.tokens, costUsd: +(s.tokens * 0.042 / 1e6).toFixed(5),
    fixedByCombined: s.flips.filter((f) => f.combined === f.truth).length, brokenByCombined: s.flips.filter((f) => f.decoder === f.truth).length,
    examples: s.flips.slice(0, 12),
  };
  out.levels.push(level);
  console.log(`noise ${noise}: ${level.words} words | wrong words: decoder ${level.wrongDecoder}%, Jev alone ${level.wrongJevAlone}%, combined ${level.wrongCombined}% | truth in top 4 ${level.truthInTop4}% | median ${level.medianMs} ms, p90 ${level.p90Ms} ms | fixed ${level.fixedByCombined}, broken ${level.brokenByCombined} | $${level.costUsd}`);
}
writeFileSync(new URL("pilots/jev-rerank/results.json", root), JSON.stringify(out, null, 2));
