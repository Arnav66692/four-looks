// Press cues. Each cue is one face score from 0 (relaxed) to 1 (fully done).
// Calibration measures the relaxed face, three firm tries and a stretch of normal behaviour, then
// picks a line and a minimum length so firm tries press and everyday movement does not.

export const CUES = {
  smile:  { name: "smile",      score: (s) => ((s.mouthSmileLeft || 0) + (s.mouthSmileRight || 0)) / 2, firm: "Smile now.",              normal: "Now relax and talk a little." },
  mouth:  { name: "open mouth", score: (s) => s.jawOpen || 0,                                          firm: "Open your mouth now.",     normal: "Now relax and talk a little." },
  pucker: { name: "pucker",     score: (s) => s.mouthPucker || 0,                                      firm: "Pucker your lips now.",    normal: "Now relax and talk a little." },
  brows:  { name: "raise brows", score: (s) => s.browInnerUp || 0,                                     firm: "Raise your eyebrows now.", normal: "Now relax and look around." },
  blink:  { name: "blink",      score: (s) => ((s.eyeBlinkLeft || 0) + (s.eyeBlinkRight || 0)) / 2,   firm: "Blink firmly now.",        normal: "Now blink normally a few times." },
};
export const CUE_ORDER = ["smile", "mouth", "pucker", "brows", "blink"];
export const DEFAULT_CUE = { cue: "smile", thr: 0.45, ms: 180, freeze: 0.3, calibrated: false };

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

// rest: scores with a relaxed face. firm: one series per firm try. normal: one series of everyday behaviour.
export function fitCue(cue, rest, firm, normal) {
  const restTop = pct(rest, 0.95);
  const peak = median(firm.map((s) => Math.max(...s.map((x) => x.c))));
  if (!(peak > restTop + 0.08)) {
    return { ...DEFAULT_CUE, cue, ok: false, why: `the firm tries only reached ${peak.toFixed(2)} against ${restTop.toFixed(2)} relaxed` };
  }
  const normalTop = normal.length ? pct(normal.map((x) => x.c), 0.98) : restTop;
  // The line sits half way between relaxed and firm, and above everyday movement when there is room.
  const thr = Math.max(restTop + 0.5 * (peak - restTop), Math.min(normalTop + 0.05, restTop + 0.8 * (peak - restTop)));
  const freeze = restTop + 0.6 * (thr - restTop);
  const firmLen = median(firm.map((s) => Math.max(0, ...runs(s, thr))));
  const normalLens = runs(normal, thr);
  const normalMax = normalLens.length ? Math.max(...normalLens) : 0;
  let ms = Math.max(normalMax + 50, 0.4 * firmLen, 100);
  const clean = ms <= 0.85 * firmLen;
  if (!clean) ms = Math.max(100, 0.85 * firmLen);
  return {
    cue, thr: +thr.toFixed(3), freeze: +freeze.toFixed(3), ms: Math.round(ms), calibrated: true, ok: true, clean,
    restTop: +restTop.toFixed(3), peak: +peak.toFixed(3), normalTop: +normalTop.toFixed(3), firmLen: Math.round(firmLen), normalMax: Math.round(normalMax),
  };
}
