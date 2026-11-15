// Tiny local server. / serves public/, /src/ serves shared modules, /api/fix asks Grok to check a sentence.
// Secrets come from .env (never committed, never sent to the page).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const XAI = "https://api.x.ai/v1";
const MAX_TEXT = 600;

function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env yet */ }
}
loadEnv();

// ---------- spend guard: the app stops calling Grok at these limits, whatever the account allows ----------
const USAGE_FILE = join(ROOT, ".usage.json");
const MAX_USD = Number(process.env.FL_MAX_USD || 1);                 // lifetime estimate, in dollars
const MAX_CALLS_PER_DAY = Number(process.env.FL_MAX_CALLS_PER_DAY || 300);
const PRICE_PER_M = { "grok-4.3": [1.25, 2.5] };                     // dollars per million input, output tokens (xAI pricing page, Nov 14 2026)
const FALLBACK_PRICE = [2, 6];
const today = () => new Date().toISOString().slice(0, 10);
function loadUsage() {
  try { return JSON.parse(readFileSync(USAGE_FILE, "utf8")); } catch { return { usd: 0, calls: 0, inTokens: 0, outTokens: 0, day: "", callsToday: 0 }; }
}
function overBudget() {
  const u = loadUsage();
  if (u.usd >= MAX_USD) return "spend cap reached (about $" + u.usd.toFixed(3) + " of $" + MAX_USD + ")";
  if (u.day === today() && u.callsToday >= MAX_CALLS_PER_DAY) return "daily call cap reached (" + MAX_CALLS_PER_DAY + ")";
  return null;
}
function addUsage(model, usage) {
  const u = loadUsage();
  const [pin, pout] = PRICE_PER_M[model] || FALLBACK_PRICE;
  const inT = usage?.prompt_tokens ?? usage?.input_tokens ?? 0, outT = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  const next = {
    ...u,
    usd: u.usd + (inT * pin + outT * pout) / 1e6, calls: u.calls + 1, inTokens: u.inTokens + inT, outTokens: u.outTokens + outT,
    day: today(), callsToday: (u.day === today() ? u.callsToday : 0) + 1,
  };
  writeFileSync(USAGE_FILE, JSON.stringify(next));
  return next;
}
// Grok guesses keep their own daily count. They add to the dollar estimate but never to callsToday, so
// they cannot use up the daily calls that the fix key and the Grok agent depend on.
const MAX_RANK_PER_DAY = Number(process.env.FL_MAX_RANK_PER_DAY || 100);
function rankBlocked() {
  const u = loadUsage();
  if (u.usd >= MAX_USD) return "spend cap reached (about $" + u.usd.toFixed(3) + " of $" + MAX_USD + ")";
  if (u.rankDay === today() && u.rankToday >= MAX_RANK_PER_DAY) return "daily cap reached for Grok guesses (" + MAX_RANK_PER_DAY + ")";
  return null;
}
function addRankUsage(usage) {
  const u = loadUsage();
  const [pin, pout] = PRICE_PER_M[RANK_MODEL] || FALLBACK_PRICE;
  const inT = usage?.prompt_tokens ?? usage?.input_tokens ?? 0, outT = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  writeFileSync(USAGE_FILE, JSON.stringify({
    ...u, usd: u.usd + (inT * pin + outT * pout) / 1e6, calls: u.calls + 1, inTokens: u.inTokens + inT, outTokens: u.outTokens + outT,
    rankDay: today(), rankToday: (u.rankDay === today() ? u.rankToday : 0) + 1,
  }));
}

let lastStatus = null;
let grokModel = process.env.XAI_MODEL || null;
async function pickModel(key) {
  if (grokModel) return grokModel;
  const r = await fetch(`${XAI}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`model list failed (${r.status})`);
  const ids = ((await r.json()).data || []).map((m) => m.id).filter((id) => /grok/i.test(id) && !/image|vision|imagine/i.test(id));
  // Lowest-priced general text model on xAI's pricing page (read Nov 14 2026), else whatever the key offers.
  grokModel = ids.find((id) => id === "grok-4.3") || ids.find((id) => /fast|mini/i.test(id)) || ids[0];
  if (!grokModel) throw new Error("no Grok text model on this key");
  return grokModel;
}

const FIX_PROMPT = `You fix text typed by a person who cannot use their hands, using a head-controlled keyboard.
Correct spelling, grammar and wrong-word slips. Keep their meaning, their words and their tone. Do not add ideas.
If the text is already fine, return it unchanged. Reply with the corrected text only, no quotes, no notes.`;

async function grokFix(text) {
  const key = process.env.XAI_API_KEY;
  if (!key) return { ok: false, error: "no key" };
  const blocked = overBudget();
  if (blocked) return { ok: false, error: blocked };
  const model = await pickModel(key);
  const r = await fetch(`${XAI}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 300, messages: [{ role: "system", content: FIX_PROMPT }, { role: "user", content: text }] }),
  });
  if (!r.ok) return { ok: false, error: `Grok replied ${r.status}: ${(await r.text()).slice(0, 160)}` };
  const body = await r.json();
  const spent = addUsage(model, body.usage);
  const out = body.choices?.[0]?.message?.content?.trim();
  return out ? { ok: true, text: out, model, spentUsd: +spent.usd.toFixed(4) } : { ok: false, error: "empty reply" };
}

