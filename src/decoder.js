// Four Looks decoder. Turns a word's worth of uncertain box signals into ranked words.
// Runs in the browser and in Node. Scores are log10.

export const SPEED_GROUPS = ["abcdef", "ghijklm", "nopqrs", "tuvwxyz"];
export const BOX_COUNT = 4;

const LOG10 = Math.log(10);

export function letterToBox(groups = SPEED_GROUPS) {
  const map = {};
  groups.forEach((g, i) => { for (const ch of g) map[ch] = i; });
  return map;
}

export function codeOf(word, boxOf) {
  const code = [];
  for (const ch of word) if (ch in boxOf) code.push(boxOf[ch]);
  return code;
}

// A confusion table C[intended][observed]. Starts close to identity and is refit per person.
export function defaultConfusion(slip = 0.0001) {
  return Array.from({ length: BOX_COUNT }, (_, i) =>
    Array.from({ length: BOX_COUNT }, (_, j) => (i === j ? 1 - slip : slip / (BOX_COUNT - 1))));
}

export class Decoder {
  constructor(model, { groups = SPEED_GROUPS, confusion = defaultConfusion() } = {}) {
    this.words = model.words;
    this.uni = Float64Array.from(model.uni);
    this.backoff = Float64Array.from(model.backoff);
    this.startBackoff = model.startBackoff;
    this.bigrams = new Map();
    for (const [h, flat] of Object.entries(model.bigrams)) {
      const m = new Map();
      for (let k = 0; k < flat.length; k += 2) m.set(flat[k], flat[k + 1]);
      this.bigrams.set(Number(h), m);
    }
    this.index = new Map(this.words.map((w, i) => [w, i]));
    this.setGroups(groups);
    this.confusion = confusion;
  }

  setGroups(groups) {
    this.groups = groups;
    this.boxOf = letterToBox(groups);
    this.byLength = new Map();
    this.codes = this.words.map((w, i) => {
      const code = codeOf(w, this.boxOf);
      if (!this.byLength.has(code.length)) this.byLength.set(code.length, []);
      this.byLength.get(code.length).push(i);
      return code;
    });
  }

  // Word model score of word index w after history index h (-1 means sentence start).
  lm(h, w) {
    const succ = this.bigrams.get(h);
    if (succ && succ.has(w)) return succ.get(w);
    const bo = h === -1 ? this.startBackoff : (this.backoff[h] || 0);
    return bo + this.uni[w];
  }

  // slots: one entry per letter, each a probability array over the 4 boxes.
  // Channel: P(signal | intended box c) = sum over observed o of C[c][o] * p[o].
  decodeWord(slots, history = -1, { top = 5, lmWeight = 1 } = {}) {
    const ids = this.byLength.get(slots.length);
    if (!ids) return [];
    const channel = slots.map((p) => {
      const row = new Float64Array(BOX_COUNT);
      for (let c = 0; c < BOX_COUNT; c++) {
        let s = 0;
        for (let o = 0; o < BOX_COUNT; o++) s += this.confusion[c][o] * p[o];
        row[c] = Math.log(Math.max(s, 1e-9)) / LOG10;
      }
      return row;
    });
    const best = [];
    for (const w of ids) {
      const code = this.codes[w];
      let score = lmWeight * this.lm(history, w);
      for (let k = 0; k < code.length; k++) score += channel[k][code[k]];
      if (best.length < top || score > best[best.length - 1].score) {
        best.push({ word: this.words[w], id: w, score });
        best.sort((a, b) => b.score - a.score);
        if (best.length > top) best.pop();
      }
    }
    return best;
  }

  // Re-decode a whole sentence so later words can fix earlier ones.
  // wordSlots: array of slot arrays, one per word. locked: map of word position -> word id the user fixed.
  decodeSentence(wordSlots, { beam = 40, perWord = 15, locked = new Map() } = {}) {
    let hyps = [{ ids: [], score: 0 }];
    wordSlots.forEach((slots, pos) => {
      const next = [];
      const cache = new Map();
      for (const h of hyps) {
        const hist = h.ids.length ? h.ids[h.ids.length - 1] : -1;
        let cands;
        if (locked.has(pos)) {
          const w = locked.get(pos);
          cands = [{ id: w, score: this.lm(hist, w) }];
        } else {
          if (!cache.has(hist)) cache.set(hist, this.decodeWord(slots, hist, { top: perWord }));
          cands = cache.get(hist);
        }
        for (const c of cands) next.push({ ids: [...h.ids, c.id], score: h.score + c.score });
      }
      next.sort((a, b) => b.score - a.score);
      hyps = next.slice(0, beam);
    });
    return hyps.map((h) => ({ words: h.ids.map((i) => this.words[i]), score: h.score }));
  }

  idOf(word) { return this.index.has(word) ? this.index.get(word) : -1; }
}

// A hard pick as a probability array, for keys and switches.
export function hardSlot(box) {
  return Array.from({ length: BOX_COUNT }, (_, i) => (i === box ? 1 : 0));
}
