// Claude-powered recommender (CONTRACT.md v3 "Recommendation"). Node only.
//
// Agentic tool loop on the official @anthropic-ai/sdk: Claude Opus 5.5 at low effort can call
// get_market_history / get_live_context / get_related_markets / get_forecast, then answers with
// a JSON Recommendation constrained by structured outputs (output_config.format). Server-side
// refusal fallbacks are on (beta `server-side-fallback-2026-07-01`, `fallbacks: "default"`).
//
// Any error, refusal, truncation, timeout, rate-limit or budget exhaustion → resolves `null`
// so the caller keeps the rules recommendation. Never throws.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROLES, TRADER_DISCLAIMER } from './rules.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_TURNS = 5;
const MAX_TOKENS = 4096; // thinking (always on for Opus 5.5) counts toward this, so leave room

// ---------- credentials ----------

/**
 * Is an Anthropic credential available to the SDK? Mirrors the SDK resolution order:
 * ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN → an `ant auth login` profile.
 * → { ok: boolean, source: 'env:ANTHROPIC_API_KEY' | 'env:ANTHROPIC_AUTH_TOKEN' | 'profile' | 'ant' | null }
 */
export function detectCredentials({ env = process.env, exec = execFileSync, fsExists = existsSync, readDir = readdirSync } = {}) {
  if (env.ANTHROPIC_API_KEY) return { ok: true, source: 'env:ANTHROPIC_API_KEY' };
  if (env.ANTHROPIC_AUTH_TOKEN) return { ok: true, source: 'env:ANTHROPIC_AUTH_TOKEN' };
  // Profile written by `ant auth login`: $ANTHROPIC_CONFIG_DIR (default ~/.config/anthropic)/credentials/<profile>.json
  try {
    const dir = join(env.ANTHROPIC_CONFIG_DIR || join(homedir(), '.config', 'anthropic'), 'credentials');
    if (fsExists(dir) && readDir(dir).some((f) => f.endsWith('.json'))) return { ok: true, source: 'profile' };
  } catch {}
  // `ant auth status` reports which source won (status only; don't trust its exit code).
  try {
    const out = String(exec('ant', ['auth', 'status'], { timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '');
    if (out && !/not (logged|authenticated|signed)|no (credential|profile|api key)|unauthenticated/i.test(out) && /(profile|api key|token|logged in|authenticated)/i.test(out))
      return { ok: true, source: 'ant' };
  } catch {}
  return { ok: false, source: null };
}

// ---------- prompt & schemas ----------

export const SYSTEM_PROMPT = `You are Tipoff's recommendation agent. Tipoff watches Polymarket and Kalshi prediction markets for sudden price and volatility spikes and tells people what is about to happen, worded for their role.

You get one market event (a price spike, a volatility spike, a ranked "shot" to watch, or an insight) and the user's role. Use the tools to check what you need (recent price history, the live game or asset situation, the model's 30-minute move forecast, sibling markets), then return one recommendation as JSON.

Role guidance:
- photographer: where to point the camera in the next few minutes (end zone, goalmouth, bench, podium, the winner's side for a celebration). Lead with the live situation when there is one.
- trader: what the signal says (direction, size and speed of the move, volatility, whether spot or sibling markets confirm). Suggest reviewing a position, limits or size; never tell anyone to buy, sell or bet a specific amount; non-personalized. Always set disclaimer to "Signal, not financial advice."
- fan: whether to tune in right now and why, in a fan's voice.
- journalist: what the shift means for coverage (draft both versions, find the catalyst, prep the result story).
- general: a plain-language heads-up.

Rules:
- Cite real numbers you were given or fetched: probabilities as percentages, moves in points with their time window, volatility ratios, scores, down and distance, spot price changes. Never invent numbers or game facts.
- Prediction-market moves are crowd signals, not certainties. Say "likely" or "~92%", never "will" or "guaranteed".
- headline: at most 80 characters, concrete, e.g. "Chiefs 1st & goal at the 4 — get the end-zone shot". action: one imperative line for the role. reasoning: 1 to 3 short bullets citing the numbers or game situation. confidence: low, medium or high, based on the size and quality of the signal.
- For roles other than trader, set disclaimer to an empty string.
- Be fast: call only the tools that would change your answer, ideally in a single parallel batch.`;

const RECOMMENDATION_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'At most 80 characters, concrete and specific.' },
    action: { type: 'string', description: 'One imperative line for this role.' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'array', items: { type: 'string' }, description: '1-3 short bullets citing numbers / game situation.' },
    disclaimer: { type: 'string', description: 'Trader: "Signal, not financial advice." Others: empty string.' },
  },
  required: ['headline', 'action', 'confidence', 'reasoning', 'disclaimer'],
  additionalProperties: false,
};

