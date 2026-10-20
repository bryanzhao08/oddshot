// Tipoff server: REST + SSE + static files + poll loop. Zero dependencies.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { Store } from './store.js';
import { matchSubscriptions, matchInsightSubscriptions, validateSubscription, severityRank } from './match.js';
import { deliver, notifySubscriptions, sampleSpike, formatMessage, formatInsight } from './notify.js';
import { buildShots, InsightEngine, StoryEngine, storyInsight, buildBriefing, heuristicForecast } from './insights/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, '..', 'public');
const MAX_BODY = 64 * 1024;
const PING_MS = 20_000;
const VIX_HISTORY_MS = 6 * 60 * 60 * 1000;
const KNOWN_SOURCES = ['polymarket', 'kalshi'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webmanifest': 'application/manifest+json',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, `request body too large (max ${MAX_BODY} bytes)`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function intParam(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Fallback spike builder in case the detector module doesn't export makeSpike. */
function localMakeSpike(market, from, to, windowMs, extra = {}) {
  const delta = to - from;
  const abs = Math.abs(delta);
  return {
    id: randomUUID(),
    marketId: market.id,
    title: market.title,
    source: market.source,
    category: market.category,
    tags: market.tags || [],
    url: market.url,
    outcome: market.outcome,
    from,
    to,
    delta,
    windowMs,
    zScore: 0,
    severity: abs >= 0.15 ? 'major' : abs >= 0.08 ? 'notable' : 'info',
    live: !!market.live,
    detectedAt: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Build the app. Dependencies are injectable so tests can run without network.
 * @param {object} deps { fetchAllMarkets, Detector, makeSpike, store, pollMs, publicDir, logger }
 */
export function createApp({
  fetchAllMarkets,
  Detector,
  makeSpike = localMakeSpike,
  store = new Store(),
  pollMs = 20000,
  publicDir = PUBLIC_DIR,
  marketLimit = 300,
  sourceStatus = null, // optional live status object from sources/index.js ({name: {ok, count, error}})
  scoreSpike = null, // optional ML scorer (server/ml/scorer.js): (spike, market, history) => {pReal, label, drivers} | null
  forecast = heuristicForecast, // Moment Forecaster: (market, history, now) => forecast | null
  backfill = null, // optional async (markets, detector, log) => stats; runs once after the first poll
  getLiveContext = null, // optional (market) => Promise<context|null> (server/context), sports/crypto only
  recommender = null, // optional instance from server/agent createRecommender()
  createRecommender = null, // ...or a factory: ({tools}) => recommender (gets app-backed tools)
  contextBudgetMs = 2000, // max time a poll waits for live context before moving on
  logger = console,
} = {}) {
  const detector = new Detector();
  const insightEngine = new InsightEngine();
  const storyEngine = new StoryEngine();
  let forecastMemo = new Map(); // marketId -> forecast, cleared every tick
  const state = {
    markets: [],
    marketById: new Map(),
    change1h: new Map(),
    lastPollAt: null,
    polls: 0,
    sources: Object.fromEntries(KNOWN_SOURCES.map((s) => [s, { ok: false, count: 0, error: 'not polled yet' }])),
    vixHistory: [],
    shots: [], // top Shot[] (general persona) from the latest tick
    shotsAt: 0,
    backfill: { status: backfill ? 'pending' : 'disabled' },
  };
  const clients = new Set();
  let pollTimer = null;
  let pingTimer = null;
  let stopped = false;
  let polling = false;

  // ---------- SSE ----------
  function sseWrite(res, event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
  function broadcast(event, data) {
    for (const res of clients) sseWrite(res, event, data);
  }
  function startPing() {
    pingTimer = setInterval(() => {
      for (const res of clients) {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch {
          clients.delete(res);
        }
      }
    }, PING_MS);
    pingTimer.unref?.();
  }

  // ---------- live context (ESPN game state / crypto spot), cached, never blocks for long ----------
  const CONTEXT_TTL_MS = 15_000;
  const contextCache = new Map(); // marketId -> {at, value, inflight}
  const wantsContext = (m) => Boolean(getLiveContext && m && (m.category === 'sports' || m.category === 'crypto'));

  function refreshContext(m) {
    if (!wantsContext(m)) return Promise.resolve(null);
    const hit = contextCache.get(m.id);
    if (hit?.inflight) return hit.inflight;
    if (hit && Date.now() - hit.at < CONTEXT_TTL_MS) return Promise.resolve(hit.value);
    const inflight = Promise.race([
      Promise.resolve().then(() => getLiveContext(m)).catch(() => null),
      new Promise((r) => setTimeout(() => r(undefined), 8000).unref?.()),
    ]).then((value) => {
      const v = value === undefined ? hit?.value ?? null : value || null;
      contextCache.set(m.id, { at: Date.now(), value: v });
      return v;
    });
    contextCache.set(m.id, { at: hit?.at || 0, value: hit?.value ?? null, inflight });
    return inflight;
  }

  /** Cached context right now (kicks a background refresh when stale). */
  function contextNow(m) {
    if (!wantsContext(m)) return null;
    const hit = contextCache.get(m.id);
    if (!hit || Date.now() - hit.at >= CONTEXT_TTL_MS) refreshContext(m);
    return hit?.value ?? null;
  }

  /** Refresh context for these markets, waiting at most `budget` ms in total. */
  async function prefetchContext(markets, budget = contextBudgetMs) {
    const list = [...new Map(markets.filter(wantsContext).map((m) => [m.id, m])).values()].slice(0, 40);
    if (!list.length) return;
    await Promise.race([Promise.allSettled(list.map(refreshContext)), new Promise((r) => setTimeout(r, budget).unref?.())]);
  }

  // ---------- recommendations (rules now, Claude upgrade later) ----------
  const ROLES = ['photographer', 'trader', 'fan', 'journalist', 'general'];
  const upgrades = new Map(); // `${targetId}|${role}` -> Claude recommendation
  const relatedOf = (m) =>
    m?.eventKey ? state.markets.filter((x) => x.eventKey === m.eventKey && x.id !== m.id).slice(0, 10) : [];
  let rec = recommender;
  if (!rec && typeof createRecommender === 'function') {
    try {
      rec = createRecommender({
        tools: {
          getMarketHistory: (id, { minutes = 60 } = {}) => historyOf(id).filter((q) => q.t >= Date.now() - minutes * 60_000),
          getLiveContext: (m) => refreshContext(m),
          getRelatedMarkets: (m) => relatedOf(typeof m === 'string' ? state.marketById.get(m) : m),
          getForecast: (m) => {
            const mk = typeof m === 'string' ? state.marketById.get(m) : m;
            return mk ? forecastFor(mk) : null;
          },
          getMarket: (id) => state.marketById.get(id) || null,
        },
      });
    } catch (err) {
      logger.warn('[agent] recommender failed to start:', err?.message || err);
      rec = null;
    }
  }

  function recContext(market) {
    const history = market ? historyOf(market.id) : [];
    return { market, history, context: contextNow(market), forecast: market ? forecastFor(market, history) : null, related: relatedOf(market) };
  }

  function rememberUpgrade(targetId, role, r) {
    upgrades.set(`${targetId}|${role}`, r);
    if (upgrades.size > 1000) upgrades.delete(upgrades.keys().next().value);
  }

  /** Attach context + per-role recommendations to a spike/shot/insight (mutates and returns target). */
  function enrich(target, market) {
    if (!market) return target;
    const ctx = recContext(market);
    if (ctx.context) target.context = ctx.context;
    if (rec) {
      try {
        const recs = rec.recommendNow(target, ctx) || {};
        for (const role of ROLES) {
          const up = upgrades.get(`${target.id}|${role}`);
          if (up) recs[role] = up;
        }
        target.recommendations = recs;
      } catch (err) {
        logger.warn('[agent] recommendNow failed:', err?.message || err);
      }
    }
    return target;
  }

  /** Ask Claude to upgrade these roles; resolves when done or after `waitMs`. */
  function upgradeRoles(target, market, roles, waitMs = 8000) {
    if (!rec?.available || !market || !target.recommendations) return Promise.resolve();
    const ctx = recContext(market);
    const jobs = [...new Set(roles)].map((role) =>
      rec.recommendSmart(target, ctx, role, (r) => {
        rememberUpgrade(target.id, role, r);
        target.recommendations[role] = r;
        broadcast('recommendation', { targetId: target.id, role, recommendation: r });
      }),
    );
    return Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, waitMs).unref?.())]);
  }

  /** Notify matched subscribers, after giving Claude a few seconds to upgrade their personas' copy. */
  function deliverTo(target, market, matched) {
    const roles = matched.length ? matched.map((s) => s.persona || 'general') : ['general'];
    const withHooks = matched.filter((s) => s.webhook?.url);
    upgradeRoles(target, market, roles, withHooks.length ? 8000 : 0)
      .catch(() => {})
      .then(() => {
        if (withHooks.length) notifySubscriptions(target, withHooks);
      });
  }

  // ---------- pipeline ----------
  function handleSpike(spike) {
    try {
      const subs = store.listSubscriptions();
      const market = state.marketById.get(spike.marketId);
      if (typeof scoreSpike === 'function' && !spike.ml) {
        const ml = market ? scoreSpike(spike, market, detector.history(spike.marketId) || []) : null;
        if (ml) spike = { ...spike, ml };
      }
      const matchedIds = matchSubscriptions(spike, subs);
      const enriched = enrich({ kind: 'price', ...spike, matchedSubscriptions: matchedIds }, market);
      store.addAlert(enriched);
      broadcast('spike', enriched);
      deliverTo(enriched, market, subs.filter((s) => matchedIds.includes(s.id)));
      logger.log(`[spike] ${formatMessage(enriched)}${matchedIds.length ? ` → ${matchedIds.length} sub(s)` : ''}`);
      return enriched;
    } catch (err) {
      logger.warn('[spike] pipeline error:', err?.message || err);
      return null;
    }
  }

  // ---------- recommender ----------
  const historyOf = (id) => {
    try {
      return detector.history(id) || [];
    } catch {
      return [];
    }
  };

  function forecastFor(market, history, now = Date.now()) {
    const hit = forecastMemo.get(market.id);
    if (hit) return hit;
    let fc = null;
    try {
      fc = forecast ? forecast(market, history ?? historyOf(market.id), now) : null;
    } catch {
      fc = null;
    }
    if (!fc) fc = heuristicForecast(market, history ?? historyOf(market.id), now);
    if (fc) forecastMemo.set(market.id, fc);
    return fc;
  }

  const currentMarkets = () => state.markets.map(marketWithChange);

  function computeShots(opts = {}) {
    const shots = buildShots(currentMarkets(), { history: historyOf, forecast: forecastFor, now: Date.now(), limit: 20, ...opts });
    for (const sh of shots) enrich(sh, sh.market);
    return shots;
  }

  function handleInsight(ins) {
    try {
      const market = state.marketById.get(ins.marketIds?.[0]);
      enrich(ins, market);
      store.addInsight?.(ins);
      broadcast('insight', ins);
      if (severityRank(ins.severity) >= severityRank('notable')) {
        const subs = store.listSubscriptions();
        const ids = matchInsightSubscriptions(ins, subs, state.marketById);
        if (ids.length) deliverTo(ins, market, subs.filter((s) => ids.includes(s.id)));
      }
      logger.log(`[insight] ${formatInsight(ins)}`);
    } catch (err) {
      logger.warn('[insight] pipeline error:', err?.message || err);
    }
  }

  function runRecommender(spikes, now) {
    forecastMemo = new Map();
    const markets = currentMarkets();
    try {
      const fresh = insightEngine.update(markets, { history: historyOf, spikes, now });
      const { created } = storyEngine.update(markets, { history: historyOf, now });
      for (const st of created) {
        const ins = insightEngine.add(storyInsight(st, now), now);
        if (ins) fresh.push(ins);
      }
      for (const ins of fresh) handleInsight(ins);
    } catch (err) {
      logger.warn('[insights] update failed:', err?.message || err);
    }
    try {
      state.shots = computeShots();
      state.shotsAt = now;
      broadcast('shots', state.shots);
    } catch (err) {
      logger.warn('[shots] build failed:', err?.message || err);
    }
  }

  async function runBackfill() {
    if (!backfill || state.backfill.status !== 'pending' || !state.markets.length) return;
    state.backfill = { status: 'running', startedAt: new Date().toISOString() };
    try {
      const stats = await backfill(state.markets, detector, (msg) => logger.log(msg));
      state.backfill = { status: 'done', ...stats, finishedAt: new Date().toISOString() };
      logger.log(`[backfill] seeded ${stats?.polymarket ?? 0} Polymarket + ${stats?.kalshi ?? 0} Kalshi markets (${stats?.points ?? 0} points) in ${Math.round((stats?.ms ?? 0) / 1000)}s`);
      recomputeChange1h();
      forecastMemo = new Map();
      state.shots = computeShots();
      broadcast('shots', state.shots);
    } catch (err) {
      state.backfill = { status: 'failed', error: err?.message || String(err) };
      logger.warn('[backfill] failed:', err?.message || err);
    }
  }

  function recomputeChange1h() {
    state.change1h.clear();
    try {
      const movers = detector.topMovers(Math.max(state.markets.length, 1)) || [];
      for (const m of movers) {
        const id = m?.market?.id;
        if (id && Number.isFinite(m.change1h)) state.change1h.set(id, m.change1h);
      }
    } catch (err) {
      logger.warn('[poll] topMovers failed:', err?.message || err);
    }
  }

  function updateSourceHealth(markets, error) {
    const counts = Object.fromEntries(KNOWN_SOURCES.map((s) => [s, 0]));
    for (const m of markets) counts[m.source] = (counts[m.source] || 0) + 1;
    for (const s of Object.keys(counts)) {
      const count = counts[s];
      const reported = sourceStatus?.[s]?.error;
      state.sources[s] = error
        ? { ok: false, count: 0, error }
        : sourceStatus?.[s]?.stale
          ? { ok: false, stale: true, count, error: reported }
          : { ok: count > 0, count, error: count > 0 ? null : reported || 'no markets returned' };
    }
  }

  async function pollOnce() {
    if (polling) return;
    polling = true;
    const now = Date.now();
    try {
      let markets = [];
      let fetchError = null;
      try {
        markets = await fetchAllMarkets({ limit: marketLimit });
        if (!Array.isArray(markets)) markets = [];
      } catch (err) {
        fetchError = err?.message || String(err);
        logger.warn('[poll] fetchAllMarkets failed:', fetchError);
      }
      updateSourceHealth(markets, fetchError);
      if (stopped) return;

      if (markets.length) {
        state.markets = markets;
        state.marketById = new Map(markets.map((m) => [m.id, m]));
      }

      let spikes = [];
      try {
        spikes = (markets.length ? detector.ingest(markets, now) : []) || [];
      } catch (err) {
        logger.warn('[poll] detector.ingest failed:', err?.message || err);
      }
      recomputeChange1h();

      state.lastPollAt = new Date(now).toISOString();
      state.polls++;

      broadcast('tick', { at: state.lastPollAt, marketCount: state.markets.length });

      try {
        const vix = detector.volatilityIndex();
        if (vix && Number.isFinite(vix.overall)) {
          state.vixHistory.push({ t: now, overall: vix.overall });
          const cutoff = now - VIX_HISTORY_MS;
          while (state.vixHistory.length && state.vixHistory[0].t < cutoff) state.vixHistory.shift();
        }
        broadcast('vix', vix);
      } catch (err) {
        logger.warn('[poll] volatilityIndex failed:', err?.message || err);
      }

      try {
        // Live context for markets we're about to alert on / recommend (bounded wait).
        const ids = new Set([...spikes.map((s) => s.marketId), ...state.shots.map((x) => x.marketId)]);
        await prefetchContext([...ids].map((id) => state.marketById.get(id)).filter(Boolean));
      } catch {}
      for (const s of spikes) handleSpike(s);
      runRecommender(spikes, now);
    } catch (err) {
      logger.warn('[poll] unexpected error:', err?.message || err);
    } finally {
      polling = false;
    }
  }

  function scheduleNext() {
    if (stopped) return;
    pollTimer = setTimeout(async () => {
      await pollOnce();
      scheduleNext();
    }, pollMs);
  }

  // ---------- helpers ----------
  function marketWithChange(m) {
    const c = state.change1h.get(m.id);
    return c === undefined ? m : { ...m, change1h: c };
  }

  function buildDemoSpike(body) {
    let market;
    if (body?.marketId) {
      market = state.marketById.get(String(body.marketId));
      if (!market) throw new HttpError(404, `unknown marketId "${body.marketId}"`);
    } else {
      const pool = state.markets
        .filter((m) => Number.isFinite(m.probability) && m.probability > 0.03 && m.probability < 0.97)
        .sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
        .slice(0, 25);
      const candidates = pool.length ? pool : state.markets.slice(0, 25);
      if (!candidates.length) throw new HttpError(503, 'no markets loaded yet; wait for the first poll');
      market = candidates[Math.floor(Math.random() * candidates.length)];
    }
    const from = clamp(Number(market.probability) || 0.5, 0.01, 0.99);
    const mag = 0.06 + Math.random() * 0.16;
    let dir = Math.random() < 0.5 ? -1 : 1;
    if (from + dir * mag > 0.99 || from + dir * mag < 0.01) dir = -dir;
    const to = Math.round(clamp(from + dir * mag, 0.01, 0.99) * 1000) / 1000;
    const windowMs = (2 + Math.floor(Math.random() * 5)) * 60_000;
    const make = typeof makeSpike === 'function' ? makeSpike : localMakeSpike;
    const spike = make(market, from, to, windowMs, { demo: true, zScore: Math.round((3 + Math.random() * 3) * 10) / 10 });
    return { ...spike, demo: true };
  }

  // ---------- static ----------
  async function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'bad path');
    }
    if (rel.includes('\0')) throw new HttpError(400, 'bad path');
    if (rel.endsWith('/')) rel += 'index.html';
    const root = resolve(publicDir);
    const file = resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(403, 'forbidden');
    let st;
    try {
      st = await stat(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    let target = file;
    if (st.isDirectory()) {
      target = join(file, 'index.html');
      try {
        await stat(target);
      } catch {
        throw new HttpError(404, 'not found');
      }
    }
    const data = await readFile(target);
    const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': data.length,
      'cache-control': extname(target) === '.html' ? 'no-cache' : 'public, max-age=60',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  // ---------- routes ----------
  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname, searchParams: q } = url;
    const method = req.method;

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (!pathname.startsWith('/api/') && pathname !== '/api') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return serveStatic(req, res, pathname);
    }

    const parts = pathname.split('/').filter(Boolean).slice(1); // drop "api"
    const [a, b, c] = parts;

    if (method === 'GET' && a === 'health' && parts.length === 1) {
      return sendJSON(res, 200, {
        ok: Object.values(state.sources).some((s) => s.ok),
        lastPollAt: state.lastPollAt,
        marketCount: state.markets.length,
        sources: state.sources,
        clients: clients.size,
        subscriptions: store.listSubscriptions().length,
        backfill: state.backfill,
        forecaster: forecast === heuristicForecast ? 'heuristic' : 'ml',
        context: Boolean(getLiveContext),
        agent: rec ? { available: Boolean(rec.available), model: rec.model || null, ...(rec.stats?.() || {}) } : { available: false, loaded: false },
      });
    }

    if (method === 'GET' && a === 'markets' && parts.length === 1) {
      const term = (q.get('q') || '').trim().toLowerCase();
      const category = (q.get('category') || '').trim().toLowerCase();
      const source = (q.get('source') || '').trim().toLowerCase();
      const limit = intParam(q.get('limit'), 50, 1, 1000);
      let list = state.markets;
      if (category) list = list.filter((m) => m.category === category);
      if (source) list = list.filter((m) => m.source === source);
      if (term) {
        list = list.filter(
          (m) =>
            String(m.title || '').toLowerCase().includes(term) ||
            String(m.outcome || '').toLowerCase().includes(term) ||
            (m.tags || []).some((t) => String(t).toLowerCase().includes(term)) ||
            String(m.id).toLowerCase() === term,
        );
      }
      list = [...list].sort((x, y) => (y.volume24h || 0) - (x.volume24h || 0)).slice(0, limit);
      return sendJSON(res, 200, list.map(marketWithChange));
    }

    if (method === 'GET' && a === 'markets' && c === 'history' && parts.length === 3) {
      let id;
      try {
        id = decodeURIComponent(b);
      } catch {
        throw new HttpError(400, 'bad market id');
      }
      let points = [];
      try {
        points = detector.history(id) || [];
      } catch {}
      if (!points.length && !state.marketById.has(id)) throw new HttpError(404, `unknown market "${id}"`);
      return sendJSON(res, 200, { marketId: id, points });
    }

    if (method === 'GET' && a === 'markets' && c === 'forecast' && parts.length === 3) {
      let id;
      try {
        id = decodeURIComponent(b);
      } catch {
        throw new HttpError(400, 'bad market id');
      }
      const market = state.marketById.get(id);
      if (!market) throw new HttpError(404, `unknown market "${id}"`);
      const fc = forecastFor(marketWithChange(market), historyOf(id), Date.now());
      if (!fc) throw new HttpError(503, 'forecast unavailable');
      return sendJSON(res, 200, { marketId: id, ...fc });
    }

    if (method === 'GET' && a === 'markets' && (c === 'context' || c === 'recommendation') && parts.length === 3) {
      let id;
      try {
        id = decodeURIComponent(b);
      } catch {
        throw new HttpError(400, 'bad market id');
      }
      const market0 = state.marketById.get(id);
      if (!market0) throw new HttpError(404, `unknown market "${id}"`);
      const market = marketWithChange(market0);
      if (c === 'context') {
        const context = wantsContext(market) ? await Promise.race([refreshContext(market), new Promise((r) => setTimeout(() => r(contextNow(market)), 5000).unref?.())]) : null;
        return sendJSON(res, 200, { marketId: id, context: context || null });
      }
      if (!rec) throw new HttpError(503, 'recommendations unavailable (server/agent not loaded)');
      const role = ROLES.includes(q.get('role')) ? q.get('role') : 'general';
      if (wantsContext(market)) await Promise.race([refreshContext(market), new Promise((r) => setTimeout(r, 3000).unref?.())]);
      // Latest thing we said about this market: a recent spike, else its shot, else the bare market.
      const recentSpike = store.listAlerts(500).find((x) => x.marketId === id && Date.now() - Date.parse(x.detectedAt) < 30 * 60_000);
      const target = recentSpike || state.shots.find((x) => x.marketId === id) || { id: `market:${id}`, marketId: id, market, title: market.title };
      const ctx = recContext(market);
      const recommendation = await rec.recommend(target, { ...ctx, role }, { force: true });
      if (recommendation?.source === 'claude' && target.id) rememberUpgrade(target.id, role, recommendation);
      return sendJSON(res, 200, { marketId: id, targetId: target.id || null, role, recommendation, context: ctx.context || null });
    }

    if (method === 'GET' && a === 'shots' && parts.length === 1) {
      const persona = (q.get('persona') || 'general').trim().toLowerCase();
      const category = (q.get('category') || '').trim().toLowerCase();
      const limit = intParam(q.get('limit'), 20, 1, 100);
      if (persona === 'general' && !category && limit <= state.shots.length && Date.now() - state.shotsAt < pollMs * 2) {
        return sendJSON(res, 200, state.shots.slice(0, limit));
      }
      return sendJSON(res, 200, computeShots({ persona, category, limit }));
    }

    if (method === 'GET' && a === 'insights' && parts.length === 1) {
      const limit = intParam(q.get('limit'), 50, 1, 300);
      let list = insightEngine.list(300);
      const type = q.get('type');
      if (type) list = list.filter((i) => i.type === type);
      const minSev = q.get('severity');
      if (minSev) list = list.filter((i) => severityRank(i.severity) >= severityRank(minSev));
      return sendJSON(res, 200, list.slice(0, limit));
    }

    if (method === 'GET' && a === 'stories' && parts.length === 1) {
      return sendJSON(res, 200, storyEngine.list(Date.now()));
    }

    if (method === 'GET' && a === 'briefing' && parts.length === 1) {
      return sendJSON(res, 200, buildBriefing(currentMarkets(), {
        history: historyOf,
        spikes: store.listAlerts(500),
        insights: insightEngine.list(300),
        stories: storyEngine.list(Date.now()),
        now: Date.now(),
      }));
    }

    if (method === 'GET' && a === 'movers' && parts.length === 1) {
      const limit = intParam(q.get('limit'), 20, 1, 200);
      return sendJSON(res, 200, detector.topMovers(limit) || []);
    }

    if (method === 'GET' && a === 'vix' && parts.length === 1) {
      const vix = detector.volatilityIndex() || {};
      return sendJSON(res, 200, { ...vix, history: state.vixHistory });
    }

    if (method === 'GET' && a === 'alerts' && parts.length === 1) {
      const limit = intParam(q.get('limit'), 100, 1, 500);
      let list = store.listAlerts(500);
      const minSev = q.get('severity');
      if (minSev) list = list.filter((s) => severityRank(s.severity) >= severityRank(minSev));
      return sendJSON(res, 200, list.slice(0, limit));
    }

    if (a === 'subscriptions') {
      if (parts.length === 1 && method === 'GET') return sendJSON(res, 200, store.listSubscriptions());
      if (parts.length === 1 && method === 'POST') {
        const body = await readBody(req);
        const v = validateSubscription(body);
        if (!v.ok) throw new HttpError(400, 'invalid subscription', { errors: v.errors });
        return sendJSON(res, 201, await store.createSubscription(v.value));
      }
      if (parts.length >= 2) {
        let id;
        try {
          id = decodeURIComponent(b);
        } catch {
          throw new HttpError(400, 'bad id');
        }
        const existing = store.getSubscription(id);
        if (parts.length === 2 && method === 'GET') {
          if (!existing) throw new HttpError(404, 'subscription not found');
          return sendJSON(res, 200, existing);
        }
        if (parts.length === 2 && method === 'PUT') {
          if (!existing) throw new HttpError(404, 'subscription not found');
          const body = await readBody(req);
          const v = validateSubscription(body, existing);
          if (!v.ok) throw new HttpError(400, 'invalid subscription', { errors: v.errors });
          return sendJSON(res, 200, await store.updateSubscription(id, v.value));
        }
        if (parts.length === 2 && method === 'DELETE') {
          if (!(await store.deleteSubscription(id))) throw new HttpError(404, 'subscription not found');
          return sendJSON(res, 200, { ok: true, id });
        }
        if (parts.length === 3 && c === 'test' && method === 'POST') {
          if (!existing) throw new HttpError(404, 'subscription not found');
          if (!existing.webhook?.url) return sendJSON(res, 400, { ok: false, error: 'subscription has no webhook configured' });
          const r = await deliver(existing.webhook, sampleSpike(), existing);
          return sendJSON(res, 200, r.ok ? { ok: true } : { ok: false, error: r.error });
        }
      }
      if (['GET', 'POST', 'PUT', 'DELETE'].includes(method) && parts.length <= 3) throw new HttpError(405, 'method not allowed');
    }

    if (method === 'GET' && a === 'stream' && parts.length === 1) {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      req.socket.setKeepAlive(true);
      res.writeHead(200, {
        ...CORS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      // Initial state so the UI isn't blank until the next tick.
      if (state.lastPollAt) sseWrite(res, 'tick', { at: state.lastPollAt, marketCount: state.markets.length });
      try {
        sseWrite(res, 'vix', detector.volatilityIndex());
      } catch {}
      if (state.shots.length) sseWrite(res, 'shots', state.shots);
      const cleanup = () => clients.delete(res);
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }

    if (method === 'POST' && a === 'demo' && b === 'spike' && parts.length === 2) {
      const body = await readBody(req);
      const spike = handleSpike(buildDemoSpike(body));
      if (!spike) throw new HttpError(500, 'failed to process demo spike');
      return sendJSON(res, 201, spike);
    }

    throw new HttpError(404, `no route for ${method} ${pathname}`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) logger.error('[http] error:', err);
      if (res.headersSent) {
        res.end();
        return;
      }
      if (req.url.startsWith('/api')) {
        sendJSON(res, status, { error: status === 500 ? 'internal error' : err.message, ...(err.extra || {}) });
      } else {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(status === 404 ? 'Not found' : err.message);
      }
    }
  });
  server.keepAliveTimeout = 65_000;

  async function start(port = 4317, host) {
    await store.load();
    insightEngine.restore(store.listInsights?.(300) || []);
    await new Promise((r, j) => {
      server.once('error', j);
      server.listen(port, host, r);
    });
    startPing();
    // First poll immediately (don't block startup on it).
    pollOnce().finally(() => {
      scheduleNext();
      runBackfill(); // non-blocking: shots/forecasts get ~6h of history within a minute
    });
    return server.address();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(pollTimer);
    clearInterval(pingTimer);
    for (const res of clients) {
      try {
        res.end();
      } catch {}
    }
    clients.clear();
    await new Promise((r) => {
      server.close(() => r());
      server.closeIdleConnections?.();
      setTimeout(() => {
        server.closeAllConnections?.();
        r();
      }, 2000).unref();
    });
    await store.close();
  }

  return { server, start, stop, pollOnce, handleSpike, handleInsight, runBackfill, state, detector, store, clients, insightEngine, storyEngine, recommender: rec };
}

