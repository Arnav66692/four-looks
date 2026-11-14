// Typing state for Speed mode. Pure logic, no DOM, so it runs in Node tests too.
import { hardSlot } from "./decoder.js";

export class Typer {
  constructor(decoder) {
    this.dec = decoder;
    this.clear();
  }

  clear() {
    this.letters = [];          // current word: one probability array per letter
    this.words = [];            // finished words: slot arrays
    this.locked = new Map();    // word position -> word id the person fixed
    this.hyps = [];
  }

  box(probs) { this.letters = [...this.letters, probs]; }
  key(box) { this.box(hardSlot(box)); }

  endWord() {
    if (!this.letters.length) return false;
    this.words = [...this.words, this.letters];
    this.letters = [];
    this.redecode();
    return true;
  }

  // Undo the last letter. With no letters pending, step the last word to its next guess.
  undoOrNext() {
    if (this.letters.length) { this.letters = this.letters.slice(0, -1); return "letter"; }
    if (!this.words.length) return "none";
    const pos = this.words.length - 1;
    const hist = pos ? this.dec.idOf(this.top()[pos - 1]) : -1;
    const options = this.dec.decodeWord(this.words[pos], hist, { top: 6 }).map((c) => c.id);
    const current = this.dec.idOf(this.top()[pos]);
    const next = options[(options.indexOf(current) + 1) % options.length];
    this.locked = new Map(this.locked).set(pos, next);
    this.redecode();
    return "next";
  }

  deleteWord() {
    if (this.letters.length) { this.letters = []; return; }
    const pos = this.words.length - 1;
    if (pos < 0) return;
    this.words = this.words.slice(0, -1);
    const locked = new Map(this.locked);
    locked.delete(pos);
    this.locked = locked;
    this.redecode();
  }

  redecode() {
    this.hyps = this.words.length ? this.dec.decodeSentence(this.words, { locked: this.locked }) : [];
  }

  top() { return this.hyps[0]?.words || []; }

  // Live guesses for the word being typed, after the best sentence so far.
  liveGuesses(n = 3) {
    if (!this.letters.length) return [];
    const done = this.top();
    const hist = done.length ? this.dec.idOf(done[done.length - 1]) : -1;
    return this.dec.decodeWord(this.letters, hist, { top: n }).map((c) => c.word);
  }

  sentence() { return this.top().join(" "); }
  alternatives(n = 3) {
    const seen = new Set();
    return this.hyps.map((h) => h.words.join(" ")).filter((s) => !seen.has(s) && seen.add(s)).slice(0, n);
  }
}