const idOnly = (extra = {}, req = []) => ({
  type: 'object',
  properties: { market_id: { type: 'string', description: 'Market id, e.g. "polymarket:123" or "kalshi:TICKER".' }, ...extra },
  required: ['market_id', ...req],
  additionalProperties: false,
});

export const TOOL_DEFS = [
  {
    name: 'get_market_history',
    description:
      'Recent probability history for a market as [minutesAgo, probability] pairs (downsampled). Call this to see the shape of the move: how fast, whether it is still going, whether it already reversed.',
    strict: true,
    input_schema: idOnly({ minutes: { type: 'integer', description: 'Lookback window in minutes (e.g. 30, 60, 360).' } }, ['minutes']),
  },
  {
    name: 'get_live_context',
    description:
      'Live situation for the event behind the market: for games, status, clock, score, situation (e.g. "1st & Goal at KC 4"), imminent play; for crypto, spot price and 5m/1h change. Call this for sports, esports and crypto markets before writing a photographer, fan or trader recommendation. Returns null when nothing matched.',
    strict: true,
    input_schema: idOnly(),
  },
  {
    name: 'get_related_markets',
    description:
      'Sibling markets of the same event (other outcomes, spreads, totals, the same question on the other venue) with their current probabilities and 1h changes. Call this to check whether a move is confirmed across markets.',
    strict: true,
    input_schema: idOnly(),
  },
  {
    name: 'get_forecast',
    description:
      "Tipoff's model forecast for the next 30 minutes: pMove30 (probability of a 5+ point swing), expected max move in points, and top drivers. Call this when deciding how urgent the recommendation is.",
    strict: true,
    input_schema: idOnly(),
  },
];

// ---------- helpers ----------

const r3 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

function compactHistory(points, minutes, now) {
  if (!Array.isArray(points) || !points.length) return { points: [], note: 'no history' };
  const lastT = points[points.length - 1].t ?? now;
  const since = lastT - Math.max(1, minutes) * 60e3;
  let P = points.filter((q) => q && q.t >= since);
  if (P.length < 2) P = points.slice(-2);
  const step = Math.max(1, Math.ceil(P.length / 40));
  const out = P.filter((_, i) => i % step === 0 || i === P.length - 1).map((q) => [Math.round((now - q.t) / 6e3) / 10, r3(q.p)]);
  return { format: '[minutesAgo, probability]', points: out };
}

function compactMarket(m = {}) {
  const pick = ['id', 'source', 'title', 'outcome', 'otherOutcome', 'probability', 'change1h', 'change5m', 'volume24h', 'category', 'tags', 'endDate', 'startTime', 'live', 'eventKey'];
  const o = {};
  for (const k of pick) if (m[k] !== undefined && m[k] !== null) o[k] = typeof m[k] === 'number' ? r3(m[k]) : m[k];
  return o;
}

function compactTarget(t = {}) {
  const drop = new Set(['market', 'recommendations', 'context', 'tips', 'matchedSubscriptions']);
  const o = {};
  for (const [k, v] of Object.entries(t)) if (!drop.has(k) && v !== undefined) o[k] = typeof v === 'number' ? r3(v) : v;
  if (o.kind === undefined && (t.from !== undefined || t.delta !== undefined)) o.kind = 'price';
  return o;
}

export function targetKind(t = {}) {
  if (t.kind === 'volatility' || t.kind === 'price') return t.kind;
  if (t.dramaScore !== undefined || (t.kind && t.headline)) return `shot:${t.kind || 'shot'}`;
  if (t.type) return `insight:${t.type}`;
  return 'price';
}

function textOf(content = []) {
  return content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return null;
}

const OVERCLAIM = /\b(guaranteed?|risk[- ]free|sure thing|can'?t lose|bet (your|\$|\d))/i;

/** Validate + normalize the model JSON into a contract Recommendation, or null. */
export function normalizeRecommendation(obj, role, model) {
  if (!obj || typeof obj !== 'object') return null;
  const s = (x) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '');
  let headline = s(obj.headline);
  const action = s(obj.action);
  if (!headline || !action) return null;
  if (headline.length > 80) headline = `${headline.slice(0, 79).trimEnd()}…`;
  const reasoning = (Array.isArray(obj.reasoning) ? obj.reasoning : []).map(s).filter(Boolean).slice(0, 3).map((x) => (x.length > 160 ? `${x.slice(0, 159)}…` : x));
  if (OVERCLAIM.test(`${headline} ${action}`)) return null;
  const rec = {
    role,
    headline,
    action,
    confidence: ['low', 'medium', 'high'].includes(obj.confidence) ? obj.confidence : 'medium',
    reasoning,
    source: 'claude',
    model,
  };
  if (role === 'trader') rec.disclaimer = TRADER_DISCLAIMER;
  else if (s(obj.disclaimer)) rec.disclaimer = s(obj.disclaimer);
  return rec;
}

