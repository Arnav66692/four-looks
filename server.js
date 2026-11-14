// Tiny local server. / serves public/, /src/ serves shared modules, /api/fix asks Grok to check a sentence.
// Secrets come from .env (never committed, never sent to the page).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
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
    usd: u.usd + (inT * pin + outT * pout) / 1e6, calls: u.calls + 1, inTokens: u.inTokens + inT, outTokens: u.outTokens + outT,
    day: today(), callsToday: (u.day === today() ? u.callsToday : 0) + 1,
  };
  writeFileSync(USAGE_FILE, JSON.stringify(next));
  return next;
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 10000) { reject(new Error("too large")); req.destroy(); } });
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
  if (url === "/api/status") {            // the page reports its own health here, so it can be checked from outside
    if (req.method === "POST") {
      try { lastStatus = { ...JSON.parse(await readBody(req)), at: Date.now() }; } catch { /* ignore a bad report */ }
      res.writeHead(204).end();
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(lastStatus ? { ...lastStatus, ageMs: Date.now() - lastStatus.at } : { none: true }));
    }
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