async function main() {
  const [sources, engine, ml, fcMod, hist] = await Promise.all([
    import('./sources/index.js'),
    import('./engine/detector.js'),
    import('./ml/scorer.js').catch(() => null),
    import('./ml/forecaster.js').catch(() => null),
    import('./sources/history.js'),
  ]);
  const [ctxMod, agentMod] = await Promise.all([
    import('./context/index.js').catch(() => null),
    import('./agent/index.js').catch((err) => {
      console.warn('[agent] not loaded:', err?.message || err);
      return null;
    }),
  ]);
  const getLiveContext = typeof ctxMod?.getLiveContext === 'function' ? ctxMod.getLiveContext : null;
  console.log(getLiveContext ? '[context] live context enabled (ESPN / Coinbase)' : '[context] no context module; running without live game/asset context');
  let forecastFn = heuristicForecast;
  try {
    const fm = fcMod?.loadForecaster?.();
    if (fcMod?.forecastMove) {
      forecastFn = (m, h, now) => fcMod.forecastMove(m, h, now) || heuristicForecast(m, h, now);
      console.log(fm ? `[ml] moment forecaster loaded (${fm.meta?.model || fm.model || 'xgboost-forecast'})` : '[ml] forecaster module loaded (no trained model; using its heuristic)');
    } else console.log('[ml] no forecaster module; using built-in heuristic forecasts');
  } catch (err) {
    console.warn('[ml] forecaster failed to load:', err?.message || err);
  }
  const mlModel = ml?.loadModel?.();
  console.log(mlModel ? `[ml] spike classifier loaded (${mlModel.meta?.model || mlModel.model || 'xgboost'})` : '[ml] no model loaded; spikes will be unscored');
  const port = Number(process.env.PORT) || 4317;
  const pollMs = Number(process.env.POLL_MS) || 20000;
  const app = createApp({
    fetchAllMarkets: sources.fetchAllMarkets,
    Detector: engine.Detector,
    makeSpike: engine.makeSpike,
    sourceStatus: sources.sourceStatus,
    scoreSpike: mlModel ? ml.scoreSpike : null,
    forecast: forecastFn,
    getLiveContext,
    createRecommender: agentMod?.createRecommender ? (opts) => agentMod.createRecommender(opts) : null,
    backfill: process.env.BACKFILL === '0' ? null : (markets, detector, log) =>
      hist.backfillHistory(markets, detector, { polymarket: 80, kalshi: 30, hours: 6, concurrency: 4, log }),
    store: new Store({ dir: process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : undefined }),
    pollMs,
  });
  await app.start(port, process.env.HOST);
  console.log(app.recommender ? `[agent] recommendations: ${app.recommender.available ? `rules + Claude (${app.recommender.model})` : 'rules only (no Anthropic credentials or OD_AGENT=rules)'}` : '[agent] recommendations disabled');
  console.log(`Tipoff — the odds move before the headlines do.`);
  console.log(`Listening on http://localhost:${port}  (polling every ${Math.round(pollMs / 1000)}s)`);

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return process.exit(1);
    shuttingDown = true;
    console.log(`\n${sig} received, shutting down...`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    try {
      await app.stop();
    } catch (err) {
      console.error('shutdown error:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error('Failed to start Tipoff:', err);
    process.exit(1);
  });
}
