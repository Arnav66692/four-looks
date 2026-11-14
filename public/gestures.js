// Turns face frames into events: head gestures with soft box probabilities, and held face cues.
// The head model is per person: a Gaussian per direction, fitted from calibration samples.

const HOLD_FRAMES = 8;          // frames past the reach line before a head gesture counts
const ENTER = 2 / 3;            // fraction of the person's own reach that starts a gesture
const EXIT = 1 / 3;             // fraction that ends it (head back near rest)
const CUES = {
  blink: { test: (s) => (s.eyeBlinkLeft || 0) > 0.55 && (s.eyeBlinkRight || 0) > 0.55, ms: 450 },
  mouth: { test: (s) => (s.jawOpen || 0) > 0.45, ms: 400 },
  brows: { test: (s) => (s.browInnerUp || 0) > 0.55, ms: 900 },
};

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export class HeadModel {
  constructor() { this.rest = null; this.protos = null; this.sigma = 0.1; this.reach = 0.2; }
  get ready() { return !!(this.rest && this.protos); }

  // restSamples: head vectors at rest. dirSamples: 4 arrays of peak head vectors, one per box.
  fit(restSamples, dirSamples) {
    const mean = (xs) => [xs.reduce((a, v) => a + v[0], 0) / xs.length, xs.reduce((a, v) => a + v[1], 0) / xs.length];
    this.rest = mean(restSamples);
    this.protos = dirSamples.map((xs) => mean(xs));
    this.reach = this.protos.reduce((a, p) => a + dist(p, this.rest), 0) / 4;
    const spread = dirSamples.flatMap((xs, k) => xs.map((v) => dist(v, this.protos[k])));
    const rms = Math.sqrt(spread.reduce((a, d) => a + d * d, 0) / Math.max(spread.length, 1));
    this.sigma = Math.max(rms, this.reach * 0.15);
  }

  // Soft signal: probability of each box given the peak head vector.
  probs(v) {
    const logits = this.protos.map((p) => -(dist(v, p) ** 2) / (2 * this.sigma ** 2));
    const m = Math.max(...logits);
    const e = logits.map((x) => Math.exp(x - m));
    const z = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / z);
  }

  toJSON() { return { rest: this.rest, protos: this.protos, sigma: this.sigma, reach: this.reach }; }
  static from(o) { const m = new HeadModel(); Object.assign(m, o); return m; }
}

export class GestureReader {
  constructor(model, emit) {
    this.model = model;
    this.emit = emit;
    this.state = "rest";
    this.count = 0;
    this.peak = null;
    this.cueSince = {};
    this.cueFired = {};
  }

  frame({ t, head, scores, face }) {
    if (!face) return;
    this.readCues(t, scores);
    if (!this.model.ready || this.cueBusy()) return;
    const d = dist(head, this.model.rest);
    if (this.state === "rest") {
      if (d > this.model.reach * ENTER) {
        this.count++;
        if (!this.peak || d > dist(this.peak, this.model.rest)) this.peak = head;
        if (this.count >= HOLD_FRAMES) this.state = "out";
      } else { this.count = 0; this.peak = null; }
    } else if (this.state === "out") {
      if (d > dist(this.peak, this.model.rest)) this.peak = head;
      if (d < this.model.reach * EXIT) {
        const probs = this.model.probs(this.peak);
        this.emit({ type: "box", t, probs, peak: this.peak });
        this.state = "rest"; this.count = 0; this.peak = null;
      }
    }
  }

  cueBusy() { return Object.values(this.cueSince).some((v) => v != null); }

  readCues(t, s) {
    for (const [name, cue] of Object.entries(CUES)) {
      if (cue.test(s)) {
        if (this.cueSince[name] == null) this.cueSince[name] = t;
        if (!this.cueFired[name] && t - this.cueSince[name] >= cue.ms) {
          this.cueFired[name] = true;
          this.emit({ type: name, t });
        }
      } else { this.cueSince[name] = null; this.cueFired[name] = false; }
    }
  }
}
