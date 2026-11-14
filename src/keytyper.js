// Text state for the full keyboard. Letters arrive as probabilities over a-z (where the
// pointer landed), and the decoder fixes near misses when a word ends. Pure logic, no DOM.

export const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const SURE = 0.6;            // a press this sure counts as typed exactly
const END_SENTENCE = /[.!?]\s*$/;

export class KeyTyper {
  constructor(decoder) {
    this.dec = decoder;
    this.committed = "";
    this.pending = [];       // [{ probs, char, upper }]
    this.shift = "once";     // off | once | lock. Starts capitalised.
  }

  letter(probs) {
    const char = LETTERS[probs.indexOf(Math.max(...probs))];
    this.pending = [...this.pending, { probs, char, upper: this.shift !== "off" }];
    if (this.shift === "once") this.shift = "off";
  }

  toggleShift() { this.shift = { off: "once", once: "lock", lock: "off" }[this.shift]; }

  // A symbol, digit or space. Finishes the word first.
  literal(str) {
    this.commitWord();
    if (str === " " && (this.committed === "" || this.committed.endsWith(" "))) return;
    if (/^[.,!?;:]$/.test(str) && this.committed.endsWith(" ")) this.committed = this.committed.slice(0, -1);
    this.committed += str;
    if (/^[.!?]$/.test(str)) { this.committed += " "; this.shift = "once"; }
  }

  backspace() {
    if (this.pending.length) { this.pending = this.pending.slice(0, -1); return; }
    this.committed = this.committed.slice(0, -1);
  }

  clear() { this.committed = ""; this.pending = []; this.shift = "once"; }

  history() {
    if (!this.committed.trim() || END_SENTENCE.test(this.committed)) return -1;
    const m = this.committed.toLowerCase().match(/([a-z']+)[^a-z']*$/);
    return m ? this.dec.idOf(m[1]) : -1;
  }

  typedWord() { return this.pending.map((p) => p.char).join(""); }

  caseLike(word) {
    if (/^i('|$)/.test(word)) word = "I" + word.slice(1);
    const ups = this.pending.map((p) => p.upper);
    if (ups.length > 1 && ups.every(Boolean)) return word.toUpperCase();
    if (ups[0]) return word[0].toUpperCase() + word.slice(1);
    return word;
  }

  // Ranked guesses for the word being typed, or next-word guesses if nothing is pending.
  suggestions(n = 3) {
    const hist = this.history();
    if (!this.pending.length) {
      const succ = this.dec.bigrams.get(hist);
      if (!succ) return [];
      return [...succ.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
        .map(([id]) => this.caseNext(this.dec.words[id]));
    }
    const guesses = this.dec.decodeWord(this.pending.map((p) => p.probs), hist, { top: n }).map((c) => this.caseLike(c.word));
    const typed = this.caseLike(this.typedWord());
    return [...new Set([...guesses, typed])].slice(0, n + 1);
  }

  caseNext(word) {
    if (/^i('|$)/.test(word)) word = "I" + word.slice(1);
    return this.shift !== "off" || this.committed === "" ? word[0].toUpperCase() + word.slice(1) : word;
  }

  // What a word end turns the pending letters into.
  bestWord() {
    if (!this.pending.length) return "";
    const typed = this.typedWord();
    const top = this.dec.decodeWord(this.pending.map((p) => p.probs), this.history(), { top: 1 })[0];
    if (!top) return this.caseLike(typed);
    // Sure presses that spell an unknown word far from any guess are probably a name: keep them.
    const sure = this.pending.every((p) => Math.max(...p.probs) >= SURE);
    const diff = [...typed].filter((c, i) => c !== top.word.replace(/'/g, "")[i]).length;
    if (sure && this.dec.idOf(typed) < 0 && diff * 2 > typed.length) return this.caseLike(typed);
    return this.caseLike(top.word);
  }

  commitWord() {
    if (!this.pending.length) return;
    this.committed += this.bestWord();
    this.pending = [];
  }

  // Take a suggestion chip: it replaces the word being typed, then a space.
  pick(word) {
    this.pending = [];
    this.committed += word + " ";
    if (this.shift === "once") this.shift = "off";
  }

  text() { return this.committed + this.typedWord(); }
}
