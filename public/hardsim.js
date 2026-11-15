// Hard simulation suite. Open the page with ?sim=1&app=1&noise=0.004&spike=0.04&lag=120 (or harsher),
// then in the console: (await import("/hardsim.js")).run(). Results land in window.__hard.
// Every scenario comes from something that went wrong for a real person on Nov 14, 2026:
// stray presses while resting off the keyboard, Grok mode switching on from blink bursts and swallowing
// what was typed, a slipped shift that autocorrect would not touch, words glued together, a pressed
// letter shown as its neighbour. A scenario passes only on its stated bar. No scenario speaks out loud,
// calls a model, or touches anything outside the page.

const INPUT = ["letter", "space", "shift", "backspace", "undo", "symbol", "pick", "ghost", "ghost-phrase", "send", "speak", "fix-check", "menu", "mode", "setting", "layout", "grok", "grok-mode", "grok-offer", "grok-local", "switch-app", "click", "recenter", "keep-typed", "help"];
const CHANGES = ["shift", "undo", "send", "speak", "fix-check", "menu", "mode", "setting", "layout", "grok", "grok-mode", "grok-local", "switch-app", "click", "help", "backspace"];

export async function run(only = null) {
  const fl = window.fourLooks, sim = fl.sim, sleep = sim.sleep;
  const out = (window.__hard = { done: false, started: new Date().toISOString(), url: location.search, results: [] });
  const $ = (id) => document.getElementById(id);
  const since = (n, types = INPUT) => fl.log.slice(n).filter((e) => types.includes(e.type));
  const tile = (id) => document.querySelector(`[data-key="set:${id}"] .val`)?.textContent;
  const keyEl = (key) => {      // the keyboard's own key first: the letter o is the O key, not a guess that reads "o"
    const keys = [...document.querySelectorAll("#keys [data-key]")], chips = [...document.querySelectorAll("#chips [data-key]")];
    return keys.find((e) => e.dataset.key === key) || keys.find((e) => key.length === 1 && e.dataset.key.startsWith("g:") && e.dataset.key.slice(2).includes(key)) || chips.find((e) => e.dataset.word === key);
  };
  const hovered = () => document.querySelector("#keys .hover, #chips .hover");

  // No model calls and no talking from a test.
  const realFetch = window.fetch;
  const reply = (obj) => new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } });
  let rankStub = async (body) => ({ ok: false, ranked: body.candidates, error: "test" });      // a test never reaches xAI
  window.fetch = (url, opts) => (String(url).includes("/api/fix") ? Promise.resolve(reply({ ok: true, text: JSON.parse(opts.body).text }))
    : String(url).includes("/api/rank") ? rankStub(JSON.parse(opts.body)).then(reply) : realFetch(url, opts));
  const realSpeak = speechSynthesis.speak.bind(speechSynthesis);
  speechSynthesis.speak = () => {};

  async function setHold(on) { if ((tile("hold") === "on") !== on) fl.setting("hold"); await sleep(50); }
  async function setLayout(name) { for (let i = 0; i < 3 && tile("layout") !== name; i++) fl.setting("layout"); await sleep(150); }
  async function reset({ hold = true } = {}) {
    if (document.body.classList.contains("menu-open")) fl.setting("close");
    if (fl.grokMode()) { fl.exitGrok(); await sleep(200); }       // closed directly, so a scenario never starts inside Grok mode
    if (fl.grokMode()) throw new Error("Grok mode would not close before the scenario");
    sim.level.frown = 0;
    if (fl.rank().on) fl.setting("rank");                          // Grok guesses are off unless a scenario turns them on
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
  // want: only this kind of event counts as the press (a late guess firing on the way must not end the wait).
  async function holdPress(key, maxMs = 9000, want = null) {
    if (key === lastKey) { await sim.lookAt(sim.head.x, sim.head.y - 0.14, 150); await sleep(380); }   // a double letter: leave the key, come back
    lastKey = key;
    const n0 = fl.log.length, t0 = performance.now();
    const got = () => since(n0).find((e) => !want || e.type === want);
    const gone = () => !!got();
    await sim.lookAtKey(key, 0.1, gone);
    while (performance.now() - t0 < maxMs) {
      const ev = got();
      if (ev) return ev;
      if (hovered() !== keyEl(key)) await sim.lookAtKey(key, 0.05, gone); else await sleep(100);
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
  const frownHold = (ms = 650, strength = 0.7) => sim.cue("frown", ms, strength);      // a deliberate lowering of the brows
  // The app teaches itself this face's frown on first run (the simulated face follows the prompts). Wait for it.
  for (let i = 0; i < 80 && !fl.frown().taught; i++) await sleep(300);
  out.frownTaught = fl.frown();
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
    // 2. Grok wakes on a deliberate held frown and on nothing else. Every false-wake case here is one a
    //    reviewer or a real session raised: blink bursts, nods, quick frowns, frowning in concentration while
    //    typing, a face that settles into a frown, and a frown already held when tracking resumes.
    async frown_wakes_grok() {
      await reset();
      const n0 = fl.log.length;
      const calm = () => !fl.grokMode() && since(n0, ["grok-mode"]).length === 0;
      for (let i = 0; i < 5; i++) { await blinks(1, 60 + 60 * Math.random()); await sleep(700 + 800 * Math.random()); }
      await blinks(2); await sleep(1200); await blinks(3); await sleep(1200);
      const blinking = calm();
      await sim.nod(); await sleep(700); await sim.nod(); await sleep(700);
      const nodding = calm();
      for (let i = 0; i < 4; i++) { await sim.cue("frown", 120, 0.7); await sleep(600); }           // full strength, each too short
      const quick = calm();
      sim.level.frown = 0.3;                                                                          // about half his own frown, held through a typed word
      await holdType("help ");
      sim.level.frown = 0; await sleep(600);
      const concentrating = calm();
      for (let i = 0; i < 5; i++) { await sim.cue("frown", 400, 0.36); await sleep(500); }            // bursts just under his start level
      const bursts = calm();
      for (let k = 1; k <= 40; k++) { sim.level.frown = 0.011 * k; await sleep(150); }                // the face slowly settles into a real frown
      await sleep(3000); sim.level.frown = 0; await sleep(1500);
      const settling = calm();
      sim.level.frown = 0.7; fl.frownReset();                                                         // already frowning when tracking resumes
      await sleep(2200);
      const heldAcrossReturn = calm();
      sim.level.frown = 0; await sleep(900);
      fl.setting("clear");
      await frownHold(); await sleep(500);
      const woke = fl.grokMode(), banner = $("prompt").textContent;
      await sleep(900);
      await frownHold(650); await sleep(500);                                                         // a frown of concentration while composing
      const survivesShortFrown = fl.grokMode();
      await sleep(600);
      await frownHold(1300); await sleep(500);
      const cancelled = !fl.grokMode();
      return {
        pass: blinking && nodding && quick && concentrating && bursts && settling && heldAcrossReturn && woke && /GROK IS LISTENING/.test(banner) && survivesShortFrown && cancelled,
        detail: { blinkBurstsDoNothing: blinking, nodsDoNothing: nodding, quickFrownsDoNothing: quick, frowningWhileTypingDoesNothing: concentrating, burstsUnderHisLevelDoNothing: bursts, slowSettleIntoFrownDoesNothing: settling, frownHeldWhenTrackingResumesDoesNothing: heldAcrossReturn, heldFrownWakes: woke, shortFrownInGrokModeKeepsIt: survivesShortFrown, oneSecondFrownCancels: cancelled, frownState: fl.frown() },
      };
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
      await frownHold(); await sleep(600);
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
    // 13. Staying on a word guess or on undo keeps going. Staying on a letter does not repeat it.
    async guesses_and_undo_repeat() {
      await reset();
      await holdType("i ");
      const n0 = fl.log.length;
      const lead = document.querySelector("#chips .lead");
      const r = lead.getBoundingClientRect();
      await sim.lookAt((r.left + r.width / 2) / innerWidth, (r.top + r.height / 2) / innerHeight, 250);
      for (let i = 0; i < 40 && hovered() !== lead; i++) await sim.lookAtKey(lead.dataset.word, 0.05);
      await sleep(3800);                                           // stay put on the bold guess
      const picks = since(n0, ["pick"]).length, words = fl.typer.text().trim().split(/\s+/).length;
      const n1 = fl.log.length;
      await holdPress("undo", 12000, "undo");
      await sleep(3600);                                           // stay put on undo
      const undos = since(n1, ["undo"]).length;
      await reset();
      const n2 = fl.log.length;
      await holdPress("e");
      await sleep(3200);                                           // stay put on a letter
      const letters = since(n2, ["letter"]).length;
      return { pass: picks >= 2 && undos >= 2 && letters === 1, detail: { guessesTakenWhileStaying: picks, wordsNow: words, undosWhileStaying: undos, lettersWhileStayingOnE: letters } };
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
    // 14. Grok guesses (In A Park's idea). Off: no call at all. On: one call for a misspelled word, and Grok's
    // pick becomes the bold guess. On the guess row the order waits until the cursor moves off. A failed
    // call leaves the app's own order.
    async grok_guess_goes_first() {
      await reset({ hold: false });
      const hit = (c) => { const L = "abcdefghijklmnopqrstuvwxyz", p = new Array(26).fill(0.004); p[L.indexOf(c)] = 0.9; return p; };
      const lead = () => document.querySelector("#chips .lead")?.dataset.word.toLowerCase();
      let calls = 0, sent = null, delay = 300, fail = false;
      rankStub = async (body) => { calls++; sent = body; await sleep(delay); const c = body.candidates; return fail ? { ok: false, ranked: c, error: "timed out" } : { ok: true, ranked: [c[1], c[0], ...c.slice(2)], ms: delay }; };
      const begin = async (first) => {             // "<first> need wte", then the last letter pressed for real
        fl.setting("clear"); fl.typer.shift = "off";
        fl.typer.pick(first); fl.typer.pick("need");
        for (const c of "wte") fl.typer.letter(hit(c));
        await sim.press("r");
      };
      await begin("i"); await sleep(1100);
      const offCalls = calls, offLead = lead();
      fl.setting("rank");
      await begin("we"); await sleep(1200);
      const on = { calls: calls - offCalls, sentence: sent?.sentence, lead: lead(), want: sent?.candidates[1] };
      delay = 1600;
      await begin("they");
      let tries = 0;
      for (; tries < 12 && !hovered()?.closest("#chips"); tries++) await sim.lookAtKey(lead(), 0.05);
      const before = lead(), wanted = sent?.candidates[1], arrived = { tries, on: hovered()?.dataset.word || hovered()?.dataset.key || null, callsSoFar: calls, cursor: fl.cursor?.() };
      await sleep(1900);
      const held = { arrived, onGuessRow: !!hovered()?.closest("#chips"), on: hovered()?.dataset.word || hovered()?.dataset.key || null, waiting: fl.rank().held, leadUnchanged: lead() === before };
      await sim.lookAt(0.5, -0.3, 250); await sleep(1000);
      const released = { lead: lead(), want: wanted };
      delay = 200; fail = true;
      await begin("you"); await sleep(1000);
      const failed = { lead: lead(), appsOwnFirst: sent?.candidates[0] };
      fl.setting("rank");
      const pass = offCalls === 0 && on.calls === 1 && on.lead === on.want && held.onGuessRow && held.waiting && held.leadUnchanged && released.lead === released.want && failed.lead === failed.appsOwnFirst && !fl.rank().on;
      return { pass, detail: { offCalls, offLead, on, held, released, failed } };
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
