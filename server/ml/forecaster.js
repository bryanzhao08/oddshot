// Oddshot Moment Forecaster: from info available NOW, how likely is a market to
// make a big move soon?  pMove30 = P(max |p(now+k) - p(now)| >= 0.05 for some
// k in (0, 30 min]); expectedMovePts = expected max |move| over the next 30 min.
//
// Pure JS, zero deps, browser-compatible. Evaluates the XGBoost classifier +
// regressor exported by ml/forecast_train.py (server/ml/forecaster.json).
// Features mirror ml/forecast_features.py exactly; server/ml/forecaster.test.js
// checks parity against fixtures exported from Python.
//
//   import { loadForecaster, forecastMove } from './ml/forecaster.js';
//   const f = forecastMove(market, detector.history(market.id));
//   // { pMove30, expectedMovePts, drivers: [{feature, impact, value}], model, historyMinutes } | null
//
// history = [{t, p}] (t = ms epoch / ISO / Date), any order, possibly irregular
// (20s polling or 1-minute backfill). It is resampled onto a 1-minute grid
// anchored at `now` (last observation carried forward), 6h back, exactly as in
// training. Points after `now` are ignored.
//
// Fallback (model: 'heuristic'): used when forecaster.json is unavailable or the
// history covers < 30 minutes. A 6-input logistic model (realized vol and range
// of the last <= 30 min, distance from 50%, live proxy, resolves within 1h,
// sports) fitted on the same training data; its mean prediction matches the
// base rate (~3.3%) and it ranks moments with AUC ~0.92 on the held-out test set
// (vs ~0.95 for the full model). See ml/forecast_report.txt.

// node:fs is loaded only under Node so this module also runs in the browser (see setForecaster).
const fs = globalThis.process?.versions?.node ? await import('node:fs') : null;

const MODEL_URL = new URL('./forecaster.json', import.meta.url);
const CATEGORIES = ['sports', 'politics', 'crypto', 'economics', 'entertainment', 'weather', 'tech', 'other'];
const HOUR = 3600000;

// Fitted by ml/forecast_train.py (copied from forecaster.json "heuristic") so the
// fallback works even when forecaster.json is missing.
const DEFAULT_HEURISTIC = /*HEURISTIC_BEGIN*/{"features":["h_vol30","h_range30","dist_mid","live_proxy","h_end_1h","cat_sports"],"impute_vol30":0.0,"transform":"sqrt on h_vol30 and h_range30","mean":[0.016989160936992837,0.03821772066358094,0.16081204999999357,0.016713333333333334,0.0024533333333333334,0.9046533333333333],"scale":[0.035515037952081774,0.08231789494060045,0.13493338715851483,0.12819515522228161,0.04947033948722948,0.2936931729253827],"logit_coef":[0.25707143264685417,0.7648397928609117,-0.675715010601695,0.25747109654974687,0.11788478201602091,-0.11358065443479258],"logit_intercept":-4.329112263363615,"move_coef":[-0.0030526594688330953,0.016655920483292366,-0.001559899757982329,0.009831748169290944,0.0007721660581816054,5.898416345873401e-05],"move_intercept":0.007502139999999872}/*HEURISTIC_END*/;

let cached = null;
let installed = false; // setForecaster() was called: don't fall back to reading the file

const valid = (m) => !!(m && Array.isArray(m.features) && m.classifier && Array.isArray(m.classifier.trees) && m.regressor && Array.isArray(m.regressor.trees));

/** Install an already-parsed forecaster (browser builds fetch forecaster.json themselves).
 *  setForecaster(null) disables the model (forecastMove then uses the heuristic). */
export function setForecaster(m) {
  installed = true;
  cached = valid(m) ? m : null;
  return cached;
}

