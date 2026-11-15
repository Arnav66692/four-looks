// Head pointer: head pose -> smoothed screen point. Per person: an affine map fitted from
// the calibration dots, then a steady filter for tremor. The cursor is drawn where the head points.

const EDGE_ZONE = 0.36;     // further than this from the middle of the screen the cursor turns calmer
const EDGE_GAIN = 0.6;      // out there it moves this much for the same head move
const EDGE_STEADY = 1.8;    // and ignores this much more tremor (head pose is noisier at big angles)
const soften = (v) => { const d = v - 0.5, a = Math.abs(d); return a <= EDGE_ZONE ? v : 0.5 + Math.sign(d) * (EDGE_ZONE + (a - EDGE_ZONE) * EDGE_GAIN); };
const edginess = (v) => Math.min(1, Math.max(0, (Math.abs(v - 0.5) - EDGE_ZONE) / (0.5 - EDGE_ZONE)));
// Fine control. A slow, small head movement moves the cursor at reduced gain, so a small correction is
// easy to land and tremor shows up half as large. A fast, large movement moves it fully and pulls the
// cursor back onto the exact spot the head points at. The cursor is never more than FINE_MAX_OFF keys
// away from that spot, and at rest it does not creep.
const FINE_GAIN = 0.5;      // gain for slow movements
const FINE_SLOW = 1.5;      // key widths a second: at or below this the movement is slow
const FINE_FAST = 5;        // at or above this it is fast: full gain and catch up
const FINE_CATCH = 0.35;    // share of the remaining gap closed each frame while moving fast
const FINE_MAX_OFF = 0.35;  // the cursor may sit this many keys from where the head points, no more
const MAX_STEP = 0.12;      // the most one camera frame may move the reading, in screen units
// Look-ahead is off: on the simulated face with 120 ms camera delay it cut 50 ms of lag but more than
// doubled overshoot (about 64 px against 23 px on a 300 px move). Add ?lead=1 to the address to try it.
const LEAD_ON = new URLSearchParams(globalThis.location?.search || "").get("lead") === "1";
const LEAD_S = 0.09;        // the cursor is drawn where the head will be this many seconds from now, to hide camera delay
const LEAD_MIN_SPEED = 0.25; // screen units a second: below this the head is settling, so no look-ahead
const LEAD_CAP = 0.07;      // most the look-ahead may add, in screen units

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

// Steady filter. First a median of the last three samples removes single-frame jumps. Then the
// smoothing depends on how far the head has moved from where the cursor sits: inside the tremor band
// the cursor barely moves, and once the head has clearly moved the cursor follows it directly.
class Steady {
  constructor(aMin = 0.05, band = 0.010, full = 0.04) { Object.assign(this, { aMin, band, full, y: null, last: null }); }
  filter(x, steady = 1) {
    // Spike guard with no delay: one frame cannot move the reading further than a fast real head move would.
    const m = this.last == null ? x : this.last + Math.max(-MAX_STEP, Math.min(MAX_STEP, x - this.last));
    this.last = m;
    if (this.y == null) { this.y = m; return m; }
    const band = this.band * steady, full = this.full + (band - this.band);
    const k = Math.min(1, Math.max(0, (Math.abs(m - this.y) - band) / (full - band)));
    this.y += (this.aMin + (1 - this.aMin) * k * k) * (m - this.y);
    return this.y;
  }
}

