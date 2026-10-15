// Spike detection + Event Volatility Index.
//
// - Keeps a rolling {t, p} price history per market (pruned to historyWindowMs).
// - A spike fires when, within `spikeWindowMs`, the probability moved by at least
//   `minDelta` (absolute), OR the latest tick-to-tick return is an outlier
//   (|z| >= zThreshold) versus that market's own rolling return stdev.
// - Per-market cooldown; a bigger (higher-severity) move may break through it.
// - Volatility index: per-market realized volatility over `vixWindowMs`, mapped
//   to 0..100, volume-weighted per category and overall, EMA-smoothed.

// Web Crypto: available in Node >= 19 and in browsers, so this module runs in both.
const randomUUID = () => globalThis.crypto.randomUUID();

export const CATEGORIES = ['sports', 'politics', 'crypto', 'economics', 'entertainment', 'weather', 'tech', 'other'];
const SEVERITY_RANK = { info: 0, notable: 1, major: 2 };

export const DEFAULTS = Object.freeze({
  historyWindowMs: 6 * 3600_000,
  minPoints: 3, // need this many points before a market can spike (cold start => no spikes)
  spikeWindowMs: 10 * 60_000,
  minDelta: 0.05, // absolute move (probability units) that fires a spike by itself
  zThreshold: 4, // z-score of the latest return that fires a spike...
  zMinDelta: 0.02, // ...provided the move is at least this big (filters penny noise)
  minReturnsForZ: 8, // returns needed before the z-score criterion is trusted
  sigmaFloor: 0.004, // stdev floor so flat markets don't produce infinite z
  defaultSigma: 0.01, // assumed per-tick stdev when there's too little history
  cooldownMs: 10 * 60_000,
  vixWindowMs: 30 * 60_000,
  vixScale: 0.03, // hourly realized vol (prob units) that maps to ~63 on the 0..100 scale
  vixAlpha: 0.3, // EMA smoothing factor per tick
  staleMs: 10 * 60_000, // markets not seen for this long are excluded from movers/VIX
  majorDelta: 0.15,
  notableDelta: 0.08,
  // Volatility spikes: short-window realized vol vs the market's own baseline.
  volShortMs: 5 * 60_000,
  volBaseMinMs: 60 * 60_000, // need ≥ 1h of baseline history (up to the 6h window)
  volRatio: 3, // fire when short vol ≥ 3× baseline
  volMinShortReturns: 6,
  volMinBaseReturns: 30,
  volBaseFloor: 0.002, // per-√min floor so dead-flat markets don't give infinite ratios
  volMinShort: 0.008, // short vol must also be big in absolute terms (≈ 0.8 pt per √min)
  volMinRange: 0.03, // and the price must have actually travelled ≥ 3 pts within the short window
});

/** Severity from absolute delta (probability units) and |z|. */
export function classifySeverity(absDelta, absZ = 0) {
  const d = Math.abs(absDelta);
  const z = Math.abs(Number.isFinite(absZ) ? absZ : 0);
  if (d >= DEFAULTS.majorDelta || (d >= DEFAULTS.notableDelta && z >= 6)) return 'major';
  if (d >= DEFAULTS.notableDelta || (d >= 0.04 && z >= 4)) return 'notable';
  return 'info';
}

const round = (x, k = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** k) / 10 ** k : x);

/**
 * Build a contract-shaped Spike for a market. Usable for demo/synthetic spikes.
 * extra: { zScore?, severity?, now?, detectedAt?, ...anything else merged in (e.g. demo: true) }
 */
export function makeSpike(market, from, to, windowMs = 300_000, extra = {}) {
  const { zScore, severity, now, detectedAt, ...rest } = extra || {};
  const delta = round(to - from);
  const z = Number.isFinite(zScore) ? zScore : Math.abs(delta) / DEFAULTS.defaultSigma;
  return {
    id: randomUUID(),
    kind: 'price',
    marketId: market.id,
    title: market.title,
    source: market.source,
    category: market.category || 'other',
    tags: market.tags || [],
    url: market.url,
    outcome: market.outcome,
    from: round(from),
    to: round(to),
    delta,
    windowMs: Math.round(windowMs),
    zScore: round(z, 2),
    severity: severity || classifySeverity(delta, z),
    live: Boolean(market.live),
    detectedAt: detectedAt || new Date(now ?? Date.now()).toISOString(),
    ...rest,
  };
}

