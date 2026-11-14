// Stress test: strange words, names, slang, mixed case, emails, links, numbers.
// Types each item key by key through KeyTyper, the way the keyboard page does, then checks the text.
// Usage: node tools/strange-words.mjs [noise in key widths, default 0 = dead-centre presses]
import { readFileSync } from "node:fs";
import { Decoder, LETTER_GROUPS } from "../src/decoder.js";
import { KeyTyper, LETTERS } from "../src/keytyper.js";

const NOISE = Number(process.argv[2] || 0);
const TRIALS = NOISE > 0 ? 5 : 1;
const SIG = 0.45;
const dec = new Decoder(JSON.parse(readFileSync(new URL("../public/lm.json", import.meta.url))), { groups: LETTER_GROUPS });

export const ITEMS = [
  // names and places
  "Arnav", "Shivam", "Qualcomm", "Jacobs Hall", "UCSD", "Kubernetes", "Zhang", "Nguyen", "Siobhan", "Xiomara",
  // rare and tricky spelling
  "rhythm", "onomatopoeia", "Mississippi", "pneumonia", "quinoa", "xylophone", "fjord", "syzygy",
  // brands and mixed case
  "iPhone", "ChatGPT", "McDonald's", "YouTube", "eBay",
  // contractions and slang
  "don't", "y'all", "I'm", "gonna", "lol", "brb", "ASAP", "omg",
  // emails, links, tags, numbers
  "arnav@gmail.com", "sandhacks.devpost.com", "#SanDHacks", "3:45pm", "$20", "2026", "1-800-555-0199",
  // sentences
  "I need my glasses.", "Call Dr. Patel at 5.", "Can you text Shivam?",
];

// What a person would have in their own word list after typing these once (or from contacts).
const NAMES = ["Arnav", "Shivam", "Qualcomm", "Kubernetes", "Zhang", "Nguyen", "Siobhan", "Xiomara", "ChatGPT", "Patel"];

const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const pos = {};
rows.forEach((r, y) => [...r].forEach((c, x) => { pos[c] = [x + y * 0.4, y]; }));
let seed = 11;
const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
function probs(c) {
  const [x0, y0] = pos[c];
  const x = x0 + NOISE * gauss(), y = y0 + NOISE * gauss();
  const w = [...LETTERS].map((k) => Math.exp(-((x - pos[k][0]) ** 2 + (y - pos[k][1]) ** 2) / (2 * SIG * SIG)));
  const z = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / z);
}

// Types text the way a person would: shift before each capital, symbols from the symbols page.
export function typeText(typer, text) {
  for (const ch of text) {
    const lower = ch.toLowerCase();
    if (LETTERS.includes(lower)) {
      const wantUpper = ch !== lower;
      if (wantUpper && typer.shift === "off") typer.toggleShift();
      if (!wantUpper && typer.shift !== "off") typer.shift = "off";
      typer.letter(probs(lower));
    } else if (ch === "'" && typer.apostrophe) typer.apostrophe();
    else typer.literal(ch);
  }
  typer.literal(" ");
  return typer.text().trim();
}

let pass = 0;
const fails = [];
for (const item of ITEMS) {
  let ok = 0, last = "";
  for (let k = 0; k < TRIALS; k++) {
    const t = new KeyTyper(dec);
    t.shift = "off";
    if (process.env.LEARNED) t.learn(NAMES);
    last = typeText(t, item);
    if (last === item) ok++;
  }
  if (ok === TRIALS) pass++;
  else fails.push(`${item} -> ${last} (${ok}/${TRIALS})`);
}
console.log(`noise ${NOISE} | ${pass}/${ITEMS.length} typed exactly in every trial`);
for (const f of fails) console.log(`  miss: ${f}`);