export class HeadPointer {
  // Heavy smoothing when the head is nearly still, light smoothing when it moves fast.
  // deadzone: moves smaller than this (screen units) are ignored, so a still head gives a still cursor.
  constructor({ aMin = 0.05, band = 0.010, full = 0.04, deadzone = 0.003, gain = 1 } = {}) {
    this.map = null;           // affine map, from the older many-dot calibration
    this.range = null;         // the person's own comfortable range: { c, left, right, up, down, area }
    this.fx = new Steady(aMin, band, full); this.fy = new Steady(aMin, band, full);
    this.deadzone = deadzone; this.gain = gain; this.shown = null;
    this.lead = LEAD_ON ? LEAD_S : 0; this.vel = [0, 0]; this.leadPrev = null; this.leadT = 0;
    this.offset = [0, 0];      // set only by a deliberate recenter, in screen units
    this.steady = 1;           // above 1 while a key is locked: small head tremor moves the cursor less
    this.past = { left: 0, right: 0, up: 0, down: 0 };
    this.precision = false;    // fine control: off unless switched on (it failed its test as a default)
    this.unit = [0.1, 0.13];   // one key, as a share of the window width and height (set by the page)
    this.fineAt = null; this.finePrev = null; this.fineT = 0; this.fineV = 0;
  }
  get ready() { return !!(this.map || this.range); }

  // Change how much the cursor is smoothed. Restarts the filters so the change is felt at once.
  smoothing({ aMin = 0.05, band = 0.010, full = 0.04, deadzone = 0.003 } = {}) {
    this.fx = new Steady(aMin, band, full); this.fy = new Steady(aMin, band, full);
    this.deadzone = deadzone; this.shown = null;
    this.smooth = { aMin, band, full, deadzone };
  }

  // poses: head pose samples (means). targets: matching points in 0..1 screen units.
  fit(poses, targets) { this.map = fitAffine(poses, targets); this.range = null; this.offset = [0, 0]; this.fineAt = null; }

  // Calibration to the person's own range. c is the pose facing the middle. left, right, up and down
  // are the poses at the furthest comfortable turn each way. area says where those should land on
  // screen: { cx, cy, left, right, top, bottom } in 0..1. A side that barely moved gets a default span.
  fitRange(c, ext, area, minSpan = 0.05) {
    const span = (v, base, fallback) => (Math.abs(v - base) >= minSpan ? v - base : fallback);
    this.range = {
      c,
      left: span(ext.left[0], c[0], 0.2), right: span(ext.right[0], c[0], -0.2),
      up: span(ext.up[1], c[1], 0.13), down: span(ext.down[1], c[1], -0.13),
      area,
    };
    this.map = null; this.offset = [0, 0]; this.shown = null;
  }

  // Pose -> screen point, before smoothing. gain stretches the motion around the centre.
  project(pose, gain = this.gain) {
    if (this.range) {
      const r = this.range, dx = pose[0] - r.c[0], dy = pose[1] - r.c[1];
      const x = dx * r.left > 0 ? r.area.cx + gain * (dx / r.left) * (r.area.left - r.area.cx) : r.area.cx + gain * (dx / r.right) * (r.area.right - r.area.cx);
      const y = dy * r.up > 0 ? r.area.cy + gain * (dy / r.up) * (r.area.top - r.area.cy) : r.area.cy + gain * (dy / r.down) * (r.area.bottom - r.area.cy);
      return [x, y];
    }
    return this.map.map((row) => 0.5 + gain * (row[0] * pose[0] + row[1] * pose[1] + row[2] - 0.5));
  }

  // Recenter: make the direction the head points right now land on this screen point.
  recenter(pose, x = 0.5, y = 0.5) {
    if (!this.ready || !pose) return false;
    const at = this.project(pose);
    this.offset = [x - at[0], y - at[1]];
    this.shown = null; this.fineAt = null;
    return true;
  }

  // One-step calibration with a fixed range, kept for quick starts.
  center(pose, x = 0.5, y = 0.5, yawRange = 0.40, pitchRange = 0.26) {
    if (!pose) return false;
    this.map = [[-1 / yawRange, 0, x + pose[0] / yawRange], [0, -1 / pitchRange, y + pose[1] / pitchRange]];
    this.range = null; this.offset = [0, 0]; this.shown = null;
    return true;
  }

