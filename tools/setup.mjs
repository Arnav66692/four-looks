#!/usr/bin/env node
// One command that turns a fresh clone into a runnable Four Looks. Node built-ins only, so it works
// before npm install.
//
//   node tools/setup.mjs          everything for this computer
//   node tools/setup.mjs --web    browser version only (skips the Mac helper)
//   node tools/setup.mjs --eval   also fetch the public test sentences used by tools/eval.mjs
//   node tools/setup.mjs --force  rebuild the word model even if it is already there
//
// What it does: checks Node, downloads the public word model (25 MB) and builds public/lm.json (30 MB),
// creates .env from .env.example, and on a Mac builds the small native helper that moves the cursor.
// Nothing is installed outside this folder. Safe to run again.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const WEB_ONLY = args.has("--web");
const FORCE = args.has("--force");
const WITH_EVAL = args.has("--eval");
const MIN_NODE = 20;

// The public 2-gram word model by Vertanen and Kristensson (aactext.org/imagine).
const MODEL_URL = "https://data.imagineville.org/imagine/lm_mix_top3_2gram_abs0.0.arpa.gz";
const MODEL_SHA256 = "33a54a089aac00003153b912b4f76ff53a695f5ef96d4133d85bbc057306ffe5";
const MODEL_GZ = join(ROOT, "data", "raw", "lm_mix_top3_2gram_abs0.0.arpa.gz");
const MODEL_OUT = join(ROOT, "public", "lm.json");
const MODEL_OUT_MIN_BYTES = 10_000_000;
const SENTENCES_URL = "https://www.aactext.org/imagine/aac_comm.zip";

const say = (text) => process.stdout.write(`${text}\n`);
const step = (text) => say(`\n== ${text}`);
const fail = (text) => { process.stderr.write(`\nSetup stopped: ${text}\n`); process.exit(1); };
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function download(url, to) {
  mkdirSync(dirname(to), { recursive: true });
  const part = `${to}.part`;
  let res;
  try { res = await fetch(url); } catch (err) { fail(`could not reach ${new URL(url).host}. Check your internet connection. (${err.message})`); }
  if (!res.ok || !res.body) fail(`${url} answered ${res.status}.`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0, shown = 0;
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => {
    got += chunk.length;
    if (got - shown >= 5e6) { shown = got; say(`   ${mb(got)}${total ? ` of ${mb(total)}` : ""}`); }
  });
  await pipeline(body, createWriteStream(part));
  renameSync(part, to);
  say(`   saved ${mb(got)}`);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: "inherit", ...options });
  return result.status === 0;
}
const has = (command, commandArgs = ["--version"]) => spawnSync(command, commandArgs, { stdio: "ignore" }).status === 0;

// ---------- 1. Node ----------
step("Checking Node");
const major = Number(process.versions.node.split(".")[0]);
if (major < MIN_NODE) fail(`Node ${MIN_NODE} or newer is needed. This is Node ${process.versions.node}. Get a newer one from https://nodejs.org`);
say(`   Node ${process.versions.node} on ${process.platform} ${process.arch}`);

// ---------- 2. Word model ----------
step("Word model");
if (!FORCE && existsSync(MODEL_OUT) && statSync(MODEL_OUT).size > MODEL_OUT_MIN_BYTES) {
  say(`   public/lm.json is already there (${mb(statSync(MODEL_OUT).size)}). Use --force to rebuild it.`);
} else {
  if (!existsSync(MODEL_GZ)) {
    say("   downloading the public word model (about 25 MB)");
    await download(MODEL_URL, MODEL_GZ);
  }
  const digest = await sha256(MODEL_GZ);
  if (digest !== MODEL_SHA256 && !process.env.FL_SKIP_HASH) {
    fail(`the downloaded word model does not match the copy this project was built with.\n   expected ${MODEL_SHA256}\n   got      ${digest}\nDelete data/raw and run setup again. If the source file has really changed, run again with FL_SKIP_HASH=1.`);
  }
  say("   building public/lm.json (takes under a minute)");
  if (!run(process.execPath, ["--max-old-space-size=4096", join("tools", "build-lm.mjs"), MODEL_GZ, MODEL_OUT])) fail("building the word model failed. The lines above say why.");
  if (!existsSync(MODEL_OUT) || statSync(MODEL_OUT).size < MODEL_OUT_MIN_BYTES) fail("the word model was built but looks too small.");
  say(`   built public/lm.json (${mb(statSync(MODEL_OUT).size)})`);
}

// ---------- 3. Test sentences (optional) ----------
if (WITH_EVAL) {
  step("Test sentences");
  const folder = join(ROOT, "data", "raw", "aac_comm");
  if (existsSync(folder)) say("   data/raw/aac_comm is already there");
  else if (!has("unzip", ["-v"])) say("   skipped: the unzip command is not on this computer. The app does not need these, only tools/eval.mjs does.");
  else {
    const zip = join(ROOT, "data", "raw", "aac_comm.zip");
    if (!existsSync(zip)) await download(SENTENCES_URL, zip);
    if (!run("unzip", ["-q", "-o", zip, "-d", join(ROOT, "data", "raw")])) say("   could not unzip the test sentences. The app does not need them.");
    else say("   unpacked data/raw/aac_comm");
  }
}

// ---------- 4. Settings file ----------
step("Settings file");
const env = join(ROOT, ".env"), example = join(ROOT, ".env.example");
if (existsSync(env)) say("   .env is already there, left as it is");
else if (existsSync(example)) { copyFileSync(example, env); say("   created .env. It is empty and stays on this computer. A Grok key is optional."); }

// ---------- 5. Mac helper for the head mouse ----------
let helper = "not needed";
if (process.platform === "darwin" && !WEB_ONLY) {
  step("Mac helper for the head mouse");
  if (!has("xcrun", ["--find", "swiftc"])) {
    helper = "missing";
    say("   skipped: the Swift compiler is not installed. Typing still works. For the head mouse and Grok clicks run\n     xcode-select --install\n   and then run this setup again.");
  } else if (run("sh", [join("native", "build.sh")])) helper = "built";
  else { helper = "failed"; say("   the helper did not build. Typing still works. The head mouse and Grok clicks will not."); }
}

// ---------- 6. What to do next ----------
step("Done");
const desktopReady = existsSync(join(ROOT, "node_modules", "electron"));
if (process.platform === "darwin" && !WEB_ONLY) {
  if (!desktopReady) say("   The desktop app needs one more step:\n     npm install");
  say("   Start the Mac app from the Terminal app:\n     npm run app");
  say(`   Head mouse helper: ${helper}.`);
  say("   Or try it in a browser:\n     npm run web      then open http://localhost:5173 in Chrome");
} else {
  if (process.platform !== "darwin" && !WEB_ONLY) say("   The desktop app is Mac only. On this computer use the browser version.");
  say("   Start it:\n     node server.js\n   then open http://localhost:5173 in Chrome or Edge and allow the camera.");
}
say("   To check the install without a camera:\n     npm run check");
rmSync(`${MODEL_GZ}.part`, { force: true });
