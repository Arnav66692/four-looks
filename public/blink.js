// Per-person blink model. Closure = mean of the two eyeBlink face scores (0 open, 1 shut).
// Calibration measures open eyes, firm blinks and normal blinks, then picks a closure line and a
// minimum length so firm blinks press and normal blinks do not.

export const DEFAULT_BLINK = { thr: 0.5, ms: 260, freeze: 0.35, calibrated: false };

export const closure = (scores) => ((scores.eyeBlinkLeft || 0) + (scores.eyeBlinkRight || 0)) / 2;

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const median = (xs) => pct(xs, 0.5);

// Lengths in ms of every run above thr in a series of { t, c } samples.
export function runs(series, thr) {
  const out = [];
  let start = null;
  for (const { t, c } of series) {
    if (c > thr && start == null) start = t;
    if (c <= thr && start != null) { out.push(t - start); start = null; }
  }
  if (start != null && series.length) out.push(series[series.length - 1].t - start);
  return out;
}

// open: closure samples with eyes open. firm: one series per firm blink. normal: one series of natural blinking.
export function fitBlink(open, firm, normal) {
  const openTop = pct(open, 0.95);
  const peaks = firm.map((s) => Math.max(...s.map((x) => x.c)));
  const peak = median(peaks);
  if (!(peak > openTop + 0.08)) {
    return { ...DEFAULT_BLINK, ok: false, why: `firm blinks only reached ${peak.toFixed(2)} against ${openTop.toFixed(2)} with eyes open` };
  }
  const thr = openTop + 0.5 * (peak - openTop);
  const freeze = openTop + 0.25 * (peak - openTop);
  const firmLens = firm.map((s) => Math.max(0, ...runs(s, thr)));
  const normalLens = runs(normal, thr);
  const firmLen = median(firmLens);
  const normalMax = normalLens.length ? Math.max(...normalLens) : 0;
  let ms = Math.max(normalMax + 50, 0.55 * firmLen, 120);
  const clean = ms <= 0.85 * firmLen;
  if (!clean) ms = Math.max(120, 0.85 * firmLen);
  return {
    thr: +thr.toFixed(3), freeze: +freeze.toFixed(3), ms: Math.round(ms), calibrated: true, ok: true,
    clean, openTop: +openTop.toFixed(3), peak: +peak.toFixed(3), firmLen: Math.round(firmLen), normalMax: Math.round(normalMax), normalCount: normalLens.length,
  };
}
