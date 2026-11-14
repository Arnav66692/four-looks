// Quick check: type sentences by box codes through the Typer, as the arrow keys do.
import { readFileSync } from "node:fs";
import { Decoder } from "../src/decoder.js";
import { Typer } from "../src/typer.js";
const dec = new Decoder(JSON.parse(readFileSync(new URL("../public/lm.json", import.meta.url))));
const t = new Typer(dec);
for (const s of ["i need help", "can you get my glasses", "hello how are you"]) {
  for (const w of s.split(" ")) { for (const ch of w) t.key(dec.boxOf[ch]); t.endWord(); }
  console.log(`${s} -> ${t.sentence()} | alts: ${t.alternatives(3).slice(1).join(" / ")}`);
  t.clear();
}