// ---------- recommender ----------

/**
 * createClaudeRecommender(opts) → { available, model, recommend(target, ctx) → Promise<Recommendation|null>, stats() }
 *
 * opts.client  – injected SDK-compatible client (tests). Must expose `beta.messages.create(body, {signal})`.
 * opts.tools   – { getMarketHistory(marketId, {minutes}) , getLiveContext(market), getRelatedMarkets(market|marketId), getForecast(marketId|market) } (sync or async).
 *                ctx values (history, context, related, forecast) are used first when present.
 * opts.credentials – override detection (true/false). opts.env – env for detection.
 */
export function createClaudeRecommender({
  client = null,
  model = DEFAULT_MODEL,
  maxCallsPerHour = 60,
  cacheMs = 10 * 60e3,
  timeoutMs = 20000,
  tools = {},
  effort = 'low',
  credentials,
  env = process.env,
  log = (...a) => console.log('[agent]', ...a),
  now: clock = () => Date.now(),
} = {}) {
  const enabledByEnv = !env.OD_AGENT || env.OD_AGENT === 'claude';
  const cred = client ? { ok: true, source: 'injected' } : credentials !== undefined ? { ok: Boolean(credentials), source: credentials ? 'override' : null } : detectCredentials({ env });
  const available = Boolean(enabledByEnv && cred.ok);

  let clientPromise = client ? Promise.resolve(client) : null;
  const getClient = () => {
    if (!clientPromise)
      clientPromise = import('@anthropic-ai/sdk').then(({ default: Anthropic }) => new Anthropic({ timeout: timeoutMs, maxRetries: 1 }));
    return clientPromise;
  };

  const cache = new Map(); // key → {at, rec}
  const inflight = new Map(); // key → Promise
  const calls = []; // timestamps of API-backed recommend() runs, last hour
  const totals = { runs: 0, ok: 0, failed: 0, refused: 0, timeouts: 0, rateLimited: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  function budgetOk(t) {
    while (calls.length && calls[0] <= t - 3600e3) calls.shift();
    return calls.length < maxCallsPerHour;
  }

  async function runTool(name, input, target, ctx) {
    const market = ctx.market || target.market || {};
    const id = input?.market_id || market.id;
    const sameMarket = !id || id === market.id;
    switch (name) {
      case 'get_market_history': {
        const minutes = Math.min(Math.max(Number(input?.minutes) || 60, 5), 24 * 60);
        let pts = sameMarket && Array.isArray(ctx.history) && ctx.history.length ? ctx.history : null;
        if (!pts && tools.getMarketHistory) pts = await tools.getMarketHistory(id, { minutes });
        return compactHistory(pts || [], minutes, clock());
      }
      case 'get_live_context': {
        if (sameMarket && ctx.context !== undefined && ctx.context !== null) return ctx.context;
        if (!sameMarket && !tools.getMarket) return { error: 'live context is only available for the event market' };
        const m = sameMarket ? market : await tools.getMarket(id);
        if (tools.getLiveContext) return (await tools.getLiveContext(m)) ?? null;
        return null;
      }
      case 'get_related_markets': {
        let rel = sameMarket && Array.isArray(ctx.related) && ctx.related.length ? ctx.related : null;
        if (!rel && tools.getRelatedMarkets) rel = await tools.getRelatedMarkets(sameMarket ? market : id);
        return (rel || []).slice(0, 12).map((x) => compactMarket(x.market || x));
      }
      case 'get_forecast': {
        if (sameMarket && ctx.forecast) return ctx.forecast;
        if (sameMarket && target.forecast) return target.forecast;
        if (tools.getForecast) return (await tools.getForecast(sameMarket ? market : id)) ?? null;
        return null;
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  async function loop(target, ctx, role, signal) {
    const c = await getClient();
    const market = ctx.market || target.market || {};
    const payload = {
      role,
      target: compactTarget(target),
      market: compactMarket(market),
      ...(ctx.draft ? { rulesDraft: { headline: ctx.draft.headline, action: ctx.draft.action } } : {}),
    };
    const messages = [
      {
        role: 'user',
        content: `Write the ${role} recommendation for this event. Check the tools first if the live situation, history or forecast would sharpen it. Respond with the JSON recommendation only.\n\n${JSON.stringify(payload)}`,
      },
    ];
    const usage = { in: 0, out: 0, cacheRead: 0 };
    const used = [];
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await c.beta.messages.create(
        {
          model,
          max_tokens: MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          system: SYSTEM_PROMPT,
          tools: TOOL_DEFS,
          tool_choice: { type: 'auto' },
          cache_control: { type: 'ephemeral' },
          output_config: { effort, format: { type: 'json_schema', schema: RECOMMENDATION_SCHEMA } },
          messages,
        },
        { signal },
      );
      usage.in += res?.usage?.input_tokens || 0;
      usage.out += res?.usage?.output_tokens || 0;
      usage.cacheRead += res?.usage?.cache_read_input_tokens || 0;
      const stop = res?.stop_reason;
      if (stop === 'refusal') return { rec: null, why: `refusal${res?.stop_details?.category ? `:${res.stop_details.category}` : ''}`, usage, used, turns: turn + 1 };
      if (stop === 'max_tokens') return { rec: null, why: 'max_tokens', usage, used, turns: turn + 1 };
      const content = Array.isArray(res?.content) ? res.content : [];
      if (stop === 'pause_turn') {
        messages.push({ role: 'assistant', content });
        continue;
      }
      const toolUses = content.filter((b) => b && b.type === 'tool_use');
      if (stop === 'tool_use' && toolUses.length) {
        // Pass the full assistant content back unchanged (thinking blocks included).
        messages.push({ role: 'assistant', content });
        const results = await Promise.all(
          toolUses.map(async (b) => {
            used.push(b.name);
            try {
              const out = await runTool(b.name, b.input, target, ctx);
              return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out ?? null) };
            } catch (e) {
              return { type: 'tool_result', tool_use_id: b.id, is_error: true, content: `tool failed: ${e?.message || e}` };
            }
          }),
        );
        messages.push({ role: 'user', content: results });
        continue;
      }
      const servedBy = res?.model || model;
      const rec = normalizeRecommendation(parseJson(textOf(content)), role, servedBy);
      return { rec, why: rec ? 'ok' : `bad-output:${stop}`, usage, used, turns: turn + 1, servedBy };
    }
    return { rec: null, why: 'max_turns', usage, used, turns: MAX_TURNS };
  }

  async function recommend(target = {}, ctx = {}) {
    if (!available) return null;
    const role = ROLES.includes(ctx.role) ? ctx.role : 'general';
    const market = ctx.market || target.market || {};
    const key = `${market.id || target.marketId || target.id}|${role}|${targetKind(target)}`;
    const t = clock();
    const hit = cache.get(key);
    if (hit && t - hit.at < cacheMs) {
      totals.cacheHits++;
      return hit.rec;
    }
    if (inflight.has(key)) return inflight.get(key);
    if (!budgetOk(t)) {
      totals.rateLimited++;
      log(`budget exhausted (${maxCallsPerHour}/h); rules only for ${key}`);
      return null;
    }
    calls.push(t);
    totals.runs++;
    const ac = new AbortController();
    let timer;
    const started = Date.now();
    const p = (async () => {
      try {
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => {
            ac.abort();
            resolve({ rec: null, why: 'timeout', usage: null, used: [], turns: 0 });
          }, timeoutMs);
        });
        const r = await Promise.race([loop(target, ctx, role, ac.signal), timeout]);
        const ms = Date.now() - started;
        if (r.usage) {
          totals.inputTokens += r.usage.in;
          totals.outputTokens += r.usage.out;
          totals.cacheReadTokens += r.usage.cacheRead;
        }
        if (r.why === 'timeout') totals.timeouts++;
        else if (String(r.why).startsWith('refusal')) totals.refused++;
        log(
          `claude ${key} ${r.why} turns=${r.turns} tools=[${(r.used || []).join(',')}]` +
            (r.usage ? ` tokens in=${r.usage.in} out=${r.usage.out} cacheRead=${r.usage.cacheRead}` : '') +
            ` ${ms}ms${r.servedBy && r.servedBy !== model ? ` servedBy=${r.servedBy}` : ''}`,
        );
        if (r.rec) {
          totals.ok++;
          cache.set(key, { at: clock(), rec: r.rec });
          return r.rec;
        }
        totals.failed++;
        return null;
      } catch (e) {
        totals.failed++;
        if (ac.signal.aborted) totals.timeouts++;
        log(`claude ${key} error: ${e?.status ? `${e.status} ` : ''}${e?.message || e} (${Date.now() - started}ms)`);
        return null;
      } finally {
        clearTimeout(timer);
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  return {
    available,
    model,
    credentialSource: cred.source,
    recommend,
    stats: () => ({ ...totals, callsLastHour: calls.filter((x) => x > clock() - 3600e3).length, cacheSize: cache.size }),
  };
}