function stdev(xs) {
  if (xs.length < 2) return NaN;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export class Detector {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.series = new Map(); // id -> [{t, p}]
    this.markets = new Map(); // id -> latest Market
    this.lastSeen = new Map(); // id -> ms
    this.lastSpike = new Map(); // id -> { t, severity }
    this.seededUntil = new Map(); // id -> latest backfilled t (spikes never measure from seeded points)
    this.lastTickAt = 0;
    this.vix = { overall: 0, byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, 0])), updatedAt: null };
    this.vixInitialized = false;
  }

  /** Ingest a tick of normalized markets. Returns Spike[] newly detected. */
  ingest(markets, now = Date.now()) {
    const o = this.opts;
    const spikes = [];
    for (const m of markets || []) {
      if (!m || !m.id || !(m.probability >= 0 && m.probability <= 1)) continue;
      this.markets.set(m.id, m);
      this.lastSeen.set(m.id, now);
      let pts = this.series.get(m.id);
      if (!pts) this.series.set(m.id, (pts = []));
      const last = pts[pts.length - 1];
      if (last && now <= last.t) {
        last.p = m.probability; // same/older timestamp: overwrite rather than duplicate
      } else {
        pts.push({ t: now, p: m.probability });
      }
      const cutoff = now - o.historyWindowMs;
      let drop = 0;
      while (drop < pts.length - 1 && pts[drop].t < cutoff) drop++;
      if (drop) pts.splice(0, drop);

      const spike = this._detect(m, pts, now);
      if (spike) spikes.push(spike);
    }
    // Forget markets not seen for a whole history window.
    for (const [id, t] of this.lastSeen) {
      if (now - t > o.historyWindowMs) {
        this.lastSeen.delete(id);
        this.series.delete(id);
        this.markets.delete(id);
        this.lastSpike.delete(id);
        this.seededUntil.delete(id);
      }
    }
    this.lastTickAt = now;
    this._updateVix(now);
    return spikes;
  }

  /**
   * Merge backfilled history ([{t, p}], t in ms) for a market without firing spikes.
   * Points are validated, merged with live points (live wins on equal timestamps),
   * sorted, de-duplicated and pruned to the history window. Returns points stored.
   */
  seedHistory(marketId, points, now = this.lastTickAt || Date.now()) {
    if (!marketId || !Array.isArray(points) || !points.length) return (this.series.get(marketId) || []).length;
    const o = this.opts;
    const existing = this.series.get(marketId) || [];
    const prevSeeded = this.seededUntil.get(marketId) ?? -Infinity;
    // Seeds only fill the past before our first live tick; live data is never overwritten
    // or interleaved with a backfill that may use a slightly different price basis.
    const firstLive = existing.find((q) => q.t > prevSeeded)?.t ?? Infinity;
    const byT = new Map();
    let seedMax = -Infinity;
    for (const q of points) {
      const t = typeof q?.t === 'number' ? q.t : Date.parse(q?.t);
      const p = Number(q?.p);
      if (!Number.isFinite(t) || !(p >= 0 && p <= 1)) continue;
      if (t >= firstLive) continue;
      byT.set(t, p);
      if (t > seedMax) seedMax = t;
    }
    for (const q of existing) byT.set(q.t, q.p);
    const latest = Math.max(now, ...(byT.size ? [Math.max(...byT.keys())] : []));
    const cutoff = latest - o.historyWindowMs;
    const merged = [...byT].map(([t, p]) => ({ t, p })).filter((q) => q.t >= cutoff).sort((a, b) => a.t - b.t);
    if (!merged.length) return 0;
    this.series.set(marketId, merged);
    if (Number.isFinite(seedMax)) this.seededUntil.set(marketId, Math.max(this.seededUntil.get(marketId) || 0, seedMax));
    if (!this.lastSeen.has(marketId)) this.lastSeen.set(marketId, merged[merged.length - 1].t);
    return merged.length;
  }

  _returns(pts, upto = pts.length) {
    const r = [];
    for (let i = 1; i < upto; i++) r.push(pts[i].p - pts[i - 1].p);
    return r;
  }

  _detect(m, pts, now) {
    const o = this.opts;
    if (pts.length < o.minPoints) return null;
    const L = pts[pts.length - 1];

    // Largest move into the latest point from any point within the short window.
    // Backfilled points are never used as the "from" side: their price basis may differ
    // slightly from live quotes, which would otherwise fire false spikes after a backfill.
    const seededUntil = this.seededUntil.get(m.id) || -Infinity;
    let from = null;
    for (let i = pts.length - 2; i >= 0; i--) {
      const q = pts[i];
      if (L.t - q.t > o.spikeWindowMs) break;
      if (q.t <= seededUntil) break;
      if (!from || Math.abs(L.p - q.p) > Math.abs(L.p - from.p)) from = q;
    }
    if (!from) return null;

    // z-score of the latest return vs prior returns of this market.
    const prior = this._returns(pts, pts.length - 1);
    const sigmaRaw = stdev(prior);
    const haveSigma = prior.length >= o.minReturnsForZ && Number.isFinite(sigmaRaw);
    const sigma = Math.max(haveSigma ? sigmaRaw : o.defaultSigma, o.sigmaFloor);
    const lastRet = L.p - pts[pts.length - 2].p;
    const zLast = lastRet / sigma;

    const absMove = Math.abs(L.p - from.p);
    const absFire = absMove >= o.minDelta - 1e-9;
    const zFire = pts[pts.length - 2].t > seededUntil && haveSigma && Math.abs(zLast) >= o.zThreshold && Math.abs(lastRet) >= o.zMinDelta - 1e-9;
    if (!absFire && !zFire) return this._detectVol(m, pts, now, seededUntil);

    let f, windowMs, z;
    if (absFire) {
      f = from;
      windowMs = L.t - from.t;
      const steps = Math.max(1, pts.filter((q) => q.t > from.t && q.t <= L.t).length);
      z = (L.p - from.p) / (sigma * Math.sqrt(steps));
    } else {
      f = pts[pts.length - 2];
      windowMs = L.t - f.t;
      z = zLast;
    }
    const delta = L.p - f.p;
    // Only let z influence severity when it's backed by real history.
    const severity = classifySeverity(delta, haveSigma ? z : 0);

    const prev = this.lastSpike.get(m.id);
    if (prev && now - prev.t < o.cooldownMs && SEVERITY_RANK[severity] <= SEVERITY_RANK[prev.severity]) return null;
    this.lastSpike.set(m.id, { t: now, severity });
    return makeSpike(m, f.p, L.p, windowMs, { zScore: z, severity, now });
  }

  /** Per-√minute realized vol of returns among points in (t0, t1]; {vol, n}. */
  _volBetween(pts, t0, t1) {
    let sumSq = 0;
    let n = 0;
    let first = null;
    let last = null;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i - 1].t < t0 || pts[i].t > t1) continue;
      sumSq += (pts[i].p - pts[i - 1].p) ** 2;
      n++;
      if (first === null) first = pts[i - 1].t;
      last = pts[i].t;
    }
    if (!n) return { vol: NaN, n: 0 };
    const spanMin = Math.max((last - first) / 60_000, 1 / 3);
    return { vol: Math.sqrt(sumSq / spanMin), n };
  }

  /** Volatility spike: the market just started thrashing, whether or not it has picked a direction. */
  _detectVol(m, pts, now, seededUntil = -Infinity) {
    const o = this.opts;
    const L = pts[pts.length - 1];
    const shortStart = L.t - o.volShortMs;
    // The short window must be all live ticks (never measure against backfilled points).
    if (shortStart <= seededUntil && pts.some((q) => q.t >= shortStart && q.t <= seededUntil)) return null;
    const short = this._volBetween(pts, shortStart, L.t);
    if (short.n < o.volMinShortReturns || !(short.vol >= o.volMinShort)) return null;
    const baseStart = Math.max(pts[0].t, L.t - o.historyWindowMs);
    if (shortStart - baseStart < o.volBaseMinMs) return null;
    const base = this._volBetween(pts, baseStart, shortStart);
    if (base.n < o.volMinBaseReturns || !Number.isFinite(base.vol)) return null;
    const volBase = Math.max(base.vol, o.volBaseFloor);
    const ratio = short.vol / volBase;
    if (ratio < o.volRatio) return null;
    let lo = Infinity;
    let hi = -Infinity;
    let first = null;
    for (const q of pts) {
      if (q.t < shortStart) continue;
      if (!first) first = q;
      lo = Math.min(lo, q.p);
      hi = Math.max(hi, q.p);
    }
    if (hi - lo < o.volMinRange) return null;
    const range = hi - lo;
    const severity = ratio >= 8 && range >= 0.1 ? 'major' : ratio >= 5 && range >= 0.06 ? 'notable' : 'info';
    const prev = this.lastSpike.get(m.id);
    if (prev && now - prev.t < o.cooldownMs && SEVERITY_RANK[severity] <= SEVERITY_RANK[prev.severity]) return null;
    this.lastSpike.set(m.id, { t: now, severity });
    return makeSpike(m, first.p, L.p, L.t - first.t, {
      kind: 'volatility',
      zScore: round(ratio, 2),
      severity,
      now,
      volRatio: round(ratio, 2),
      volShort: round(short.vol, 4),
      volBase: round(volBase, 4),
      range: round(range, 4),
    });
  }

  /** Realized hourly vol (prob units) for a market over the VIX window, or NaN. */
  _realizedVol(id, now) {
    const pts = this.series.get(id) || [];
    const start = now - this.opts.vixWindowMs;
    let sumSq = 0;
    let n = 0;
    let firstT = null;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i - 1].t < start) continue;
      if (firstT === null) firstT = pts[i - 1].t;
      sumSq += (pts[i].p - pts[i - 1].p) ** 2;
      n++;
    }
    if (n < 2) return NaN;
    const spanMs = Math.max(pts[pts.length - 1].t - firstT, 1);
    return Math.sqrt((sumSq * 3600_000) / spanMs);
  }

  _marketVol(id, now) {
    const v = this._realizedVol(id, now);
    const c = this.markets.get(id)?.change1h;
    // Cold-start seed: a 1h move is a rough proxy for hourly volatility.
    const seed = Number.isFinite(c) ? Math.abs(c) * 0.7 : NaN;
    if (!Number.isFinite(v)) return seed;
    if (!Number.isFinite(seed)) return v;
    // Blend from seed to observed vol as our own history covers the VIX window.
    const pts = this.series.get(id);
    const w = Math.min(1, (pts[pts.length - 1].t - pts[0].t) / this.opts.vixWindowMs);
    return w * v + (1 - w) * seed;
  }

  _toIndex(vol) {
    return 100 * (1 - Math.exp(-vol / this.opts.vixScale));
  }

  _updateVix(now) {
    const o = this.opts;
    const acc = Object.fromEntries(CATEGORIES.map((c) => [c, { w: 0, s: 0 }]));
    const all = { w: 0, s: 0 };
    for (const [id, m] of this.markets) {
      if (now - (this.lastSeen.get(id) || 0) > o.staleMs) continue;
      const vol = this._marketVol(id, now);
      if (!Number.isFinite(vol)) continue;
      const w = Math.sqrt(Math.max(0, m.volume24h || 0)) + 1;
      const idx = this._toIndex(vol);
      const cat = acc[m.category] ? m.category : 'other';
      acc[cat].w += w;
      acc[cat].s += w * idx;
      all.w += w;
      all.s += w * idx;
    }
    const a = this.vixInitialized ? o.vixAlpha : 1;
    const ema = (prev, raw) => Math.min(100, Math.max(0, a * raw + (1 - a) * prev));
    const byCategory = {};
    for (const c of CATEGORIES) {
      const raw = acc[c].w ? acc[c].s / acc[c].w : 0;
      byCategory[c] = round(ema(this.vix.byCategory[c] || 0, raw), 1);
    }
    const rawAll = all.w ? all.s / all.w : 0;
    this.vix = { overall: round(ema(this.vix.overall, rawAll), 1), byCategory, updatedAt: new Date(now).toISOString() };
    this.vixInitialized = true;
  }

  /** [{t, p}] for sparklines (copy). */
  history(marketId) {
    return (this.series.get(marketId) || []).map((q) => ({ t: q.t, p: q.p }));
  }

  /** { overall, byCategory: {...}, updatedAt } — 0..100. */
  volatilityIndex() {
    return { overall: this.vix.overall, byCategory: { ...this.vix.byCategory }, updatedAt: this.vix.updatedAt };
  }

  _changeOver(pts, ms, now) {
    if (pts.length < 2) return null;
    const L = pts[pts.length - 1];
    const target = now - ms;
    // Earliest point at or after target (or the closest one before it).
    let ref = null;
    for (const q of pts) {
      if (q.t <= target) ref = q;
      else {
        if (!ref) ref = q;
        break;
      }
    }
    if (!ref || ref === L) return null;
    return { change: L.p - ref.p, covered: L.t - ref.t };
  }

  /** Latest change1h for a market: history if it covers ~1h, else Polymarket seed, else partial history. */
  change1h(marketId, now = this.lastTickAt || Date.now()) {
    const pts = this.series.get(marketId) || [];
    const h = this._changeOver(pts, 3600_000, now);
    if (h && h.covered >= 55 * 60_000) return h.change;
    const seed = this.markets.get(marketId)?.change1h;
    if (Number.isFinite(seed)) return seed;
    return h ? h.change : 0;
  }

  /** [{market, change1h, change5m, vol}] sorted by |move| desc. */
  topMovers(n = 20) {
    const now = this.lastTickAt || Date.now();
    const out = [];
    for (const [id, m] of this.markets) {
      if (now - (this.lastSeen.get(id) || 0) > this.opts.staleMs) continue;
      const pts = this.series.get(id) || [];
      const change1h = round(this.change1h(id, now));
      const c5 = this._changeOver(pts, 5 * 60_000, now);
      const change5m = round(c5 ? c5.change : 0);
      const v = this._marketVol(id, now);
      const vol = Number.isFinite(v) ? round(this._toIndex(v), 1) : 0;
      out.push({ market: { ...m, change1h }, change1h, change5m, vol });
    }
    const score = (x) => Math.max(Math.abs(x.change1h), Math.abs(x.change5m) * 1.5);
    out.sort((a, b) => score(b) - score(a) || b.market.volume24h - a.market.volume24h);
    return out.slice(0, n);
  }
}
