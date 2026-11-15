import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'https://api.x.ai/v1';
const USAGE_FILE = fileURLToPath(new URL('../.usage.json', import.meta.url));
const today = () => new Date().toISOString().slice(0, 10);
// Match server.js estimates; these are not authoritative billing totals.
const PRICES = { 'grok-4.3': [1.25, 2.5], 'grok-4.7': [2, 6] };
const FALLBACK_PRICE = [0, 1].map((index) => Math.max(...Object.values(PRICES).map((price) => price[index])));
let queue = Promise.resolve();
let unmetered = null;

function nonnegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}; refusing to bypass the spend guard`);
  }
  return value;
}

function loadUsage() {
  let raw;
  try { raw = readFileSync(USAGE_FILE, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') {
      return { usd: 0, calls: 0, inTokens: 0, outTokens: 0, day: '', callsToday: 0 };
    }
    throw new Error('Cannot read .usage.json; refusing to bypass the spend guard');
  }
  let usage;
  try { usage = JSON.parse(raw); } catch {
    throw new Error('Invalid .usage.json; refusing to bypass the spend guard');
  }
  if (!usage || typeof usage.day !== 'string') throw new Error('Invalid .usage.json day');
  for (const name of ['usd', 'calls', 'inTokens', 'outTokens', 'callsToday']) {
    nonnegative(usage[name], `.usage.json ${name}`);
  }
  return usage;
}

export function overBudget() {
  if (unmetered) return unmetered;
  const usage = loadUsage();
  const maxUsd = nonnegative(Number(process.env.FL_MAX_USD ?? 1), 'FL_MAX_USD');
  const maxCalls = nonnegative(Number(process.env.FL_MAX_CALLS_PER_DAY ?? 300), 'FL_MAX_CALLS_PER_DAY');
  if (usage.usd >= maxUsd) return `spend cap reached (about $${usage.usd.toFixed(3)} of $${maxUsd})`;
  if ((usage.day === today() ? usage.callsToday : 0) >= maxCalls) return `daily call cap reached (${maxCalls})`;
  return null;
}

function nextUsage(model, usage) {
  const current = loadUsage();
  const inTokens = nonnegative(usage?.prompt_tokens ?? usage?.input_tokens ?? 0, 'input tokens');
  const outTokens = nonnegative(usage?.completion_tokens ?? usage?.output_tokens ?? 0, 'output tokens');
  const [inputPrice, outputPrice] = Object.hasOwn(PRICES, model) ? PRICES[model] : FALLBACK_PRICE;
  return {
    ...(typeof current.rankDay === 'string' ? { rankDay: current.rankDay, rankToday: current.rankToday } : {}), // server.js keeps these for Grok guesses
    usd: current.usd + (inTokens * inputPrice + outTokens * outputPrice) / 1e6,
    calls: current.calls + 1,
    inTokens: current.inTokens + inTokens,
    outTokens: current.outTokens + outTokens,
    day: today(),
    callsToday: (current.day === today() ? current.callsToday : 0) + 1,
  };
}

export function addUsage(model, usage) {
  try {
    const next = nextUsage(model, usage);
    writeFileSync(USAGE_FILE, JSON.stringify(next));
    return next;
  } catch {
    unmetered = 'Cannot record xAI usage; further requests blocked. Review .usage.json before restarting.';
    throw new Error(unmetered);
  }
}

async function request(key, path, body) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('XAI_API_KEY is missing');
  const redact = (value) => String(value).replaceAll(key, '[REDACTED]');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let status;
  let httpFailure = false;
  try {
    const response = await fetch(`${API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    status = response.status;
    httpFailure = !response.ok;
    const raw = await response.text();
    if (!response.ok) throw new Error(`xAI HTTP ${status}: ${redact(raw).slice(0, 200)}`);
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid response object');
      return parsed;
    } catch {
      throw new Error(`xAI HTTP ${status}: invalid JSON: ${redact(raw).slice(0, 200)}`);
    }
  } catch (error) {
    const failure = new Error(controller.signal.aborted
      ? `xAI request timed out after 20 seconds${status ? ` (HTTP ${status})` : ''}`
      : redact(error instanceof Error ? error.message : 'xAI request failed'));
    failure.httpFailure = httpFailure;
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

function blockUnmetered(model) {
  unmetered = 'Unmetered xAI request; budget exhausted conservatively. Review billing before resetting .usage.json and restarting.';
  // Preserve the shared schema and persist the block across restarts. USD is an estimate.
  const next = nextUsage(model, {});
  next.usd = Math.max(next.usd, Number(process.env.FL_MAX_USD ?? 1));
  writeFileSync(USAGE_FILE, JSON.stringify(next));
}

const FAST_MODEL = 'grok-4.20-0309-non-reasoning';
export async function chooseVisionModel(key) {
  const body = await request(key, '/models');
  const models = Array.isArray(body.data) ? body.data.filter((model) => model && typeof model.id === 'string') : [];
  const ids = models.map((model) => model.id).filter((id) => typeof id === 'string');
  const override = process.env.XAI_VISION_MODEL?.trim();
  if (override) {
    if (!ids.includes(override)) throw new Error('XAI_VISION_MODEL is not available from /v1/models');
    return override;
  }
  // Measured on Nov 14, 2026 with this agent's own request: grok-4.20-0309-non-reasoning answered in about
  // 0.6 to 1.1 s and took a screenshot, against 2.8 s for grok-4.3, 5.6 s for grok-4.7 and 6.1 s for grok-build-0.1.
  if (ids.includes(FAST_MODEL)) return FAST_MODEL;
  if (ids.includes('grok-4.7')) return 'grok-4.7';
  // Use capability metadata if offered. The compatible /models response may omit it.
  const advertised = models.find((model) => {
    const inputs = model.input_modalities ?? model.modalities?.input ?? [];
    return Array.isArray(inputs) && inputs.includes('image') && /grok/i.test(model.id)
      && !/imagine|image-generation/i.test(model.id);
  });
  if (advertised) return advertised.id;
  // Historically vision-capable IDs; current docs could not be reached in the sandbox.
  for (const id of ['grok-4-1-fast-reasoning', 'grok-4-1-fast-non-reasoning', 'grok-4', 'grok-4-0709', 'grok-2-vision-1212']) {
    if (ids.includes(id)) return id;
  }
  if (ids.includes('grok-4.3')) return 'grok-4.3'; // Project's flagship fallback, capability unverified.
  throw new Error('No recognized vision model available; set XAI_VISION_MODEL to a verified vision model');
}

export async function chooseTextModel(key, visionModel) {
  const override = process.env.XAI_AGENT_MODEL?.trim();
  return override || visionModel || chooseVisionModel(key);
}

export async function askGrok({ key, model, messages, tools, temperature = 0, maxTokens = 500 }) {
  // Serialize this module's requests so overlapping agents cannot pass the same cap check.
  // server.js uses its own unlocked ledger; cross-process contention remains an integration limit.
  const run = async () => {
    const blocked = overBudget();
    if (blocked) throw new Error(blocked);
    if (typeof model !== 'string' || !model) throw new Error('A model is required');
    if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('maxTokens must be a positive integer');
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('temperature must be between 0 and 2');
    if (typeof key !== 'string' || !key.trim()) throw new Error('XAI_API_KEY is missing');
    const started = performance.now();
    let body;
    try {
      body = await request(key, '/chat/completions', {
        model, messages, tools, tool_choice: 'required', parallel_tool_calls: true, temperature, max_tokens: maxTokens,
      });
    } catch (error) {
      if (!error.httpFailure) blockUnmetered(model); // A timeout/network failure may still have been billed.
      throw error;
    }
    const input = body.usage?.prompt_tokens ?? body.usage?.input_tokens;
    const output = body.usage?.completion_tokens ?? body.usage?.output_tokens;
    if (![input, output].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      blockUnmetered(model);
      throw new Error('xAI HTTP 200: missing or invalid token usage; remaining estimated budget exhausted');
    }
    addUsage(model, body.usage);
    const message = body.choices?.[0]?.message;
    if (!message || typeof message !== 'object') throw new Error('xAI HTTP 200: missing assistant message');
    return { message, usage: body.usage, ms: performance.now() - started };
  };
  const pending = queue.then(run);
  queue = pending.catch(() => {});
  return pending;
}
