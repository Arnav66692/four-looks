// Text state for the full keyboard. Letters arrive as probabilities over a-z (where the
// pointer landed). At a word end the typed letters compete with dictionary words: a dictionary
// word wins only if it fits the presses and the context clearly better. Pure logic, no DOM.

export const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const LOG10 = Math.log(10);
const OOV_PRIOR = -7.0;          // log10 word-model score given to a word the dictionary lacks
const LEARNED_PRIOR = -3.5;      // log10 score of a word from the person's own list
const MIXED_CASE = new Map(["YouTube", "iPhone", "iPad", "eBay", "MacBook", "GitHub", "LinkedIn", "PayPal", "ChatGPT", "WiFi", "TikTok", "JavaScript", "PowerPoint", "FaceTime", "iMessage", "AirPods", "McDonald"].map((w) => [w.toLowerCase(), w]));
const WEB_ENDS = new Set(["com", "org", "net", "edu", "gov", "io", "ai", "co", "app", "dev", "us", "uk"]);
const EDIT_COST = 2.0;        // what one spelling edit costs a suggestion (log10 units)
const SPELL_LETTERS = "abcdefghijklmnopqrstuvwxyz'";
// Every string one edit away: a letter dropped, two letters swapped, a letter changed, a letter added.
function edits1(w) {
  const out = new Set();
  for (let i = 0; i <= w.length; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (b) out.add(a + b.slice(1));
    if (b.length > 1) out.add(a + b[1] + b[0] + b.slice(2));
    for (const c of SPELL_LETTERS) { if (b) out.add(a + c + b.slice(1)); out.add(a + c + b); }
  }
  out.delete(w);
  return out;
}
const USED_BOOST = 0.35;      // how much a word this person has used before rises (log10 units per tenfold use)
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
    this.autoSpace = true;   // put a space after punctuation without being asked
    this.autoDot = false;    // the last thing added was a full stop and its automatic space
    this.used = new Map();   // how often this person has used each word: their words rise in the guesses
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

  noteUse(word) {
    const w = String(word).toLowerCase().replace(/[^a-z']/g, "");
    if (w) this.used.set(w, (this.used.get(w) || 0) + 1);
  }
  // Extra score for a word this person has used before (log10 units, grows slowly).
  boost(word) { return USED_BOOST * Math.log10(1 + (this.used.get(String(word).toLowerCase()) || 0)); }

  learn(words) { for (const w of words) if (/^[a-z']+$/i.test(w)) this.learned.add(w.toLowerCase()); }

  // group: the press came from a big key holding several letters, so the letters themselves are unknown.
  letter(probs, { group = false } = {}) {
    this.alt = 0;
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
    const mark = /^[.,!?;:]$/.test(str) && !this.raw;
    if (mark && this.committed.endsWith(" ")) this.committed = this.committed.slice(0, -1);      // "word ." becomes "word."
    this.committed += str;
    // Auto space: a comma, full stop, question mark and the like are followed by a space without asking,
    // and the next sentence starts with a capital. Off while a command for Grok is typed (web addresses).
    // A full stop only gets its space after a word the dictionary knows, so names and web addresses
    // such as sandhacks.devpost.com are left in one piece.
    const before = this.committed.slice(0, -1).split(/\s+/).pop().toLowerCase().replace(/[^a-z']/g, "");
    const known = this.dec.idOf(before) >= 0 || this.learned.has(before);
    this.autoDot = false;
    if (mark && this.autoSpace && this.committed.length > 1 && (str !== "." || known)) {
      this.committed += " ";
      this.autoDot = str === ".";
      if (SENTENCE_END.test(this.committed)) this.shift = "once";
    }
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
    if (this.groupMode()) return this.bestWord();
    // Exactly the keys pressed. Showing the guesser's belief instead made a pressed U read as L
    // whenever an L word was likelier, which looked like the wrong key had fired. Autocorrect still
    // runs when the word ends, and a shake or undo refuses it.
    return this.exactCase(this.typedWord());
  }

  // The letters shown while a word is in progress. A press that landed on a neighbouring key shows the
  // letter the word guesser believes, so a near miss does not look like a mistake that needs deleting.
  likelyLetters() {
    const typed = this.exactCase(this.typedWord());
    const slots = this.letterSlots();
    if (this.raw || this.deliberateCase() || !slots.length) return typed;
    const probs = slots.map((p) => p.probs), hist = this.history();
    const best = [...this.ranked(2), ...this.dec.completeWord(probs, hist, { top: 2 })].sort((x, y) => y.score - x.score)[0];
    if (!best || best.typed) return typed;
    // Keep any apostrophes the person typed, and take the believed letters for the letter positions.
    const letters = best.word.replace(/[^a-z]/g, "");
    let k = 0;
    return this.pending.map((p) => { if (!p.probs) return p.char; const c = letters[k++] || p.char; return p.upper ? c.toUpperCase() : c; }).join("").replace(/^i('|$)/, (m) => "I" + m.slice(1));
  }
  letterSlots() { return this.pending.filter((p) => p.probs); }

  // Case the person typed on purpose: mixed case or all caps is kept exactly.
  deliberateCase() {
    const ups = this.letterSlots().map((p) => p.upper);
    const n = ups.filter(Boolean).length;
    if (n > 1 && n === ups.length) return true;                 // ALL CAPS is on purpose
    if (!ups.slice(1).some(Boolean)) return false;              // at most a leading capital
    // A capital in the middle. Known mixed-case names (YouTube, iPhone) and words the dictionary does not
    // know are kept as typed. An ordinary dictionary word with one capital inside it (fInding) is a
    // slipped shift, and is treated as lower case.
    const typed = this.exactCase(this.typedWord()), lower = typed.toLowerCase();
    const stem = typed.replace(/'s$/i, "");
    if (MIXED_CASE.get(stem.toLowerCase()) === stem) return true;
    return this.dec.idOf(lower) < 0 && !this.learned.has(lower);
  }
  // The capitals that count: all of them when the case is on purpose, otherwise only a leading one.
  caps() {
    const ups = this.letterSlots().map((p) => p.upper);
    return this.deliberateCase() ? ups : ups.map((u, i) => i === 0 && u);
  }

  caseLike(word) {
    const ups = this.caps();
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
      // Do not offer a word the person used in the last two words ("I am I").
      const recent = new Set(this.committed.toLowerCase().trim().split(/\s+/).slice(-2));
      return [...succ.entries()].map(([id, lp]) => [id, lp + this.boost(this.dec.words[id])]).sort((a, b) => b[1] - a[1])
        .filter(([id]) => !recent.has(this.dec.words[id])).slice(0, n).map(([id]) => this.caseNext(this.dec.words[id]));
    }
    const best = this.bestWord();
    const typed = this.exactCase(this.typedWord());
    const longer = this.completions(3);
    const others = this.raw ? [] : this.ranked(3).map((c) => (c.typed ? typed : this.caseLike(c.word)));
    // Best same-length word, the two likeliest longer words, then other same-length guesses and the exact letters.
    // Big keys: the best same-length word, then the likeliest longer word, then the rest.
    if (this.groupMode()) return [...new Set([best, longer[0], ...others, longer[1]])].filter(Boolean).slice(0, n + 2);
    // The first (bold) guess is the likeliest LONGER word. The same-length word is what space gives anyway,
    // and in his own sessions 8 of 12 words picked while typing were longer than the letters typed.
    // When the letters typed are not a word at all, the closest real spellings lead ("wter" shows water).
    const lower = typed.toLowerCase();
    const unknown = this.dec.idOf(lower) < 0 && !this.learned.has(lower);
    const fixes = this.spell(3).map((w) => this.caseLike(w));
    const order = (unknown && fixes.length
      ? [fixes[0], longer[0], best, fixes[1], fixes[2], longer[1], ...others, typed]
      : [longer[0], best, longer[1], fixes[0], longer[2], ...others, typed]).filter(Boolean);
    const out = [...new Set(order)].slice(0, n + 1);
    if (!out.includes(typed) && typed !== best) out[out.length - 1] = typed;
    return out;
  }

  commitWord() {
    if (!this.pending.length) return;
    let typed = this.exactCase(this.typedWord()), best = this.bestWord();
    // The end of a web address: google. + com is put back together as google.com, and whatever follows a
    // full stop with no space (devpost.com, name.surname) is kept exactly as typed, never autocorrected.
    const tld = WEB_ENDS.has(typed.toLowerCase());
    if (!this.groupMode() && ((this.autoDot && tld) || /[a-z0-9]\.$/i.test(this.committed))) {
      if (this.autoDot && tld) this.committed = this.committed.slice(0, -1);
      typed = best = typed.toLowerCase();
    }
    this.autoDot = false;
    this.lastFix = best !== typed && !this.groupMode() ? { from: typed, to: best } : null;
    this.noteUse(best);
    this.committed += best;
    this.pending = [];
  }

  // Autocorrect just changed a word and the person said no: put back the exact letters they typed, and
  // remember that word so it is left alone from now on. Only that word is affected.
  keepTyped(fix) {
    const tail = this.committed.match(/\s*$/)[0];
    const body = this.committed.slice(0, this.committed.length - tail.length);
    if (!fix || !body.endsWith(fix.to)) return false;
    this.committed = body.slice(0, body.length - fix.to.length) + fix.from + tail;
    this.learn([fix.from]);
    return true;
  }

  // Spelling suggestions: dictionary words a letter or two away from what was typed, where an edit is a
  // missing letter, an extra letter, a wrong letter, or two letters swapped ("wter" gives water, "hepl" gives
  // help, "outsdie" gives outside). This was In A Park's idea, with a spelling-dictionary lookup in place of
  // a fixed list. Here the words are ranked by how likely each is after the word before, less a cost per edit.
  spell(n = 3) {
    const typed = this.typedWord().toLowerCase();
    if (typed.length < 2 || this.raw || this.groupMode() || !/^[a-z']+$/.test(typed)) return [];
    const hist = this.history(), key = `${typed}|${hist}|${n}`;
    if (this.spellCache?.key === key) return this.spellCache.out;
    const found = new Map();
    const add = (word, edits) => {
      if (word === typed || found.has(word)) return;
      const id = this.dec.idOf(word);
      if (id >= 0) found.set(word, this.dec.lm(hist, id) - EDIT_COST * edits + this.boost(word));
      else if (this.learned.has(word)) found.set(word, LEARNED_PRIOR - EDIT_COST * edits);
    };
    const near = edits1(typed);
    for (const w of near) add(w, 1);
    if (found.size < n && typed.length >= 4) for (const w1 of near) for (const w2 of edits1(w1)) add(w2, 2);      // two edits only when one is not enough
    const out = [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
    this.spellCache = { key, out };
    return out;
  }

  // Longer words that start with what is typed so far.
  completions(n = 2) {
    const slots = this.letterSlots();
    if (!slots.length || ((this.raw || this.deliberateCase()) && !this.groupMode())) return [];
    return this.dec.completeWord(slots.map((p) => p.probs), this.history(), { top: n + 5 })
      .map((c) => ({ word: c.word, score: c.score + this.boost(c.word) })).sort((a, b) => b.score - a.score)
      .slice(0, n).map((c) => this.caseLike(c.word));
  }

  // The words most likely to follow a word, one after another (a short phrase guess).
  chain(word, n = 2) {
    const out = [];
    let id = this.dec.idOf(word.toLowerCase());
    const seen = new Set([id]);
    for (let k = 0; k < n && id >= 0; k++) {
      const succ = this.dec.bigrams.get(id);
      if (!succ) break;
      let best = -1, bestLp = -Infinity;
      for (const [w, lp] of succ) if (lp > bestLp && !seen.has(w)) { best = w; bestLp = lp; }      // never loop back to a word already in the phrase
      if (best < 0) break;
      const next = this.dec.words[best];
      out.push(/^i('|$)/.test(next) ? "I" + next.slice(1) : next);
      id = best; seen.add(best);
    }
    return out;
  }

  // Grey text offered after the cursor: the rest of the likeliest word (or the likeliest next word),
  // plus the words likely to follow. this.alt steps through other first words (a head shake).
  ghost() {
    let options;
    if (this.pending.length) {
      const shown = this.typingDisplay().toLowerCase();
      options = this.completions(3).filter((c) => c.toLowerCase().startsWith(shown));     // only text that continues what is on screen
    } else {
      if (!this.committed || !/\s$/.test(this.committed)) return null;
      options = this.suggestions(3);
    }
    if (!options.length) return null;
    const word = options[(this.alt || 0) % options.length];
    const shownLen = this.pending.length ? this.typingDisplay().length : 0;
    return { word, tail: word.slice(shownLen), more: this.chain(word, 2), options: options.length };
  }
  nextGhost() { this.alt = (this.alt || 0) + 1; }

  acceptGhost() {
    const g = this.ghost();
    if (!g) return null;
    this.pick(g.word);
    return g;
  }

  // Take a chip. Picking the exact typed letters teaches the keyboard that word.
  pick(word) {
    this.alt = 0;
    if (this.pending.length && word === this.exactCase(this.typedWord()) && this.dec.idOf(word.toLowerCase()) < 0) this.learn([word]);
    this.pending = [];
    this.noteUse(word);
    if (this.committed && !/\s$/.test(this.committed)) this.committed += " ";      // never glue a picked word onto the one before
    this.committed += word + " ";
    this.raw = false;
    if (this.shift === "once") this.shift = "off";
  }

  text() { return this.committed + this.typingDisplay(); }
}
