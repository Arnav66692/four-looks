// Tiny local server. / serves public/, /src/ serves shared modules, /api/fix asks Grok to check a sentence.
// Secrets come from .env (never committed, never sent to the page).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
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

let grokModel = process.env.XAI_MODEL || null;
async function pickModel(key) {
  if (grokModel) return grokModel;
  const r = await fetch(`${XAI}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`model list failed (${r.status})`);
  const ids = ((await r.json()).data || []).map((m) => m.id).filter((id) => /grok/i.test(id) && !/image|vision|imagine/i.test(id));
  grokModel = ids.find((id) => /fast|mini/i.test(id)) || ids[0];
  if (!grokModel) throw new Error("no Grok text model on this key");
  return grokModel;
}

const FIX_PROMPT = `You fix text typed by a person who cannot use their hands, using a head-controlled keyboard.
Correct spelling, grammar and wrong-word slips. Keep their meaning, their words and their tone. Do not add ideas.
If the text is already fine, return it unchanged. Reply with the corrected text only, no quotes, no notes.`;

async function grokFix(text) {
  const key = process.env.XAI_API_KEY;
  if (!key) return { ok: false, error: "no key" };
  const model = await pickModel(key);
  const r = await fetch(`${XAI}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 300, messages: [{ role: "system", content: FIX_PROMPT }, { role: "user", content: text }] }),
  });
  if (!r.ok) return { ok: false, error: `Grok replied ${r.status}` };
  const out = (await r.json()).choices?.[0]?.message?.content?.trim();
  return out ? { ok: true, text: out, model } : { ok: false, error: "empty reply" };
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