  // Pose -> point in 0..1 screen units, smoothed and clamped.
  point(pose, t) {
    if (!this.ready || !pose) return null;
    const raw = this.project(pose).map((v, k) => soften(v + this.offset[k]));
    // The mapping never slides by itself. In a real session the old edge re-centering moved it about
    // 400 px sideways after one look away, which put some keys out of reach. Recenter is deliberate only.
    const clamp = (x) => Math.min(1, Math.max(0, x));
    const calm = (k) => this.steady * (1 + (EDGE_STEADY - 1) * edginess(raw[k]));
    const f = [this.fx.filter(raw[0], calm(0)), this.fy.filter(raw[1], calm(1))];
    // How far past the edge of the window the head points, per side, in screen units (0 when inside).
    this.past = { left: Math.max(0, -f[0]), right: Math.max(0, f[0] - 1), up: Math.max(0, -f[1]), down: Math.max(0, f[1] - 1) };
    const g = this.fine(f, t);
    // Look-ahead: while the head is clearly moving, draw the cursor a little ahead along its path.
    // A cursor that trails the head makes people turn too far and swing back.
    const dt = this.leadT ? Math.max((t - this.leadT) / 1000, 1e-3) : 0;
    const p = [0, 1].map((k) => {
      if (!dt || !this.leadPrev) return clamp(g[k]);
      this.vel[k] += 0.5 * ((f[k] - this.leadPrev[k]) / dt - this.vel[k]);
      const v = this.vel[k], lead = this.lead > 0 && Math.abs(v) > LEAD_MIN_SPEED ? Math.max(-LEAD_CAP, Math.min(LEAD_CAP, v * this.lead)) : 0;
      return clamp(g[k] + lead);
    });
    this.leadPrev = f; this.leadT = t;
    if (this.shown && Math.hypot(p[0] - this.shown[0], p[1] - this.shown[1]) < this.deadzone) return this.shown;
    this.shown = p;
    return p;
  }

  // Fine control: target is where the head points (unclamped, so the cursor can still be pushed to an edge).
  fine(target, t) {
    if (!this.precision || !this.fineAt || !this.finePrev) { this.fineAt = target.slice(); this.finePrev = target.slice(); this.fineT = t; this.fineV = 0; return target; }
    const dt = Math.max((t - this.fineT) / 1000, 1e-3);
    this.fineT = t;
    const dx = target[0] - this.finePrev[0], dy = target[1] - this.finePrev[1];
    this.finePrev = target.slice();
    const v = Math.hypot(dx / this.unit[0], dy / this.unit[1]) / dt;
    this.fineV += 0.4 * (v - this.fineV);                         // smoothed, so one noisy frame does not flip the gain
    const k = Math.min(1, Math.max(0, (this.fineV - FINE_SLOW) / (FINE_FAST - FINE_SLOW))), s = k * k * (3 - 2 * k);
    const gain = FINE_GAIN + (1 - FINE_GAIN) * s;
    let x = this.fineAt[0] + gain * dx, y = this.fineAt[1] + gain * dy;
    x += FINE_CATCH * s * (target[0] - x); y += FINE_CATCH * s * (target[1] - y);
    const ox = (x - target[0]) / this.unit[0], oy = (y - target[1]) / this.unit[1], off = Math.hypot(ox, oy);
    if (off > FINE_MAX_OFF) { x = target[0] + (ox / off) * FINE_MAX_OFF * this.unit[0]; y = target[1] + (oy / off) * FINE_MAX_OFF * this.unit[1]; }
    this.fineAt = [x, y];
    return this.fineAt;
  }

  // Unsmoothed, unclamped screen point. Used to spot quick gestures such as a nod.
  // gain 1 means "in units of the person's own calibrated range", whatever the reach setting is.
  raw(pose, gain = this.gain) {
    if (!this.ready || !pose) return null;
    return this.project(pose, gain).map((v, k) => v + (gain === 1 ? 0 : this.offset[k]));
  }

  toJSON() { return { map: this.map, range: this.range }; }
  static from(o) { const p = new HeadPointer(); p.map = o?.map || null; p.range = o?.range || null; return p; }
}
