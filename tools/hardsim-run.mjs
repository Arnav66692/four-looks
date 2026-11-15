// Runs the hard simulation suite (public/hardsim.js) in a headless browser, so the result does not
// depend on a visible window. A hidden browser tab has its timers slowed, which starves the simulated
// face and makes keys look as if they never fill.
//   node tools/hardsim-run.mjs                         all scenarios, strong tremor
//   node tools/hardsim-run.mjs spikes                  all scenarios, spike frames
//   node tools/hardsim-run.mjs tremor paragraph_by_hold nod_is_reliable
// Needs the app's server on port 5173 (npm start) and playwright-core (set PLAYWRIGHT to its folder).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT || `${process.env.HOME}/.claude/skills/gstack/node_modules/playwright-core`);
const SETTINGS = { tremor: "noise=0.006&spike=0.01&lag=150", spikes: "noise=0.004&spike=0.04&lag=120", calm: "noise=0.004&lag=120" };
const [setting = "tremor", ...only] = process.argv.slice(2);
if (!SETTINGS[setting]) { console.log(`unknown setting ${setting}. Use one of: ${Object.keys(SETTINGS).join(", ")}`); process.exit(2); }
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let bundled = "";
try { bundled = pw.chromium.executablePath(); } catch { /* none */ }
const browser = await pw.chromium.launch({
  headless: true, executablePath: existsSync(bundled) ? bundled : CHROME,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--mute-audio"],
});
try {
  const page = await (await browser.newContext({ viewport: { width: 1470, height: 486 } })).newPage();     // the size of the real window on his Mac
  page.on("pageerror", (e) => console.log("page error:", String(e).slice(0, 200)));
  await page.goto(`http://localhost:${process.env.PORT || 5173}/?sim=1&app=1&${SETTINGS[setting]}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.fourLooks?.sim && window.fourLooks?.typer && window.fourLooks?.frown?.().taught, null, { timeout: 60000 });
  const hz = await page.evaluate(async () => { let n = 0; const id = setInterval(() => n++, 33); await new Promise((r) => setTimeout(r, 2000)); clearInterval(id); return Math.round(n / 2); });
  const t0 = Date.now();
  const out = await page.evaluate(async (names) => (await import("/hardsim.js")).run(names.length ? names : null), only);
  console.log(`setting ${setting} (${SETTINGS[setting]}), timers at ${hz} a second, ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const r of out.results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name} (${r.seconds} s)${r.pass && r.name !== "paragraph_by_hold" ? "" : " " + JSON.stringify(r.detail)}`);
  console.log(`${out.passed} of ${out.total} passed`);
  process.exitCode = out.passed === out.total ? 0 : 1;
} finally { await browser.close(); }
