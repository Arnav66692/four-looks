// Head pointer: head pose -> smoothed screen point. Per person: an affine map fitted from
// a center look plus four corner looks, then a One Euro filter for jitter.

const EDGE = 0.04;          // how far past the screen edge the head may point before the mapping slides
const OFFSET_CAP = 0.8;     // most the mapping may slide, in screen units

class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: null });
  }
  static alpha(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  filter(x, t) {
    if (this.x == null) { this.x = x; this.t = t; return x; }
    const dt = Math.max((t - this.t) / 1000, 1e-3);
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

// Least squares for out = A * [yaw, pitch, 1].
function fitAffine(poses, targets) {
  const solve3 = (M, b) => {
    const a = M.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 3; c++) {
      let p = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      [a[c], a[p]] = [a[p], a[c]];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = a[r][c] / a[c][c];
        for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k];
      }
    }
    return a.map((row, i) => row[3] / row[i]);
  };
  const X = poses.map(([y, p]) => [y, p, 1]);
  const XtX = [0, 1, 2].map((i) => [0, 1, 2].map((j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const coef = (k) => solve3(XtX, [0, 1, 2].map((i) => X.reduce((s, r, n) => s + r[i] * targets[n][k], 0)));
  return [coef(0), coef(1)];
}

export class HeadPointer {
  // Heavy smoothing when the head is nearly still, light smoothing when it moves fast.
  // deadzone: moves smaller than this (screen units) are ignored, so a still head gives a still cursor.
  constructor({ minCutoff = 0.35, beta = 2.2, deadzone = 0.005, gain = 1 } = {}) {
    this.map = null; this.fx = new OneEuro(minCutoff, beta); this.fy = new OneEuro(minCutoff, beta);
    this.deadzone = deadzone; this.gain = gain; this.shown = null;
    this.offset = [0, 0];      // slow correction for posture drift, in screen units, learned from presses
  }

  // Recenter: make the direction the head points right now land on this screen point.
  recenter(pose, x = 0.5, y = 0.5) {
    if (!this.map || !pose) return false;
    const at = this.map.map((row) => 0.5 + this.gain * (row[0] * pose[0] + row[1] * pose[1] + row[2] - 0.5));
    this.offset = [x - at[0], y - at[1]];
    this.shown = null;
    return true;
  }
  get ready() { return !!this.map; }

  // poses: head pose samples (means). targets: matching points in 0..1 screen units.
  fit(poses, targets) { this.map = fitAffine(poses, targets); this.offset = [0, 0]; }

  // One-step calibration: the pose the person holds now points at (x, y). The range is fixed and
  // comfortable (radians of head turn for the full width and height), not however far they turned.
  // On a camera, turning toward screen-left and tilting up both raise the angle, so both signs are -1.
  center(pose, x = 0.5, y = 0.5, yawRange = 0.40, pitchRange = 0.26) {
    if (!pose) return false;
    this.map = [[-1 / yawRange, 0, x + pose[0] / yawRange], [0, -1 / pitchRange, y + pose[1] / pitchRange]];
    this.offset = [0, 0]; this.shown = null;
    return true;
  }

  // Pose -> point in 0..1 screen units, smoothed and clamped.
  point(pose, t) {
    if (!this.map || !pose) return null;
    const v = [pose[0], pose[1], 1];
    const raw = this.map.map((row, k) => 0.5 + this.gain * (row[0] * v[0] + row[1] * v[1] + row[2] * v[2] - 0.5) + this.offset[k]);
    // Edge re-centering: turning past the edge slides the mapping along, so turning back moves the
    // cursor straight away. This sheds whatever offset posture has built up.
    for (let k = 0; k < 2; k++) {
      const over = raw[k] < -EDGE ? raw[k] + EDGE : raw[k] > 1 + EDGE ? raw[k] - 1 - EDGE : 0;
      if (over) { this.offset[k] = Math.max(-OFFSET_CAP, Math.min(OFFSET_CAP, this.offset[k] - over)); raw[k] -= over; }
    }
    const clamp = (x) => Math.min(1, Math.max(0, x));
    const p = [clamp(this.fx.filter(raw[0], t)), clamp(this.fy.filter(raw[1], t))];
    if (this.shown && Math.hypot(p[0] - this.shown[0], p[1] - this.shown[1]) < this.deadzone) return this.shown;
    this.shown = p;
    return p;
  }

  // Unsmoothed, unclamped screen point. Used to spot quick gestures such as a nod.
  // gain 1 means "in units of the person's own calibrated range", whatever the reach setting is.
  raw(pose, gain = this.gain) {
    if (!this.map || !pose) return null;
    return this.map.map((row, k) => 0.5 + gain * (row[0] * pose[0] + row[1] * pose[1] + row[2] - 0.5) + (gain === 1 ? 0 : this.offset[k]));
  }

  toJSON() { return { map: this.map }; }
  static from(o) { const p = new HeadPointer(); p.map = o?.map || null; return p; }
}
