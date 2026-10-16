// Oddshot browser mode: when there is no Oddshot server (e.g. GitHub Pages), run the
// same pipeline in the page. It answers app.js's /api/* fetches and /api/stream SSE
// with the shared server modules (detector, matcher, ML scorer, webhooks), polling
// Polymarket directly. Kalshi blocks cross-origin browser requests, so it needs the server.
//
// Modes:
//   ?api=https://your-oddshot-server   → send /api/* to a remote Oddshot server
//   ?standalone (or any *.github.io)   → run in the browser
//   otherwise                          → untouched; the page talks to its own server

const params = new URLSearchParams(location.search);
const remote = params.get('api');
const standalone = !remote && (params.has('standalone') || location.hostname.endsWith('github.io'));

// Where the shared server modules live relative to this file. scripts/build-pages.mjs
// rewrites this line when it flattens public/ to the site root.
const SERVER_BASE = '../server/';

const isApi = (u) => typeof u === 'string' && u.startsWith('/api/');
const nativeFetch = window.fetch.bind(window);
const NativeEventSource = window.EventSource;

if (remote) {
  const base = remote.replace(/\/+$/, '');
  window.fetch = (input, init) => nativeFetch(isApi(input) ? base + input : input, init);
  window.EventSource = class extends NativeEventSource {
    constructor(url, cfg) { super(isApi(url) ? base + url : url, cfg); }
  };
} else if (standalone) {
  installStandalone();
}