// ---------- In A Park's idea: Grok ranks the spelling candidates by how well each fits the sentence ----------
const RANK_MODEL = process.env.XAI_RANK_MODEL || "grok-4.20-0309-non-reasoning";     // the quickest model measured on this key
const RANK_TIMEOUT_MS = 2500;
const RANK_PROMPT = `A person is writing a sentence with an assistive keyboard. The last word of the sentence may be misspelled.
Rank the candidate words by how well each one fits as the last word of that sentence.
Use every candidate exactly once. Do not add words. Reply with only a JSON array of strings, best first.`;

// Never throws. On any failure, or an answer that is not exactly the same words, the order comes back unchanged.
async function grokRank(sentence, candidates) {
  const same = { ok: false, ranked: candidates };
  const key = process.env.XAI_API_KEY;
  if (!key) return { ...same, error: "no key" };
  const blocked = rankBlocked();
  if (blocked) return { ...same, error: blocked };
  const started = Date.now(), stop = new AbortController(), timer = setTimeout(() => stop.abort(), RANK_TIMEOUT_MS);
  let counted = false;
  try {
    const r = await fetch(`${XAI}/chat/completions`, {
      method: "POST", signal: stop.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: RANK_MODEL, temperature: 0, max_tokens: 80, messages: [{ role: "system", content: RANK_PROMPT }, { role: "user", content: JSON.stringify({ sentence, candidates }) }] }),
    });
    if (!r.ok) return { ...same, error: `Grok replied ${r.status}` };
    const body = await r.json();
    addRankUsage(body.usage); counted = true;
    const text = body.choices?.[0]?.message?.content || "";
    const ranked = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    const lower = (list) => list.map((w) => String(w).toLowerCase()).sort().join("|");
    if (!Array.isArray(ranked) || ranked.length !== candidates.length || lower(ranked) !== lower(candidates)) return { ...same, error: "answer was not the same words", ms: Date.now() - started };
    // Hand back the app's own spellings, in Grok's order.
    const byLower = new Map(candidates.map((w) => [w.toLowerCase(), w]));
    return { ok: true, ranked: ranked.map((w) => byLower.get(String(w).toLowerCase())), ms: Date.now() - started, model: RANK_MODEL };
  } catch (err) {
    // A call that timed out or broke off may still have been billed. Count it at a rough size, so it cannot slip past the guard.
    if (!counted) { try { addRankUsage({ prompt_tokens: 250, completion_tokens: 80 }); } catch { /* the ledger could not be written */ } }
    return { ...same, error: stop.signal.aborted ? "timed out" : (err instanceof Error ? err.message : "failed"), ms: Date.now() - started };
  } finally { clearTimeout(timer); }
}

function readBody(req, max = 10000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > max) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (url === "/api/fix" && req.method === "POST") {
    let result;
    try {
      const { text } = JSON.parse(await readBody(req));
      result = typeof text === "string" && text.trim() && text.length <= MAX_TEXT ? await grokFix(text.trim()) : { ok: false, error: "bad text" };
    } catch (err) { result = { ok: false, error: err instanceof Error ? err.message : "failed" }; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    return;
  }
  if (url === "/api/rank" && req.method === "POST") {
    let result = { ok: false, error: "bad request" };
    try {
      const { sentence, candidates } = JSON.parse(await readBody(req));
      const fine = typeof sentence === "string" && sentence.trim() && sentence.length <= 300 && Array.isArray(candidates)
        && candidates.length >= 2 && candidates.length <= 8 && candidates.every((w) => typeof w === "string" && /^[A-Za-z']{1,24}$/.test(w));
      if (fine) result = await grokRank(sentence.trim(), candidates);
    } catch (err) { result = { ok: false, error: err instanceof Error ? err.message : "failed" }; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    return;
  }
  if (url === "/api/status") {            // the page reports its own health here, so it can be checked from outside
    if (req.method === "POST") {
      try { lastStatus = { ...JSON.parse(await readBody(req)), at: Date.now() }; } catch { /* ignore a bad report */ }
      res.writeHead(204).end();
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(lastStatus ? { ...lastStatus, ageMs: Date.now() - lastStatus.at } : { none: true }));
    }
    return;
  }
  if (url === "/api/log" && req.method === "POST") {          // session events, appended to data/sessions/<session>.jsonl
    try {
      const { session, events } = JSON.parse(await readBody(req, 400000));
      if (/^[0-9TZ-]{10,40}$/.test(session) && Array.isArray(events)) {
        mkdirSync(join(ROOT, "data", "sessions"), { recursive: true });
        appendFileSync(join(ROOT, "data", "sessions", `${session}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      }
    } catch { /* drop a bad batch */ }
    res.writeHead(204).end();
    return;
  }
  if (url === "/api/usage") {
    const u = loadUsage();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...u, usd: +u.usd.toFixed(4), capUsd: MAX_USD, capCallsPerDay: MAX_CALLS_PER_DAY }));
    return;
  }
  const rel = url === "/" ? "public/index.html" : url.startsWith("/src/") ? url.slice(1) : join("public", url);
  const path = normalize(join(ROOT, rel));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => process.stdout.write(`four looks on http://localhost:${PORT}\n`));
