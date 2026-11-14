// Text state for the full keyboard. Letters arrive as probabilities over a-z (where the
// pointer landed). At a word end the typed letters compete with dictionary words: a dictionary
// word wins only if it fits the presses and the context clearly better. Pure logic, no DOM.

export const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const LOG10 = Math.log(10);
const OOV_PRIOR = -7.0;          // log10 word-model score given to a word the dictionary lacks
const LEARNED_PRIOR = -3.5;      // log10 score of a word from the person's own list
const ADDED_APOSTROPHE = -1.0;   // cost of a dictionary word adding an apostrophe you did not type
const RAW_CHARS = /[@#:/$_\-0-9+=&%*]/;   // once one of these is in a token, nothing in it is corrected
const SENTENCE_END = /[.!?]\s*$/;

export class KeyTyper {
  constructor(decoder) {
    this.dec = decoder;
    this.committed = "";
    this.pending = [];       // [{ probs, char, upper }] ; apostrophes are { char: "'", probs: null }
    this.shift = "once";     // off | once | lock. Starts capitalised.
    this.raw = false;        // inside an email, link, tag, time or number
    this.learned = new Set();
    this.undoStack = [];
    this.lastFix = null;     // { from, to } when autocorrect last changed a word
  }

  // Undo support: call save() before a change, undo() to step back.
  save() {
    this.undoStack.push({ committed: this.committed, pending: this.pending, shift: this.shift, raw: this.raw });
    if (this.undoStack.length > 60) this.undoStack.shift();
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    Object.assign(this, s);
    this.lastFix = null;
    return true;
  }

  learn(words) { for (const w of words) if (/^[a-z']+$/i.test(w)) this.learned.add(w.toLowerCase()); }

  // group: the press came from a big key holding several letters, so the letters themselves are unknown.
  letter(probs, { group = false } = {}) {
    const char = LETTERS[probs.indexOf(Math.max(...probs))];
    this.pending = [...this.pending, { probs, char, upper: this.shift !== "off", group }];
    if (this.shift === "once") this.shift = "off";
  }

  apostrophe() { this.pending = [...this.pending, { probs: null, char: "'", upper: false }]; }

  toggleShift() { this.shift = { off: "once", once: "lock", lock: "off" }[this.shift]; }

  // A symbol, digit or space.
  literal(str) {
    if (str === "'") { this.apostrophe(); return; }
    if (str === " ") {
      this.commitWord();
      this.raw = false;
      if (this.committed === "" || this.committed.endsWith(" ")) return;
      this.committed += " ";
      if (SENTENCE_END.test(this.committed)) this.shift = "once";
      return;
    }
    if (RAW_CHARS.test(str)) this.raw = true;
    this.commitWord();
    if (/^[.,!?;:]$/.test(str) && this.committed.endsWith(" ") && !this.raw) this.committed = this.committed.slice(0, -1);
    this.committed += str;
  }

  backspace() {
    if (this.pending.length) { this.pending = this.pending.slice(0, -1); return; }
    this.committed = this.committed.slice(0, -1);
  }

  clear() { this.committed = ""; this.pending = []; this.shift = "once"; this.raw = false; }

  history() {
    if (!this.committed.trim() || SENTENCE_END.test(this.committed)) return -1;
    const m = this.committed.toLowerCase().match(/([a-z']+)[^a-z']*$/);
    return m ? this.dec.idOf(m[1]) : -1;
  }

  typedWord() { return this.pending.map((p) => p.char).join(""); }
  groupMode() { return this.pending.some((p) => p.group); }
  // What to show for the word in progress: the letters as typed, or with big keys the best guess so far.
  typingDisplay() {
    if (!this.pending.length) return "";
    return this.groupMode() ? this.bestWord() : this.exactCase(this.typedWord());
  }
  letterSlots() { return this.pending.filter((p) => p.probs); }

  // Case the person typed on purpose: mixed case or all caps is kept exactly.
  deliberateCase() {
    const ups = this.letterSlots().map((p) => p.upper);
    const n = ups.filter(Boolean).length;
    return (n > 1 && n === ups.length) || ups.slice(1).some(Boolean);
  }

  caseLike(word) {
    const ups = this.letterSlots().map((p) => p.upper);
    if (ups.length > 1 && ups.every(Boolean)) return word.toUpperCase();
    let k = 0;
    const out = [...word.toLowerCase()].map((c) => (/[a-z]/.test(c) ? (ups[k++] ? c.toUpperCase() : c) : c)).join("");
    return out.replace(/^i('|$)/, (m) => "I" + m.slice(1));
  }

  caseNext(word) {
    if (/^i('|$)/.test(word)) word = "I" + word.slice(1);
    return this.shift !== "off" || this.committed === "" || SENTENCE_END.test(this.committed)
      ? word[0].toUpperCase() + word.slice(1) : word;
  }

  // Score the typed letters as their own word, against the same presses.
  typedScore() {
    let s = OOV_PRIOR;
    for (const p of this.letterSlots()) s += Math.log(Math.max(Math.max(...p.probs), 1e-9)) / LOG10;
    return s;
  }

  // Ranked choices: dictionary words and the typed letters, best first.
  ranked(n = 4) {
    const slots = this.letterSlots();
    const typed = this.typedWord();
    if (!slots.length) return [];
    const typedHasApostrophe = typed.includes("'");
    const cands = this.dec.decodeWord(slots.map((p) => p.probs), this.history(), { top: 8 }).map((c) => {
      let score = c.score;
      if (c.word.includes("'") && !typedHasApostrophe) score += ADDED_APOSTROPHE;
      if (typedHasApostrophe && c.word.replace(/[^']/g, "").length === 0) score += ADDED_APOSTROPHE;
      return { word: c.word, score };
    });
    for (const w of this.learned) {           // personal words compete like dictionary words
      const letters = w.replace(/[^a-z]/g, "");
      if (letters.length !== slots.length) continue;
      let sc = LEARNED_PRIOR;
      for (let k = 0; k < letters.length; k++) sc += Math.log(Math.max(slots[k].probs[LETTERS.indexOf(letters[k])], 1e-9)) / LOG10;
      cands.push({ word: w, score: sc, learned: true });
    }
    const typedIsWord = this.dec.idOf(typed.toLowerCase()) >= 0 || this.learned.has(typed.toLowerCase());
    if (!typedIsWord && !this.groupMode()) cands.push({ word: typed.toLowerCase(), score: this.typedScore(), typed: true });
    cands.sort((a, b) => b.score - a.score);
    const seen = new Set();
    return cands.filter((c) => !seen.has(c.word) && seen.add(c.word)).slice(0, n);
  }

  // What a word end turns the pending letters into.
  bestWord() {
    if (!this.pending.length) return "";
    const typed = this.typedWord();
    if (this.groupMode()) {
      const best = this.ranked(1)[0] || this.dec.completeWord(this.letterSlots().map((p) => p.probs), this.history(), { top: 1 })[0];
      return best ? this.caseLike(best.word) : "";
    }
    if (this.raw || this.deliberateCase() || !this.letterSlots().length) return this.exactCase(typed);
    const top = this.ranked(1)[0];
    return top.typed ? this.exactCase(typed) : this.caseLike(top.word);
  }

  exactCase(typed) {
    return this.pending.map((p) => (p.upper ? p.char.toUpperCase() : p.char)).join("").replace(/^i('|$)/, (m) => "I" + m.slice(1)) || typed;
  }

  // Chips: the word being typed, or next-word guesses between words.
  suggestions(n = 3) {
    if (!this.pending.length) {
      const succ = this.dec.bigrams.get(this.history());
      if (!succ) return [];
      return [...succ.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => this.caseNext(this.dec.words[id]));
    }
    const best = this.bestWord();
    const typed = this.exactCase(this.typedWord());
    const longer = this.completions(2);
    const others = this.raw ? [] : this.ranked(3).map((c) => (c.typed ? typed : this.caseLike(c.word)));
    // Best same-length word, the two likeliest longer words, then other same-length guesses and the exact letters.
    // Big keys: the best same-length word, then the likeliest longer word, then the rest.
    if (this.groupMode()) return [...new Set([best, longer[0], ...others, longer[1]])].filter(Boolean).slice(0, n + 2);
    const order = [best, ...longer, ...others, typed];
    const out = [...new Set(order)].slice(0, n + 1);
    if (!out.includes(typed) && typed !== best) out[out.length - 1] = typed;
    return out;
  }

  commitWord() {
    if (!this.pending.length) return;
    const typed = this.exactCase(this.typedWord()), best = this.bestWord();
    this.lastFix = best !== typed && !this.groupMode() ? { from: typed, to: best } : null;
    this.committed += best;
    this.pending = [];
  }

  // Longer words that start with what is typed so far.
  completions(n = 2) {
    const slots = this.letterSlots();
    if (!slots.length || ((this.raw || this.deliberateCase()) && !this.groupMode())) return [];
    return this.dec.completeWord(slots.map((p) => p.probs), this.history(), { top: n }).map((c) => this.caseLike(c.word));
  }

  // Grey text offered after the cursor: the rest of the likeliest word, or the likeliest next word.
  ghost() {
    if (this.pending.length) {
      const c = this.completions(1)[0];
      if (!c) return null;
      const shown = this.typingDisplay();
      // Only offer grey text that continues what is on screen.
      return c.toLowerCase().startsWith(shown.toLowerCase()) ? { word: c, tail: c.slice(shown.length) } : null;
    }
    if (!this.committed || !/\s$/.test(this.committed)) return null;
    const next = this.suggestions(1)[0];
    return next ? { word: next, tail: next } : null;
  }

  acceptGhost() {
    const g = this.ghost();
    if (!g) return null;
    this.pick(g.word);
    return g.word;
  }

  // Take a chip. Picking the exact typed letters teaches the keyboard that word.
  pick(word) {
    if (this.pending.length && word === this.exactCase(this.typedWord()) && this.dec.idOf(word.toLowerCase()) < 0) this.learn([word]);
    this.pending = [];
    this.committed += word + " ";
    this.raw = false;
    if (this.shift === "once") this.shift = "off";
  }

  text() { return this.committed + this.typingDisplay(); }
}
