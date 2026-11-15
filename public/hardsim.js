// Hard simulation suite. Open the page with ?sim=1&app=1&noise=0.004&spike=0.04&lag=120 (or harsher),
// then in the console: (await import("/hardsim.js")).run(). Results land in window.__hard.
// Every scenario comes from something that went wrong for a real person on Nov 14, 2026:
// stray presses while resting off the keyboard, Grok mode switching on from blink bursts and swallowing
// what was typed, a slipped shift that autocorrect would not touch, words glued together, a pressed
// letter shown as its neighbour. A scenario passes only on its stated bar. No scenario speaks out loud,
// calls a model, or touches anything outside the page.

const INPUT = ["letter", "space", "backspace", "undo", "symbol", "pick", "ghost", "ghost-phrase", "send", "speak", "fix-check", "menu", "mode", "setting", "layout", "grok", "grok-mode", "grok-offer", "grok-local", "switch-app", "click", "recenter", "keep-typed", "help"];
const CHANGES = ["undo", "send", "speak", "fix-check", "menu", "mode", "setting", "layout", "grok", "grok-mode", "grok-local", "switch-app", "click", "help", "backspace"];

export async function run(only = null) {
  const fl = window.fourLooks, sim = fl.sim, sleep = sim.sleep;
  const out = (window.__hard = { done: false, started: new Date().toISOString(), url: location.search, results: [] });
  const $ = (id) => document.getElementById(id);
  const since = (n, types = INPUT) => fl.log.slice(n).filter((e) => types.includes(e.type));
  const tile = (id) => document.querySelector(`[data-key="set:${id}"] .val`)?.textContent;
  const keyEl = (key) => [...document.querySelectorAll("#keys [data-key], #chips [data-key]")].find((e) => e.dataset.key === key || e.dataset.word === key || (key.length === 1 && e.dataset.key.startsWith("g:") && e.dataset.key.slice(2).includes(key)));
  const hovered = () => document.querySelector("#keys .hover, #chips .hover");

  // No model calls and no talking from a test.
  const realFetch = window.fetch;
  window.fetch = (url, opts) => (String(url).includes("/api/fix") ? Promise.resolve(new Response(JSON.stringify({ ok: true, text: JSON.parse(opts.body).text }), { headers: { "content-type": "application/json" } })) : realFetch(url, opts));
  const realSpeak = speechSynthesis.speak.bind(speechSynthesis);
  speechSynthesis.speak = () => {};

  async function setHold(on) { if ((tile("hold") === "on") !== on) fl.setting("hold"); await sleep(50); }
  async function setLayout(name) { for (let i = 0; i < 3 && tile("layout") !== name; i++) fl.setting("layout"); await sleep(150); }
  async function reset({ hold = true } = {}) {
    if (document.body.classList.contains("menu-open")) fl.setting("close");
    if (fl.grokMode()) { for (let i = 0; i < 3; i++) await sim.cue("blink", 60); await sleep(400); }
    await fl.setMode("keyboard");
    await sim.lookAt(0.5, -0.3, 200);            // look up at the app while things settle: selects nothing
    await sleep(700);
    fl.setting("clear");
    fl.app.text = ""; fl.app.returns = 0;
    await setLayout("head");
    await setHold(hold);
    await sleep(300);
  }
  // Press a key the way a person does with hold to press: look at it, check it lit up, re-aim if not, wait.
  let lastKey = null;
  async function holdPress(key, maxMs = 9000) {
    if (key === lastKey) { await sim.lookAt(sim.head.x, sim.head.y - 0.14, 150); await sleep(380); }   // a double letter: leave the key, come back
    lastKey = key;
    const n0 = fl.log.length, t0 = performance.now();
    await sim.lookAtKey(key, 0.1);
    while (performance.now() - t0 < maxMs) {
      const ev = since(n0)[0];
      if (ev) return ev;
      if (hovered() !== keyEl(key)) await sim.lookAtKey(key, 0.05); else await sleep(100);
    }
    return null;
  }
  async function holdType(text) {
    const pressed = [], shown = [];
    for (const ch of text) {
      const key = ch === " " ? "space" : ch;
      const ev = await holdPress(key);
      pressed.push(ev ? (ev.key || ev.type) : "(none)");
      shown.push($("typing").textContent);
    }
    return { pressed, shown };
  }
  const blinks = async (n, ms = 60) => { for (let i = 0; i < n; i++) await sim.cue("blink", ms); };
  const soft = (c) => { const L = "abcdefghijklmnopqrstuvwxyz", p = new Array(26).fill(0.6 / 25); p[L.indexOf(c)] = 0.4; return p; };

  const scenarios = {
    // 1. Resting anywhere off the keyboard for a while must press nothing.
    async rest_presses_nothing() {
      await reset();
      const n0 = fl.log.length, away = {};
      for (const [name, x, y] of [["below", 0.5, 1.7], ["below left", 0.12, 1.5], ["below right", 0.9, 1.6], ["left", -0.5, 0.6], ["right", 1.6, 0.6], ["up at the app", 0.5, -0.5]]) {
        await sim.lookAt(x, y, 300); await sleep(3600);
        away[name] = fl.away();
      }
      const got = since(n0);
      return { pass: got.length === 0, detail: { strayEvents: got.map((e) => e.type + (e.key ? ":" + e.key : "")), awayFlag: away } };
    },
    // 2. Blink bursts never switch modes on their own. Three blinks and a nod do. Three more cancel.
    async blinks_need_a_nod() {
      await reset();
      const n0 = fl.log.length;
      for (let i = 0; i < 8; i++) { await blinks(1, 60 + 60 * Math.random()); await sleep(900 + 1500 * Math.random()); }
      for (let i = 0; i < 3; i++) { await blinks(2); await sleep(2200); }
      const quiet = !fl.grokMode() && since(n0, ["grok-mode", "grok-offer"]).length === 0;
      await blinks(3); await sleep(300);
      const offered = fl.grokOffer() && !fl.grokMode();
      await sleep(4300);
      const lapsed = !fl.grokOffer() && !fl.grokMode();
      await blinks(3); await sleep(300); await sim.nod(); await sleep(500);
      const woke = fl.grokMode();
      await blinks(3); await sleep(500);
      const cancelled = !fl.grokMode();
      return { pass: quiet && offered && lapsed && woke && cancelled, detail: { singlesAndDoublesDoNothing: quiet, threeBlinksOnlyAsk: offered, askLapsesWithoutNod: lapsed, nodWakes: woke, threeBlinksCancel: cancelled } };
    },
    // 3. A paragraph by hold to press, with tremor, camera delay and spike frames.
    async paragraph_by_hold() {
      await reset();
      const target = "can you help me find my glasses please i need them now";
      const n0 = fl.log.length, t0 = performance.now();
      const { pressed, shown } = await holdType(target + " ");
      const sec = (performance.now() - t0) / 1000;
      let wrongKey = 0, displayMismatch = 0;
      [...(target + " ")].forEach((ch, i) => {
        const want = ch === " " ? "space" : ch;
        if (pressed[i] !== want) wrongKey++;
        if (ch !== " " && pressed[i].length === 1 && !shown[i].toLowerCase().endsWith(pressed[i])) displayMismatch++;
      });
      const typed = fl.typer.text().trim().toLowerCase().split(/\s+/), want = target.split(" ");
      const wordsRight = want.filter((w, i) => typed[i] === w).length;
      const changes = since(n0, CHANGES);
      await sleep(300);
      const appMatches = fl.app.text === fl.typer.committed;
      return {
        pass: displayMismatch === 0 && changes.length === 0 && wordsRight >= want.length - 1 && appMatches && wrongKey <= Math.ceil(0.15 * (target.length + 1)),
        detail: { seconds: +sec.toFixed(1), secondsPerKey: +(sec / (target.length + 1)).toFixed(2), keys: target.length + 1, wrongKeyPresses: wrongKey, shownLetterDiffersFromPressed: displayMismatch, wordsRight: `${wordsRight}/${want.length}`, strayFunctionKeys: changes.map((e) => e.type), appTextMatches: appMatches, text: fl.typer.text() },
      };
    },
    // 4. A slipped shift in the middle of a word is put right when the word ends.
    async slipped_shift() {
      await reset();
      await holdType("with f");
      await holdPress("shift", 12000);
      await holdType("inding ");
      const text = fl.typer.text();
      return { pass: /\bfinding\b/.test(text) && !/fI/.test(text), detail: { text } };
    },
    // 5. Fix or speak in the middle, then a picked word: never glued together.
    async fix_then_pick_keeps_space() {
      await reset();
      await holdType("finding");
      await holdPress("fix", 12000); await sleep(600);
      fl.typer.pick("it"); const afterFix = fl.typer.text();
      await reset();
      await holdType("help");
      await holdPress("speak", 12000); await sleep(300);
      await holdType("me ");
      const afterSpeak = fl.typer.text();
      return { pass: /finding it /i.test(afterFix) && /help me /i.test(afterSpeak), detail: { afterFix, afterSpeak } };
    },
    // 6. Grok mode: nothing typed there reaches the app, the app text survives, and normal send still works after.
    async grok_mode_never_leaks() {
      await reset();
      await holdType("hello ");
      await sleep(300);
      const before = fl.app.text;
      await sim.lookAt(0.5, -0.3, 200);
      await blinks(3); await sleep(300); await sim.nod(); await sleep(600);
      const inMode = fl.grokMode(), label = keyEl("send")?.querySelector(".label")?.textContent, banner = $("prompt").textContent;
      await holdType("open gmail");
      await sleep(300);
      const during = fl.app.text;
      const runs0 = fl.agent.runs.length;
      await holdPress("send", 12000); await sleep(1800);
      const ran = fl.agent.runs.slice(runs0);
      const after = { grokMode: fl.grokMode(), typer: fl.typer.text(), app: fl.app.text, returns: fl.app.returns };
      await holdType("ok");
      await holdPress("send", 12000); await sleep(500);
      const sent = { app: fl.app.text, returns: fl.app.returns };
      return {
        pass: inMode && label === "do it" && /GROK IS LISTENING/.test(banner) && during === before && ran.length === 1 && /^open gmail$/i.test(ran[0]) && !after.grokMode && after.app === before && after.typer === "Hello " && after.returns === 0 && /^Hello ok\n$/i.test(sent.app) && sent.returns === 1,
        detail: { inMode, sendLabel: label, appBefore: before, appWhileTypingCommand: during, grokGot: ran, after, afterNormalSend: sent },
      };
    },
    // 7. Every key can still be reached on purpose, including the ones on the edges.
    async every_key_reachable() {
      await reset({ hold: false });
      const keys = [...document.querySelectorAll("#keys [data-key]")].map((e) => e.dataset.key), missed = [];
      for (const k of keys) {
        let ok = false;
        for (let a = 0; a < 3 && !ok; a++) { await sim.lookAtKey(k, a ? 0.05 : 0.1); ok = hovered()?.dataset.key === k; }
        if (!ok) missed.push(`${k}->${hovered()?.dataset.key || "none"}`);
      }
      // A small overshoot past the bottom row is still the edge key, not "away". With the reach setting the
      // cursor is already past the edge when the head points at 0.99 of the window height.
      await sim.lookAt(0.5, 0.99, 250); await sleep(600); const justBelow = hovered()?.dataset.key || "none";
      return { pass: missed.length === 0 && justBelow === "space", detail: { keys: keys.length, missed, justBelowTheBottomRow: justBelow } };
    },
    // 8. Boxes and qwerty type a sentence.
    async boxes_and_qwerty() {
      await reset({ hold: false });
      await setLayout("boxes");
      const rows = [...document.querySelectorAll("#keys .row")].map((r) => [...r.querySelectorAll("[data-key]")].map((e) => e.dataset.key.replace("g:", "")).join(" "));
      await sim.type("can you help me "); const boxes = fl.typer.text();
      fl.setting("clear");
      await setLayout("qwerty");
      await sim.type("see you soon "); const qwerty = fl.typer.text();
      await setLayout("head");
      return { pass: /^can you help me $/i.test(boxes) && /^see you soon $/i.test(qwerty) && rows[0] === "abc def ghi ⌫", detail: { boxes, qwerty, boxRows: rows.slice(0, 3) } };
    },
    // 9. Autocorrect acts on its own, and a head shake straight after puts the typed letters back.
    async shake_refuses_autocorrect() {
      await reset({ hold: false });
      fl.typer.learned.delete("tennix");            // a word kept in an earlier run must not carry over
      fl.typer.used.delete("tennix");
      for (const c of "tennix") fl.typer.letter(soft(c));
      await sim.press("space"); await sleep(300);
      const corrected = fl.typer.text();
      await sim.shake(1); await sleep(500);
      const kept = fl.typer.text();
      for (const c of "tennix") fl.typer.letter(soft(c));
      await sim.press("space"); await sleep(300);
      const again = fl.typer.text();
      // With no words before it the guesser may pick "thanks" or "tennis": the bar is that it changed the
      // word by itself, the shake brought the typed letters back, and the same word is left alone next time.
      return { pass: !/^tennix $/i.test(corrected) && /^[a-z]+ $/i.test(corrected) && /^tennix $/i.test(kept) && /^tennix tennix $/i.test(again), detail: { corrected, afterShake: kept, typedAgain: again } };
    },
    // 10. Mouse mode: talking and nodding never click. A quick mouth opening clicks once. Two shakes switch apps.
    async mouse_mode() {
      await reset({ hold: false });
      await fl.setMode("mouse"); await sleep(700);
      const clicks = () => fl.desk.calls.filter((c) => c[0] === "click").length;
      const c0 = clicks();
      for (let i = 0; i < 8; i++) { sim.level.mouth = 0.2; await sleep(130); sim.level.mouth = 0; await sleep(350); }
      const talking = clicks() - c0;
      await sim.nod(); await sleep(500); const nodding = clicks() - c0 - talking;
      await sim.cue("mouth", 120, 0.7); await sleep(500); const mouth = clicks() - c0 - talking - nodding;
      const n0 = fl.log.length;
      await sim.shake(1); await sim.shake(1); await sleep(500);
      const switched = since(n0, ["switch-app"]).length;
      await fl.setMode("keyboard");
      return { pass: talking === 0 && nodding === 0 && mouth === 1 && switched === 1, detail: { clicksWhileTalking: talking, clicksOnNod: nodding, clicksOnMouthOpen: mouth, appSwitches: switched } };
    },
    // 12. The nod itself: every deliberate nod is seen, and hopping down a row and back is never one.
    async nod_is_reliable() {
      await reset({ hold: false });
      await sim.lookAt(0.5, 0.45, 250); await sleep(600);
      const n0 = fl.nods();
      for (let i = 0; i < 12; i++) { await sim.nod(); await sleep(700 + 500 * Math.random()); }
      const seen = fl.nods() - n0;
      const n1 = fl.nods();
      for (let i = 0; i < 12; i++) { await sim.rowHop(); await sleep(500 + 400 * Math.random()); }
      const falseNods = fl.nods() - n1;
      fl.setting("clear");
      return { pass: seen >= 11 && falseNods === 0, detail: { nodsSeen: `${seen}/12`, rowHopsTakenAsNods: falseNods } };
    },
    // 11. Looking up to read the app in the middle of a word, then carrying on.
    async read_then_carry_on() {
      await reset();
      const n0 = fl.log.length;
      await holdType("he");
      await sim.lookAt(0.5, -0.5, 300); await sleep(2500);
      await holdType("lp me ");
      const stray = since(n0, CHANGES);
      const text = fl.typer.text();
      return { pass: /^help me $/i.test(text) && stray.length === 0, detail: { text, strayFunctionKeys: stray.map((e) => e.type) } };
    },
  };

  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue;
    out.running = name;
    const t0 = performance.now();
    let r;
    try { r = await fn(); } catch (err) { r = { pass: false, detail: { error: String(err?.stack || err).slice(0, 400) } }; }
    out.results.push({ name, pass: !!r.pass, seconds: +((performance.now() - t0) / 1000).toFixed(1), detail: r.detail });
  }
  try { await reset({ hold: false }); } catch { /* leave as is */ }
  window.fetch = realFetch; speechSynthesis.speak = realSpeak;
  out.running = null;
  out.passed = out.results.filter((r) => r.pass).length;
  out.total = out.results.length;
  out.done = true;
  return out;
}
