// Fallback "moment forecast" used when server/ml/forecaster.js isn't available.
// Same output shape as forecastMove() in the contract, with model: 'heuristic'.
// Pure ES module (browser-safe).

import { MIN, HOUR, clamp, isNum, round, toMs, volPerMin, historyMinutes, effectiveEndMs } from './util.js';

// Prior per-minute volatility (probability units) when history is thin.
const PRIOR_SIGMA = { liveSports: 0.012, live: 0.006, soon: 0.003, idle: 0.0012 };

// Standard normal CDF (Abramowitz–Stegun 7.1.26).
function phi(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * P(|Δp| ≥ 0.05 at some point in the next 30 min) for a random walk with the market's
 * recent per-minute vol, blended with a prior from liveness/time-to-start, and damped
 * near 0/1 where prices are pinned. Never throws.
 */
export function heuristicForecast(market, history = [], now = Date.now()) {
  try {
    const p = Number(market?.probability);
    if (!(p >= 0 && p <= 1)) return null;
    const pts = Array.isArray(history) ? history : [];
    const hm = historyMinutes(pts, now);
    const start = toMs(market.startTime);
    const end = effectiveEndMs(market);
    const toStart = isNum(start) ? (start - now) / MIN : Infinity;
    const toEnd = isNum(end) ? (end - now) / MIN : Infinity;
    const live = Boolean(market.live) || (isNum(start) && toStart <= 0 && toStart > -240 && market.category === 'sports');

    const prior = live
      ? market.category === 'sports' ? PRIOR_SIGMA.liveSports : PRIOR_SIGMA.live
      : toStart > 0 && toStart < 180 ? PRIOR_SIGMA.soon : PRIOR_SIGMA.idle;
    const v15 = volPerMin(pts, 15 * MIN, now);
    const v60 = volPerMin(pts, HOUR, now);
    let sigma;
    if (isNum(v15) && isNum(v60)) sigma = 0.6 * v15 + 0.4 * v60;
    else if (isNum(v60)) sigma = v60;
    else if (isNum(v15)) sigma = v15;
    // Shrink toward the prior when history is short.
    const w = clamp(hm / 60, 0, 1);
    sigma = isNum(sigma) ? w * sigma + (1 - w) * prior : prior;
    // Live, close games tend to get more volatile, not less.
    if (live) sigma = Math.max(sigma, prior * 0.5);
    // Prices are pinned near 0/1: scale by the Bernoulli std relative to a coin flip.
    const pin = Math.sqrt(clamp(4 * p * (1 - p), 0.02, 1));
    sigma *= 0.5 + 0.5 * pin;

    const horizon = Math.min(30, isNum(toEnd) && toEnd > 0 ? toEnd : 30);
    const sd = Math.max(sigma * Math.sqrt(Math.max(horizon, 1)), 1e-6);
    // Reflection principle: P(max|W| ≥ a) ≈ 4(1 − Φ(a/sd)), capped.
    const a = 0.05;
    // Tick-to-tick noise (bid/ask bounce) inflates 1-min vol, so discount it a little.
    let pMove = clamp(4 * (1 - phi(a / (sd * 0.8))), 0, 0.92);
    // Can't move 5 pts if both sides are within 5 pts of a bound... (only one direction possible)
    if (p > 0.95 || p < 0.05) pMove *= 0.6;
    // Kick-off / resolution imminence bumps the odds of a jump.
    if (toStart > 0 && toStart <= 30) pMove = clamp(pMove + 0.08, 0, 0.92);
    if (toEnd > 0 && toEnd <= 30 && p > 0.1 && p < 0.9) pMove = clamp(pMove + 0.1, 0, 0.92);
    const expectedMovePts = 100 * Math.min(sd * 1.6, Math.max(p, 1 - p));

    const drivers = [
      { feature: 'recent_vol', impact: round(sigma / prior - 1, 2), value: round(sigma, 4) },
      { feature: 'uncertainty', impact: round(pin - 0.5, 2), value: round(p, 3) },
      { feature: live ? 'live' : 'time_to_start_min', impact: live ? 0.5 : toStart > 0 && toStart < 180 ? 0.2 : -0.2, value: live ? 1 : isNum(toStart) && toStart !== Infinity ? Math.round(toStart) : null },
    ].sort((x, y) => Math.abs(y.impact) - Math.abs(x.impact));

    return {
      pMove30: round(pMove, 3),
      expectedMovePts: round(expectedMovePts, 1),
      drivers,
      model: 'heuristic',
      historyMinutes: Math.round(hm),
    };
  } catch {
    return null;
  }
}
