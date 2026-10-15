// Oddshot spike scorer: pReal = probability that a detected spike is a REAL,
// sustained information event (vs. thin-book noise that reverts).
//
// Pure JS, zero deps. Evaluates the XGBoost model exported by ml/train.py
// (server/ml/model.json). Feature definitions mirror ml/features.py exactly;
// see server/ml/scorer.test.js for the parity test against Python.
//
//   import { loadModel, featuresFor, scoreSpike } from './ml/scorer.js';
//   const r = scoreSpike(spike, market, detector.history(spike.marketId));
//   // r = { pReal, label: 'event'|'likely'|'noise', drivers: [{feature, impact, value}], model, historyMinutes } | null
//
// history = [{t, p}] with t in ms epoch. Only points with t <= spike.detectedAt
// are used. Best results with >= 60 min (ideally 6h) of history before the move.

import { readFileSync } from 'node:fs';

const MODEL_URL = new URL('./model.json', import.meta.url);
const CATEGORIES = ['sports', 'politics', 'crypto', 'economics', 'entertainment', 'weather', 'tech', 'other'];

let cached = null;

/** Load (and cache) the model. Returns the model object or null if unavailable. */
export function loadModel(path) {
  try {
    if (cached && !path) return cached;
    const m = JSON.parse(readFileSync(path || MODEL_URL, 'utf8'));
    if (!m || !Array.isArray(m.trees) || !Array.isArray(m.features)) return null;
    if (!path) cached = m;
    return m;
  } catch {
    return null;
  }
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const toMs = (t) => (typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : t instanceof Date ? t.getTime() : NaN);

// Values at anchor - k*step for k = n..0 (oldest first; last element = anchor).
function resampleBack(ts, ps, anchor, n, step) {
  const out = new Array(n + 1);
  let j = -1; // index of last point with t <= current grid time (grid ascending)
  for (let k = n; k >= 0; k--) {
    const g = anchor - k * step;
    while (j + 1 < ts.length && ts[j + 1] <= g) j++;
    out[n - k] = j >= 0 ? ps[j] : NaN;
  }
  return out;
}

function popStd(x) {
  let s = 0;
  for (const v of x) s += v;
  const m = s / x.length;
  let q = 0;
  for (const v of x) q += (v - m) ** 2;
  return Math.sqrt(q / x.length);
}

/**
 * Feature vector (array in model.features order) for a spike, using only
 * information available at detection time. Returns null on bad input.
 */
export function featuresFor(spike, market, history, model = loadModel()) {
  try {
    const fp = model?.feature_params || {};
    const STEP = fp.step_ms ?? 60000;
    const LOOK = fp.lookback_min ?? 360;
    const SPIKY = fp.spiky_min_delta ?? 0.03;
    const FLOOR = fp.sigma_floor ?? 0.002;
    const DEF_SIGMA = fp.default_sigma ?? 0.01;
    const MIN1 = fp.min_returns_vol_1h ?? 20;
    const MIN6 = fp.min_returns_vol_6h ?? 60;

    const T = toMs(spike?.detectedAt ?? Date.now());
    const pFrom = Number(spike?.from);
    const pTo = Number(spike?.to);
    const W = Number(spike?.windowMs);
    if (!isNum(T) || !isNum(pFrom) || !isNum(pTo) || !isNum(W) || W < 0) return null;
    const F = T - W;

    const pts = [];
    for (const q of Array.isArray(history) ? history : []) {
      const t = toMs(q?.t);
      const p = Number(q?.p);
      if (isNum(t) && isNum(p) && t <= T) pts.push([t, p]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    const ts = pts.map((q) => q[0]);
    const ps = pts.map((q) => q[1]);

    const g = resampleBack(ts, ps, F, LOOK, STEP);
    const L = g.length;
    let nHist = 0;
    for (const v of g) if (!Number.isNaN(v)) nHist++;
    const d = [];
    for (let k = 1; k < L; k++) if (!Number.isNaN(g[k]) && !Number.isNaN(g[k - 1])) d.push(g[k] - g[k - 1]);
    const d1 = [];
    for (let k = L - 60; k < L; k++) if (!Number.isNaN(g[k]) && !Number.isNaN(g[k - 1])) d1.push(g[k] - g[k - 1]);
    const vol1 = d1.length >= MIN1 ? popStd(d1) : NaN;
    const vol6 = d.length >= MIN6 ? popStd(d) : NaN;
    let active = NaN;
    if (d1.length >= MIN1) {
      let c = 0;
      for (const v of d1) if (Math.abs(v) > 1e-9) c++;
      active = c / d1.length;
    }
    const last = g[L - 1];
    const ret1 = !Number.isNaN(last) && !Number.isNaN(g[L - 61]) ? last - g[L - 61] : NaN;
    const ret6 = !Number.isNaN(last) && !Number.isNaN(g[0]) ? last - g[0] : NaN;
    let lo = Infinity;
    let hi = -Infinity;
    let nv = 0;
    for (const v of g) {
      if (Number.isNaN(v)) continue;
      nv++;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const range6 = nv >= 2 ? hi - lo : NaN;

    const delta = pTo - pFrom;
    // return autocorrelation (bid/ask bounce => negative) and 10-min variance ratio
    const r = new Array(L).fill(NaN);
    for (let k = 1; k < L; k++) if (!Number.isNaN(g[k]) && !Number.isNaN(g[k - 1])) r[k] = g[k] - g[k - 1];
    let num = 0;
    let npairs = 0;
    for (let k = 1; k < L - 1; k++) {
      if (!Number.isNaN(r[k]) && !Number.isNaN(r[k + 1])) {
        num += r[k] * r[k + 1];
        npairs++;
      }
    }
    let den = 0;
    for (const v of d) den += v * v;
    const ac1 = npairs >= 30 && den > 1e-12 ? num / den : NaN;
    let R2 = 0;
    let nR = 0;
    for (let k = 10; k < L; k++) {
      if (!Number.isNaN(g[k]) && !Number.isNaN(g[k - 10])) {
        R2 += (g[k] - g[k - 10]) ** 2;
        nR++;
      }
    }
    const m1 = d.length ? den / d.length : 0;
    const vr10 = nR >= 30 && m1 > 1e-12 ? R2 / nR / (10 * m1) : NaN;
    let breakout = NaN;
    let posRange = NaN;
    if (nv >= 2) {
      breakout = (delta > 0 && pTo > hi + 1e-9) || (delta < 0 && pTo < lo - 1e-9) ? 1 : 0;
      posRange = hi - lo > 1e-9 ? (pTo - lo) / (hi - lo) : NaN;
    }
    let spiky = 0;
    for (let k = 10; k < L; k++) {
      const gk = g[k];
      if (Number.isNaN(gk)) continue;
      for (let j = 1; j <= 10; j++) {
        const gj = g[k - j];
        if (!Number.isNaN(gj) && Math.abs(gk - gj) >= SPIKY - 1e-9) {
          spiky++;
          break;
        }
      }
    }

    const ad = Math.abs(delta);
    const wmin = W / 60000;
    const sgn = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    const sigma = Math.max(Number.isNaN(vol6) ? DEF_SIGMA : vol6, FLOOR);
    const z = delta / (sigma * Math.sqrt(Math.max(wmin, 1)));
    const momentum = Number.isNaN(ret1) ? NaN : sgn * ret1;

    const endMs = toMs(market?.endDate ?? null);
    let lhte = NaN;
    let pastEnd = NaN;
    if (isNum(endMs)) {
      const h = (endMs - T) / 3600000;
      lhte = Math.log1p(Math.max(h, 0));
      pastEnd = h < 0 ? 1 : 0;
    }
    const days = Math.floor(T / 86400000);
    const hour = Math.floor((T - days * 86400000) / 3600000);
    const dow = (((days + 3) % 7) + 7) % 7;
    let cat = market?.category || spike?.category || 'other';
    if (!CATEGORIES.includes(cat)) cat = 'other';
    const source = market?.source || spike?.source;

    const f = {
      abs_delta: ad,
      signed_delta: delta,
      window_min: wmin,
      speed: ad / Math.max(wmin, 0.25),
      z,
      abs_z: Math.abs(z),
      p_from: pFrom,
      p_to: pTo,
      dist_bound: Math.min(pFrom, 1 - pFrom),
      crossed_50: pFrom < 0.5 !== pTo < 0.5 ? 1 : 0,
      toward_bound: (delta > 0 && pTo > 0.5) || (delta < 0 && pTo < 0.5) ? 1 : 0,
      vol_1h: vol1,
      vol_6h: vol6,
      ret_1h: ret1,
      ret_6h: ret6,
      range_6h: range6,
      momentum_align: momentum,
      ac1_6h: ac1,
      vr10_6h: vr10,
      breakout,
      pos_range: posRange,
      active_frac_1h: active,
      spiky_min_6h: spiky,
      n_hist_min: nHist,
      log_hours_to_end: lhte,
      past_end: pastEnd,
      hour_utc: hour,
      dow,
      is_kalshi: source === 'kalshi' ? 1 : 0,
    };
    for (const c of CATEGORIES) f[`cat_${c}`] = c === cat ? 1 : 0;
    const names = model?.features || Object.keys(f);
    return names.map((n) => (n in f ? f[n] : NaN));
  } catch {
    return null;
  }
}

/** Raw margin (log-odds) and per-feature Saabas path attributions. */
export function predictMargin(x, model = loadModel()) {
  let margin = model.base_margin;
  const contrib = new Array(model.features.length).fill(0);
  for (const tr of model.trees) {
    let i = 0;
    while (tr.f[i] >= 0) {
      const v = x[tr.f[i]];
      let next;
      if (v === null || v === undefined || Number.isNaN(v)) next = tr.m[i];
      else next = Math.fround(v) < tr.t[i] ? tr.y[i] : tr.n[i];
      contrib[tr.f[i]] += tr.v[next] - tr.v[i];
      i = next;
    }
    margin += tr.v[i];
  }
  return { margin, contrib };
}

function calibrate(raw, cal) {
  if (!cal || cal.type === 'none') return raw;
  if (cal.type === 'platt') {
    const r = Math.min(Math.max(raw, 1e-7), 1 - 1e-7);
    const f = Math.log(r / (1 - r));
    return 1 / (1 + Math.exp(cal.a * f + cal.b));
  }
  if (cal.type === 'isotonic') {
    const { x, y } = cal;
    if (raw <= x[0]) return y[0];
    if (raw >= x[x.length - 1]) return y[y.length - 1];
    let lo = 0;
    let hi = x.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (x[mid] <= raw) lo = mid;
      else hi = mid;
    }
    const span = x[hi] - x[lo];
    return span > 0 ? y[lo] + ((raw - x[lo]) * (y[hi] - y[lo])) / span : y[lo];
  }
  return raw;
}

/** Calibrated pReal from a feature vector. */
export function predictFeatures(x, model = loadModel()) {
  const { margin, contrib } = predictMargin(x, model);
  const raw = 1 / (1 + Math.exp(-margin));
  return { margin, raw, pReal: calibrate(raw, model.calibration), contrib };
}

/**
 * Score a detected spike. Never throws; returns null on failure.
 * @returns {{pReal:number,label:'event'|'likely'|'noise',drivers:{feature:string,impact:number,value:number|null}[],model:string,historyMinutes:number}|null}
 */
export function scoreSpike(spike, market, history) {
  try {
    const model = loadModel();
    if (!model) return null;
    const x = featuresFor(spike, market, history, model);
    if (!x) return null;
    const { pReal, contrib } = predictFeatures(x, model);
    if (!Number.isFinite(pReal)) return null;
    const th = model.thresholds || { event: 0.8, likely: 0.5 };
    const label = pReal >= th.event ? 'event' : pReal >= th.likely ? 'likely' : 'noise';
    const drivers = contrib
      .map((impact, i) => ({ feature: model.features[i], impact: Math.round(impact * 1e4) / 1e4, value: Number.isFinite(x[i]) ? Math.round(x[i] * 1e4) / 1e4 : null }))
      .filter((d) => d.impact !== 0)
      .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
      .slice(0, 3);
    const hm = model.features.indexOf('n_hist_min');
    return {
      pReal: Math.round(pReal * 1e4) / 1e4,
      label,
      drivers,
      model: model.model,
      historyMinutes: hm >= 0 ? x[hm] : null,
    };
  } catch {
    return null;
  }
}