function installStandalone() {
  const POLL_MS = 20000;
  const VIX_HISTORY_MS = 6 * 3600 * 1000;
  const ALERTS_MAX = 200;
  const KALSHI_NOTE = 'needs the Oddshot server (Kalshi blocks browser requests)';
  const mod = (p) => import(new URL(SERVER_BASE + p, import.meta.url).href);

  const state = {
    markets: [], byId: new Map(), lastPollAt: null, vixHistory: [],
    sources: {
      polymarket: { ok: false, count: 0, error: 'not polled yet' },
      kalshi: { ok: false, count: 0, error: KALSHI_NOTE },
    },
  };
  const streams = new Set();
  const historyCache = new Map(); // marketId -> {at, points}

  const store = {
    load(k, d) { try { return JSON.parse(localStorage.getItem(`oddshot.${k}`)) ?? d; } catch { return d; } },
    save(k, v) { try { localStorage.setItem(`oddshot.${k}`, JSON.stringify(v)); } catch { /* quota */ } },
  };
  let subs = store.load('subs', []);
  let alerts = store.load('alerts', []);
  const INSIGHTS_MAX = 150; // localStorage-friendly; the engine keeps 300 in memory
  let shots = [];

  // Load the shared modules once; every handler awaits this.
  const ready = (async () => {
    const [engine, poly, match, notify, ml, insights, hist, fc] = await Promise.all([
      mod('engine/detector.js'),
      mod('sources/polymarket.js'),
      mod('match.js'),
      mod('notify.js'),
      mod('ml/scorer.js').catch(() => null),
      mod('insights/index.js'),
      mod('sources/history.js'),
      mod('ml/forecaster.js').catch(() => null),
    ]);
    // v3: rules-based recommendations (browser-safe) + live context (ESPN/Coinbase allow CORS).
    const [rules, contextMod] = await Promise.all([
      mod('agent/rules.js').catch(() => null),
      mod('context/index.js').catch(() => null),
    ]);
    let forecast = insights.heuristicForecast;
    if (fc?.forecastMove) {
      try {
        const res = await nativeFetch(new URL(SERVER_BASE + 'ml/forecaster.json', import.meta.url));
        if (res.ok) fc.setForecaster(await res.json());
      } catch { /* forecaster falls back to its heuristic */ }
      forecast = (m, h, now) => fc.forecastMove(m, h, now) || insights.heuristicForecast(m, h, now);
    }
    if (ml) {
      try {
        const res = await nativeFetch(new URL(SERVER_BASE + 'ml/model.json', import.meta.url));
        if (res.ok) ml.setModel(await res.json());
      } catch { /* run unscored */ }
    }
    const detector = new engine.Detector();
    const insightEngine = new insights.InsightEngine();
    insightEngine.restore(store.load('insights', []));
    const storyEngine = new insights.StoryEngine();
    const getLiveContext = typeof contextMod?.getLiveContext === 'function' ? contextMod.getLiveContext : null;
    return { engine, poly, match, notify, ml: ml?.loadModel() ? ml : null, detector, insights, hist, forecast, insightEngine, storyEngine, rules, getLiveContext };
  })();

  function emit(event, data) {
    for (const s of streams) s._dispatch(event, data);
  }

  async function handleSpike(spike) {
    const { match, notify, ml, detector } = await ready;
    if (ml && !spike.ml) {
      const market = state.byId.get(spike.marketId);
      const scored = market ? ml.scoreSpike(spike, market, detector.history(spike.marketId) || []) : null;
      if (scored) spike = { ...spike, ml: scored };
    }
    const matchedIds = match.matchSubscriptions(spike, subs);
    const enriched = enrich(await ready, { kind: 'price', ...spike, matchedSubscriptions: matchedIds }, state.byId.get(spike.marketId));
    alerts = [enriched, ...alerts].slice(0, ALERTS_MAX);
    store.save('alerts', alerts);
    emit('spike', enriched);
    if (matchedIds.length) notify.notifySubscriptions(enriched, subs.filter((s) => matchedIds.includes(s.id)));
    return enriched;
  }

  // ---------- live context + recommendations ----------
  const contextCache = new Map(); // id -> {at, value, inflight}
  const wantsContext = (r, m) => Boolean(r.getLiveContext && m && (m.category === 'sports' || m.category === 'crypto'));
  function refreshContext(r, m) {
    if (!wantsContext(r, m)) return Promise.resolve(null);
    const hit = contextCache.get(m.id);
    if (hit?.inflight) return hit.inflight;
    if (hit && Date.now() - hit.at < 15000) return Promise.resolve(hit.value);
    const inflight = Promise.resolve().then(() => r.getLiveContext(m)).catch(() => null).then((v) => {
      contextCache.set(m.id, { at: Date.now(), value: v || null });
      return v || null;
    });
    contextCache.set(m.id, { at: hit?.at || 0, value: hit?.value ?? null, inflight });
    return inflight;
  }
  function contextNow(r, m) {
    if (!wantsContext(r, m)) return null;
    const hit = contextCache.get(m.id);
    if (!hit || Date.now() - hit.at >= 15000) refreshContext(r, m);
    return hit?.value ?? null;
  }
  async function prefetchContext(r, markets, budget = 2000) {
    const list = markets.filter((m) => wantsContext(r, m)).slice(0, 30);
    if (list.length) await Promise.race([Promise.allSettled(list.map((m) => refreshContext(r, m))), new Promise((res) => setTimeout(res, budget))]);
  }
  function recCtx(r, market) {
    const history = r.detector.history(market.id) || [];
    const related = market.eventKey ? state.markets.filter((x) => x.eventKey === market.eventKey && x.id !== market.id).slice(0, 10) : [];
    return { market, history, context: contextNow(r, market), forecast: forecastFor(r, market), related };
  }
  function enrich(r, target, market) {
    if (!market) return target;
    const ctx = recCtx(r, market);
    if (ctx.context) target.context = ctx.context;
    if (r.rules) {
      try { target.recommendations = r.rules.recommendAllRoles(target, ctx); } catch { /* unscored */ }
    }
    return target;
  }

  // ---------- recommender (same modules as the server) ----------
  let forecastMemo = new Map();
  function historyOf(detector) {
    return (id) => detector.history(id) || [];
  }
  function forecastFor(r, market) {
    const hit = forecastMemo.get(market.id);
    if (hit) return hit;
    const h = r.detector.history(market.id) || [];
    let f = null;
    try { f = r.forecast(market, h, Date.now()); } catch { f = null; }
    f = f || r.insights.heuristicForecast(market, h, Date.now());
    if (f) forecastMemo.set(market.id, f);
    return f;
  }
  function marketsWithChange(detector) {
    return state.markets.map((m) => {
      const ch = detector.change1h?.(m.id);
      return Number.isFinite(ch) ? { ...m, change1h: ch } : m;
    });
  }
  function computeShots(r, opts = {}) {
    const list = r.insights.buildShots(marketsWithChange(r.detector), {
      history: historyOf(r.detector), forecast: (m) => forecastFor(r, m), now: Date.now(), limit: 20, ...opts,
    });
    for (const sh of list) enrich(r, sh, sh.market);
    return list;
  }
  function handleInsight(r, ins) {
    enrich(r, ins, state.byId.get(ins.marketIds?.[0]));
    store.save('insights', r.insightEngine.list(INSIGHTS_MAX));
    emit('insight', ins);
    if (r.match.severityRank(ins.severity) >= r.match.severityRank('notable')) {
      const ids = r.match.matchInsightSubscriptions(ins, subs, state.byId);
      if (ids.length) r.notify.notifySubscriptions(ins, subs.filter((s) => ids.includes(s.id)));
    }
  }
  function runRecommender(r, spikes, now) {
    forecastMemo = new Map();
    const markets = marketsWithChange(r.detector);
    try {
      const fresh = r.insightEngine.update(markets, { history: historyOf(r.detector), spikes, now });
      for (const st of r.storyEngine.update(markets, { history: historyOf(r.detector), now }).created) {
        const ins = r.insightEngine.add(r.insights.storyInsight(st, now), now);
        if (ins) fresh.push(ins);
      }
      for (const ins of fresh) handleInsight(r, ins);
    } catch (err) { console.warn('[oddshot] insights failed', err); }
    try {
      shots = computeShots(r);
      emit('shots', shots);
    } catch (err) { console.warn('[oddshot] shots failed', err); }
  }

  async function pollOnce() {
    const { poly, detector } = await ready;
    const now = Date.now();
    try {
      const markets = await poly.fetchPolymarket({ limit: 300 });
      state.markets = markets;
      state.byId = new Map(markets.map((m) => [m.id, m]));
      state.sources.polymarket = { ok: markets.length > 0, count: markets.length, error: markets.length ? null : 'no markets returned' };
    } catch (err) {
      // Keep the last good market set through a failed poll.
      state.sources.polymarket = { ok: false, stale: state.markets.length > 0, count: state.markets.length, error: String(err?.message || err) };
    }
    const spikes = state.markets.length ? detector.ingest(state.markets, now) || [] : [];
    state.lastPollAt = new Date(now).toISOString();
    emit('tick', { at: state.lastPollAt, marketCount: state.markets.length });
    const vix = detector.volatilityIndex();
    if (vix && Number.isFinite(vix.overall)) {
      state.vixHistory.push({ t: now, overall: vix.overall });
      while (state.vixHistory.length && state.vixHistory[0].t < now - VIX_HISTORY_MS) state.vixHistory.shift();
    }
    emit('vix', vix);
    const r = await ready;
    const ids = new Set([...spikes.map((x) => x.marketId), ...shots.map((x) => x.marketId)]);
    await prefetchContext(r, [...ids].map((id) => state.byId.get(id)).filter(Boolean));
    for (const s of spikes) await handleSpike(s);
    runRecommender(r, spikes, now);
  }

  const firstPoll = pollOnce();
  // Backfill ~6h of 1-min history for the top 30 markets so the Shot List isn't empty on load.
  const backfilled = firstPoll.then(async () => {
    const r = await ready;
    try {
      const stats = await r.hist.backfillHistory(state.markets, r.detector, { polymarket: 30, kalshi: 0, hours: 6, concurrency: 4 });
      console.info(`[oddshot] backfilled ${stats.polymarket} markets (${stats.points} points) in ${stats.ms} ms`);
      forecastMemo = new Map();
      shots = computeShots(r);
      emit('shots', shots);
    } catch (err) { console.warn('[oddshot] backfill failed', err); }
  });
  setInterval(pollOnce, POLL_MS);

  // Detector history is empty on a fresh page, so charts fall back to Polymarket's CLOB history.
  async function marketHistory(id) {
    const { detector } = await ready;
    const local = detector.history(id) || [];
    const market = state.byId.get(id);
    if (local.length >= 10 || !market?.tokenId) return local;
    const hit = historyCache.get(id);
    if (hit && Date.now() - hit.at < 60000) return hit.points;
    try {
      const u = `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(market.tokenId)}&interval=1d&fidelity=5`;
      const res = await nativeFetch(u, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const points = (data.history || []).map((x) => ({ t: x.t * 1000, p: x.p })).concat(local);
      historyCache.set(id, { at: Date.now(), points });
      return points;
    } catch {
      return local;
    }
  }

  class HttpError extends Error {
    constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
  }

  async function route(method, url, body) {
    const r = await ready;
    const { engine, match, notify, detector } = r;
    const q = url.searchParams;
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    const [a, b, c] = parts;
    const int = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.parseInt(v, 10) || d));
    const withChange = (m) => {
      const ch = detector.change1h?.(m.id);
      return Number.isFinite(ch) ? { ...m, change1h: ch } : m;
    };

    if (method === 'GET' && a === 'health') {
      if (!state.lastPollAt) await firstPoll;
      return {
        ok: Object.values(state.sources).some((s) => s.ok), mode: 'browser',
        context: Boolean(r.getLiveContext), agent: { available: false, rules: Boolean(r.rules) },
        lastPollAt: state.lastPollAt, marketCount: state.markets.length,
        sources: state.sources, clients: streams.size, subscriptions: subs.length,
      };
    }
    if (method === 'GET' && a === 'markets' && parts.length === 1) {
      if (!state.lastPollAt) await firstPoll;
      const term = (q.get('q') || '').trim().toLowerCase();
      const category = (q.get('category') || '').trim().toLowerCase();
      const source = (q.get('source') || '').trim().toLowerCase();
      let list = state.markets;
      if (category) list = list.filter((m) => m.category === category);
      if (source) list = list.filter((m) => m.source === source);
      if (term) {
        list = list.filter((m) => String(m.title || '').toLowerCase().includes(term)
          || String(m.outcome || '').toLowerCase().includes(term)
          || (m.tags || []).some((t) => String(t).toLowerCase().includes(term)));
      }
      return [...list].sort((x, y) => (y.volume24h || 0) - (x.volume24h || 0))
        .slice(0, int(q.get('limit'), 50, 1, 1000)).map(withChange);
    }
    if (method === 'GET' && a === 'markets' && c === 'forecast') {
      if (!state.lastPollAt) await firstPoll;
      const id = decodeURIComponent(b);
      const market = state.byId.get(id);
      if (!market) throw new HttpError(404, `unknown market "${id}"`);
      return { marketId: id, ...forecastFor(r, market) };
    }
    if (method === 'GET' && a === 'markets' && (c === 'context' || c === 'recommendation')) {
      if (!state.lastPollAt) await firstPoll;
      const id = decodeURIComponent(b);
      const market = state.byId.get(id);
      if (!market) throw new HttpError(404, `unknown market "${id}"`);
      const context = wantsContext(r, market) ? await Promise.race([refreshContext(r, market), new Promise((res) => setTimeout(() => res(contextNow(r, market)), 5000))]) : null;
      if (c === 'context') return { marketId: id, context: context || null };
      if (!r.rules) throw new HttpError(503, 'recommendations unavailable');
      const roles = ['photographer', 'trader', 'fan', 'journalist', 'general'];
      const role = roles.includes(q.get('role')) ? q.get('role') : 'general';
      const recent = alerts.find((x) => x.marketId === id && Date.now() - Date.parse(x.detectedAt) < 30 * 60000);
      const target = recent || shots.find((x) => x.marketId === id) || { id: `market:${id}`, marketId: id, market, title: market.title };
      const recommendation = r.rules.recommendRules(target, { ...recCtx(r, market), role });
      return { marketId: id, targetId: target.id || null, role, recommendation, context: context || null };
    }
    if (method === 'GET' && a === 'shots') {
      if (!state.lastPollAt) await firstPoll;
      if (!shots.length) await Promise.race([backfilled, new Promise((res) => setTimeout(res, 8000))]);
      const persona = (q.get('persona') || 'general').toLowerCase();
      const category = (q.get('category') || '').toLowerCase();
      const limit = int(q.get('limit'), 20, 1, 100);
      if (persona === 'general' && !category && limit <= shots.length) return shots.slice(0, limit);
      return computeShots(r, { persona, category, limit });
    }
    if (method === 'GET' && a === 'insights') {
      let list = r.insightEngine.list(300);
      if (q.get('type')) list = list.filter((i) => i.type === q.get('type'));
      if (q.get('severity')) list = list.filter((i) => match.severityRank(i.severity) >= match.severityRank(q.get('severity')));
      return list.slice(0, int(q.get('limit'), 50, 1, 300));
    }
    if (method === 'GET' && a === 'stories') return r.storyEngine.list(Date.now());
    if (method === 'GET' && a === 'briefing') {
      if (!state.lastPollAt) await firstPoll;
      return r.insights.buildBriefing(marketsWithChange(detector), {
        history: historyOf(detector), spikes: alerts, insights: r.insightEngine.list(300), stories: r.storyEngine.list(Date.now()), now: Date.now(),
      });
    }
    if (method === 'GET' && a === 'markets' && c === 'history') {
      const id = decodeURIComponent(b);
      return { marketId: id, points: await marketHistory(id) };
    }
    if (method === 'GET' && a === 'movers') {
      if (!state.lastPollAt) await firstPoll;
      return detector.topMovers(int(q.get('limit'), 20, 1, 200)) || [];
    }
    if (method === 'GET' && a === 'vix') return { ...detector.volatilityIndex(), history: state.vixHistory };
    if (method === 'GET' && a === 'alerts') {
      let list = alerts;
      const minSev = q.get('severity');
      if (minSev) list = list.filter((s) => match.severityRank(s.severity) >= match.severityRank(minSev));
      return list.slice(0, int(q.get('limit'), 100, 1, 500));
    }
    if (a === 'subscriptions') {
      if (parts.length === 1 && method === 'GET') return subs;
      if (parts.length === 1 && method === 'POST') {
        const v = match.validateSubscription(body);
        if (!v.ok) throw new HttpError(400, 'invalid subscription', { errors: v.errors });
        const sub = { ...v.value, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
        subs = [...subs, sub];
        store.save('subs', subs);
        return sub;
      }
      const id = decodeURIComponent(b || '');
      const existing = subs.find((s) => s.id === id);
      if (!existing) throw new HttpError(404, 'subscription not found');
      if (parts.length === 2 && method === 'GET') return existing;
      if (parts.length === 2 && method === 'PUT') {
        const v = match.validateSubscription(body, existing);
        if (!v.ok) throw new HttpError(400, 'invalid subscription', { errors: v.errors });
        const sub = { ...existing, ...v.value };
        subs = subs.map((s) => (s.id === id ? sub : s));
        store.save('subs', subs);
        return sub;
      }
      if (parts.length === 2 && method === 'DELETE') {
        subs = subs.filter((s) => s.id !== id);
        store.save('subs', subs);
        return { ok: true, id };
      }
      if (c === 'test' && method === 'POST') {
        if (!existing.webhook?.url) throw new HttpError(400, 'subscription has no webhook configured');
        const r = await notify.deliver(existing.webhook, notify.sampleSpike(), existing);
        return r.ok ? { ok: true } : { ok: false, error: `${r.error} (in browser mode only ntfy and Discord webhooks accept browser requests)` };
      }
    }
    if (method === 'POST' && a === 'demo' && b === 'spike') {
      if (!state.lastPollAt) await firstPoll;
      let market = body?.marketId ? state.byId.get(String(body.marketId)) : null;
      if (!market) {
        const pool = state.markets.filter((m) => m.probability > 0.03 && m.probability < 0.97)
          .sort((x, y) => (y.volume24h || 0) - (x.volume24h || 0)).slice(0, 25);
        if (!pool.length) throw new HttpError(503, 'no markets loaded yet; wait for the first poll');
        market = pool[Math.floor(Math.random() * pool.length)];
      }
      const from = Math.min(0.99, Math.max(0.01, market.probability));
      const mag = 0.06 + Math.random() * 0.16;
      let dir = Math.random() < 0.5 ? -1 : 1;
      if (from + dir * mag > 0.99 || from + dir * mag < 0.01) dir = -dir;
      const to = Math.round(Math.min(0.99, Math.max(0.01, from + dir * mag)) * 1000) / 1000;
      const windowMs = (2 + Math.floor(Math.random() * 5)) * 60000;
      const spike = engine.makeSpike(market, from, to, windowMs, { demo: true, zScore: Math.round((3 + Math.random() * 3) * 10) / 10 });
      return handleSpike({ ...spike, demo: true });
    }
    throw new HttpError(404, 'not found');
  }

  window.fetch = async (input, init = {}) => {
    if (!isApi(input)) return nativeFetch(input, init);
    const url = new URL(input, location.origin);
    const method = (init.method || 'GET').toUpperCase();
    let body;
    try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    try {
      return json(method === 'POST' && url.pathname === '/api/subscriptions' ? 201 : 200, await route(method, url, body));
    } catch (err) {
      return json(err.status || 500, { error: err.message, ...(err.extra || {}) });
    }
  };

  // In-page stand-in for EventSource('/api/stream').
  class LocalEventSource extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.onopen = this.onerror = this.onmessage = null;
      ready.then(async () => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        streams.add(this);
        this.onopen?.(new Event('open'));
        const { detector } = await ready;
        if (state.lastPollAt) this._dispatch('tick', { at: state.lastPollAt, marketCount: state.markets.length });
        this._dispatch('vix', detector.volatilityIndex());
        if (shots.length) this._dispatch('shots', shots);
      }, () => {
        this.readyState = 2;
        this.onerror?.(new Event('error'));
      });
    }
    _dispatch(type, data) {
      if (this.readyState !== 1) return;
      this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
    close() { this.readyState = 2; streams.delete(this); }
  }
  window.EventSource = function (url, cfg) {
    return isApi(url) ? new LocalEventSource(url) : new NativeEventSource(url, cfg);
  };
  Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
}
