// Admin view: shows what the tracker sees and how it decides. For the builder, not the user.
// Left: the camera with the face model's dots. Right: live numbers for tracking, the press move,
// the nod detector and the word guesses.

const deg = (r) => (r == null ? "  -  " : `${((r * 180) / Math.PI).toFixed(1).padStart(5)}°`);
const pct = (x) => `${Math.round(100 * x)}%`.padStart(4);
const f2 = (x) => (x == null ? "-" : x.toFixed(2));
const bar = (x, mark, n = 16) => {
  const fill = Math.max(0, Math.min(n, Math.round(x * n))), m = Math.max(0, Math.min(n - 1, Math.round(mark * n)));
  return [...Array(n)].map((_, i) => (i === m ? "|" : i < fill ? "#" : ".")).join("");
};

export function createAdmin(root, video) {
  root.innerHTML = `<canvas width="320" height="240"></canvas><pre></pre><pre></pre><pre></pre>`;
  const canvas = root.querySelector("canvas"), ctx = canvas.getContext("2d");
  const [colTrack, colPress, colGuess] = root.querySelectorAll("pre");
  const W = canvas.width, H = canvas.height;
  let frames = 0, fps = 0, since = performance.now();

  function drawFace(f, st) {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);                 // mirror, like looking in a mirror
    if (video.readyState >= 2) { ctx.globalAlpha = 0.55; ctx.drawImage(video, 0, 0, W, H); ctx.globalAlpha = 1; }
    if (f.lm) {
      ctx.fillStyle = "#5fe0a8";
      for (let i = 0; i < f.lm.length; i += 2) ctx.fillRect(f.lm[i].x * W - 0.8, f.lm[i].y * H - 0.8, 1.6, 1.6);
      const nose = f.lm[1];
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(nose.x * W, nose.y * H, 4, 0, 7); ctx.fill();
    }
    ctx.restore();
    if (f.lm && st.shown) {                                            // where the head points, from the nose
      const nx = (1 - f.lm[1].x) * W, ny = f.lm[1].y * H;
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(nx, ny);
      ctx.lineTo(nx + (st.shown[0] - 0.5) * 150, ny + (st.shown[1] - 0.5) * 150); ctx.stroke();
    }
    if (!f.lm) { ctx.fillStyle = "#888"; ctx.font = "13px ui-monospace, monospace"; ctx.fillText(f.face ? "simulated face (no camera dots)" : "no face found", 12, 24); }
  }

  return {
    draw(f, st) {
      frames++;
      const now = performance.now();
      if (now - since > 500) { fps = Math.round((frames * 1000) / (now - since)); frames = 0; since = now; }
      drawFace(f, st);
      colTrack.textContent = [
        "TRACKING",
        `frames/s    ${String(fps).padStart(3)}`,
        `face        ${f.face ? "yes" : "NO"}   dots ${f.lm ? f.lm.length : 0}`,
        `head yaw    ${deg(f.pose?.[0])}`,
        `head pitch  ${deg(f.pose?.[1])}`,
        `raw point   ${f2(st.raw?.[0])}, ${f2(st.raw?.[1])}`,
        `smoothed    ${f2(st.shown?.[0])}, ${f2(st.shown?.[1])}`,
        `reach       ${st.reach}x   calibrated ${st.calibrated ? "yes" : "NO"}`,
      ].join("\n");
      colPress.textContent = [
        `PRESS MOVE  ${st.cue.name}`,
        `score ${f2(st.cue.score)}  ${bar(st.cue.score, st.cue.thr)}`,
        `line  ${f2(st.cue.thr)}  freeze ${f2(st.cue.freeze)}`,
        `held  ${String(Math.round(st.cue.heldMs)).padStart(4)} ms of ${st.cue.needMs}`,
        "",
        `NOD   ${st.nod.state}`,
        `dip   ${f2(st.nod.dip)}  ${bar(st.nod.dip / (st.nod.need * 1.5), 1 / 1.5)}`,
        `need  ${f2(st.nod.need)} within ${st.nod.ms} ms`,
        `eyes shut ${(st.eyesShutMs / 1000).toFixed(1)} s of 3.0 (recalibrate)`,
      ].join("\n");
      const press = st.lastPress ? st.lastPress.map(([l, p]) => `${l.toUpperCase()} ${pct(p)}`).join("  ") : "-";
      colGuess.textContent = [
        "GUESSING",
        `on key      ${st.hover || "-"}   lock ${pct(st.lock)}`,
        `would press ${st.vote || "-"}`,
        `last press  ${press}`,
        `likely next ${st.nextLetters || "-"}`,
        "words (score, higher wins)",
        ...(st.words.length ? st.words.map((w) => `  ${w.word.padEnd(14)} ${w.score.toFixed(2)}${w.typed ? "  as typed" : w.longer ? "  longer" : ""}`) : ["  -"]),
      ].join("\n");
    },
  };
}