/** Load (and cache) the forecaster. Returns the model object or null if unavailable. */
export function loadForecaster(path) {
  try {
    if (!path && (cached || installed)) return cached;
    if (!fs) return null;
    const m = JSON.parse(fs.readFileSync(path || MODEL_URL, 'utf8'));
    if (!valid(m)) return null;
    if (!path) cached = m;
    return m;
  } catch {
    return null;
  }
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const toMs = (t) => (typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : t instanceof Date ? t.getTime() : NaN);

/** Clean history -> sorted [ts[], ps[]] with t <= now. */
function cleanHistory(history, now) {
  const ts = [];
  const ps = [];
  let sorted = true;
  if (Array.isArray(history)) {
    for (const q of history) {
      if (!q) continue;
      const t = toMs(q.t);
      const p = typeof q.p === 'number' ? q.p : Number(q.p);
      if (!isNum(t) || !isNum(p) || t > now) continue;
      if (ts.length && t < ts[ts.length - 1]) sorted = false;
      ts.push(t);
      ps.push(p);
    }
  }
  if (!sorted) {
    const idx = ts.map((_, i) => i).sort((a, b) => ts[a] - ts[b] || a - b);
    return [idx.map((i) => ts[i]), idx.map((i) => ps[i])];
  }
  return [ts, ps];
}

// Values at anchor - k*step for k = n..0 (oldest first; last element = anchor).
function resampleBack(ts, ps, anchor, n, step) {
  const out = new Array(n + 1);
  let j = -1;
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

function diffs(g, nLast) {
  const L = g.length;
  const out = [];
  for (let k = Math.max(L - nLast, 1); k < L; k++) {
    const a = g[k];
    const b = g[k - 1];
    if (!Number.isNaN(a) && !Number.isNaN(b)) out.push(a - b);
  }
  return out;
}

function rangeOf(g, from) {
  let lo = Infinity;
  let hi = -Infinity;
  let n = 0;
  for (let k = Math.max(from, 0); k < g.length; k++) {
    const v = g[k];
    if (Number.isNaN(v)) continue;
    n++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return n ? [lo, hi, n] : [NaN, NaN, 0];
}

function marketTimes(market) {
  const e = toMs(market?.endDate ?? null);
  const s = toMs(market?.startTime ?? null);
  return { end: isNum(e) ? e : null, start: isNum(s) ? s : null };
}

/**
 * Feature dict + grid for a market at time `now` (mirrors compute_features in
 * ml/forecast_features.py). Returns null on bad input.
 */
export function forecastFeatures(market, history, now = Date.now(), model = loadForecaster()) {
  try {
    const fp = model?.feature_params || {};
    const STEP = fp.step_ms ?? 60000;
    const LOOK = fp.lookback_min ?? 360;
    const MOVE = fp.move_min_delta ?? 0.03;
    const MWIN = fp.move_window_min ?? 10;
    const MCOOL = fp.move_cooldown_min ?? 10;
    const EPS = fp.vol_eps ?? 0.0005;
    const GAME_LEN_H = fp.game_len_h ?? 4;
    const LIVE_END_H = fp.live_end_h ?? 6;
    const T = toMs(now);
    if (!isNum(T)) return null;
    const [ts, ps] = cleanHistory(history, T);
    const g = resampleBack(ts, ps, T, LOOK, STEP);
    const L = g.length;
    const p = g[L - 1];
    let nHist = 0;
    for (const v of g) if (!Number.isNaN(v)) nHist++;

    const d15 = diffs(g, 15);
    const d60 = diffs(g, 60);
    const d360 = diffs(g, 360);
    const vol15 = d15.length >= 10 ? popStd(d15) : NaN;
    const vol1 = d60.length >= 20 ? popStd(d60) : NaN;
    const vol6 = d360.length >= 60 ? popStd(d360) : NaN;
    const vr1 = Number.isNaN(vol15) || Number.isNaN(vol1) ? NaN : (vol15 + EPS) / (vol1 + EPS);
    const vr2 = Number.isNaN(vol1) || Number.isNaN(vol6) ? NaN : (vol1 + EPS) / (vol6 + EPS);
    const ret = (mins) => {
      const a = g[L - 1];
      const b = g[L - 1 - mins];
      return Number.isNaN(a) || Number.isNaN(b) ? NaN : a - b;
    };
    const r5 = ret(5);
    const r15 = ret(15);
    const r60 = ret(60);
    let maxjump = NaN;
    let active = NaN;
    if (d60.length >= 20) {
      maxjump = 0;
      let c = 0;
      for (const v of d60) {
        if (Math.abs(v) > maxjump) maxjump = Math.abs(v);
        if (Math.abs(v) > 1e-9) c++;
      }
      active = c / d60.length;
    }
    const [lo1, hi1, n1] = rangeOf(g, L - 61);
    const range1 = n1 >= 2 ? hi1 - lo1 : NaN;
    const [lo6, hi6, n6] = rangeOf(g, 0);
    const range6 = n6 >= 2 ? hi6 - lo6 : NaN;
    const pos6 = n6 >= 2 && hi6 - lo6 > 1e-9 && !Number.isNaN(p) ? (p - lo6) / (hi6 - lo6) : NaN;

    // >= 3pt moves: detector replay on the grid (10-min window, 10-min cooldown)
    let nMoves = 0;
    let lastFire = -1e9;
    let lastCond = -1;
    for (let k = 1; k < L; k++) {
      const gk = g[k];
      if (Number.isNaN(gk)) continue;
      let cond = false;
      for (let j = 1; j <= MWIN; j++) {
        if (k - j < 0) break;
        const gj = g[k - j];
        if (!Number.isNaN(gj) && Math.abs(gk - gj) >= MOVE - 1e-9) {
          cond = true;
          break;
        }
      }
      if (cond) {
        lastCond = k;
        if (k - lastFire >= MCOOL) {
          nMoves++;
          lastFire = k;
        }
      }
    }
    const minSince = lastCond >= 0 ? L - 1 - lastCond : NaN;

    let cat = market?.category || 'other';
    if (!CATEGORIES.includes(cat)) cat = 'other';
    const { end, start } = marketTimes(market);
    let lhte = NaN;
    let pastEnd = NaN;
    if (end !== null) {
      const h = (end - T) / HOUR;
      lhte = Math.log1p(Math.max(h, 0));
      pastEnd = h < 0 ? 1 : 0;
    }
    let startRel = NaN;
    let live = 0;
    if (start !== null) {
      const s = (T - start) / HOUR;
      startRel = s >= 0 ? Math.log1p(s) : -Math.log1p(-s);
      live = s >= 0 && s <= GAME_LEN_H ? 1 : 0;
    } else if (cat === 'sports' && end !== null) {
      const h = (end - T) / HOUR;
      live = h >= -1 && h <= LIVE_END_H ? 1 : 0;
    }
    const days = Math.floor(T / 86400000);
    const hour = Math.floor((T - days * 86400000) / 3600000);
    const dow = (((days + 3) % 7) + 7) % 7;

    const f = {
      p,
      dist_mid: Math.abs(p - 0.5),
      dist_bound: Math.min(p, 1 - p),
      vol_15m: vol15,
      vol_1h: vol1,
      vol_6h: vol6,
      vr_15m_1h: vr1,
      vr_1h_6h: vr2,
      ret_5m: r5,
      ret_15m: r15,
      ret_1h: r60,
      abs_ret_5m: Math.abs(r5),
      abs_ret_15m: Math.abs(r15),
      abs_ret_1h: Math.abs(r60),
      maxjump_1h: maxjump,
      range_1h: range1,
      range_6h: range6,
      pos_range_6h: pos6,
      active_frac_1h: active,
      n_moves_6h: nMoves,
      min_since_move: minSince,
      log_hours_to_end: lhte,
      past_end: pastEnd,
      start_rel: startRel,
      live_proxy: live,
      hour_utc: hour,
      dow,
      is_kalshi: market?.source === 'kalshi' ? 1 : 0,
      n_hist_min: nHist,
    };
    for (const c of CATEGORIES) f[`cat_${c}`] = c === cat ? 1 : 0;
    const historyMinutes = ts.length ? Math.min(Math.max(0, Math.floor((T - ts[0]) / 60000)), LOOK) : 0;
    return { f, g, historyMinutes };
  } catch {
    return null;
  }
}

/** Feature vector in model.features order (NaN = missing). */
export function featureVector(market, history, now = Date.now(), model = loadForecaster()) {
  const r = forecastFeatures(market, history, now, model);
  if (!r || !model) return null;
  return model.features.map((n) => (n in r.f ? r.f[n] : NaN));
}

/** Walk exported XGBoost trees: raw margin + per-feature Saabas path attributions. */
export function treeMargin(x, part, nFeatures) {
  let margin = part.base_margin;
  const contrib = new Array(nFeatures).fill(0);
  for (const tr of part.trees) {
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
    return 1 / (1 + Math.exp(cal.a * Math.log(r / (1 - r)) + cal.b));
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

/** Model predictions from a feature vector (exposed for the parity test). */
export function predictForecast(x, model = loadForecaster()) {
  const n = model.features.length;
  const c = treeMargin(x, model.classifier, n);
  const raw = 1 / (1 + Math.exp(-c.margin));
  const r = treeMargin(x, model.regressor, n);
  return {
    margin: c.margin,
    raw,
    pMove30: calibrate(raw, model.classifier.calibration),
    regMargin: r.margin,
    expectedMovePts: 100 * Math.max(r.margin, 0),
    contrib: c.contrib,
  };
}

/** Heuristic inputs from only the last 30 minutes of the grid (mirrors heur_from_grid). */
export function heuristicInputs(g, f) {
  const w = g.slice(-31);
  const d = [];
  for (let k = 1; k < w.length; k++) if (!Number.isNaN(w[k]) && !Number.isNaN(w[k - 1])) d.push(w[k] - w[k - 1]);
  const vol = d.length >= 3 ? popStd(d) : NaN;
  let lo = Infinity;
  let hi = -Infinity;
  let n = 0;
  for (const v of w) {
    if (Number.isNaN(v)) continue;
    n++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const rng = n >= 2 ? hi - lo : 0;
  const end1 = !Number.isNaN(f.log_hours_to_end) && f.past_end === 0 && f.log_hours_to_end <= Math.log1p(1) ? 1 : 0;
  return [vol, rng, f.dist_mid, f.live_proxy, end1, f.cat_sports];
}

/** Heuristic fallback prediction: {pMove30, expectedMovePts, contrib, names}. */
export function predictHeuristic(h, inputs) {
  const x = inputs.slice();
  if (Number.isNaN(x[0])) x[0] = h.impute_vol30;
  x[0] = Math.sqrt(Math.max(x[0], 0));
  x[1] = Math.sqrt(Math.max(x[1], 0));
  let zl = h.logit_intercept;
  let mv = h.move_intercept;
  const contrib = [];
  for (let i = 0; i < x.length; i++) {
    const z = (x[i] - h.mean[i]) / h.scale[i];
    contrib.push(h.logit_coef[i] * z);
    zl += h.logit_coef[i] * z;
    mv += h.move_coef[i] * z;
  }
  return { pMove30: 1 / (1 + Math.exp(-zl)), expectedMovePts: 100 * Math.max(mv, 0), contrib, names: h.features };
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const topDrivers = (contrib, names, values) =>
  contrib
    .map((impact, i) => ({ feature: names[i], impact: r4(impact), value: Number.isFinite(values[i]) ? r4(values[i]) : null }))
    .filter((d) => d.impact !== 0)
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 3);

/**
 * Forecast a big move (>= 5 pts within 30 min) for one market. Never throws.
 * @param market  normalized Market ({source, category, endDate, startTime, probability, ...})
 * @param history [{t, p}] price history (only points <= now are used)
 * @param now     ms epoch (default Date.now())
 * @returns {{pMove30:number, expectedMovePts:number, drivers:{feature:string,impact:number,value:number|null}[], model:string, historyMinutes:number}|null}
 */
export function forecastMove(market, history, now = Date.now()) {
  try {
    const model = loadForecaster();
    let hist = history;
    // no usable history: fall back to the market's current probability as a single point
    if (!Array.isArray(hist) || hist.length === 0) {
      const p0 = Number(market?.probability);
      hist = isNum(p0) ? [{ t: toMs(now), p: p0 }] : [];
    }
    const r = forecastFeatures(market, hist, now, model);
    if (!r || !isNum(r.f.p)) {
      const p0 = Number(market?.probability);
      if (!isNum(p0) || !isNum(toMs(now))) return null;
      return forecastMove(market, [{ t: toMs(now), p: p0 }], now);
    }
    const minHist = model?.feature_params?.min_history_min ?? 30;
    if (model && r.historyMinutes >= minHist) {
      const x = model.features.map((n) => (n in r.f ? r.f[n] : NaN));
      const pr = predictForecast(x, model);
      if (isNum(pr.pMove30) && isNum(pr.expectedMovePts)) {
        return {
          pMove30: r4(pr.pMove30),
          expectedMovePts: Math.round(pr.expectedMovePts * 100) / 100,
          drivers: topDrivers(pr.contrib, model.features, x),
          model: model.model,
          historyMinutes: r.historyMinutes,
        };
      }
    }
    const h = model?.heuristic || DEFAULT_HEURISTIC;
    if (!h) return null;
    const inputs = heuristicInputs(r.g, r.f);
    const hp = predictHeuristic(h, inputs);
    if (!isNum(hp.pMove30)) return null;
    return {
      pMove30: r4(hp.pMove30),
      expectedMovePts: Math.round(hp.expectedMovePts * 100) / 100,
      drivers: topDrivers(hp.contrib, hp.names, inputs),
      model: 'heuristic',
      historyMinutes: r.historyMinutes,
    };
  } catch {
    return null;
  }
}
