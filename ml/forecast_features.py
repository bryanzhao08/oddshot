"""Point-in-time features for the Moment Forecaster ("will this market make a
big move in the next 30 minutes?").

Single source of truth for the forecaster's features. Mirrored line-for-line by
`featuresForForecast()` in server/ml/forecaster.js; the JS parity test
(server/ml/forecaster.test.js) checks both against fixtures exported from here.

Inputs (only information available at decision time T):
  ts_ms, ps : raw price history (ms epoch, probability 0..1), ascending.
              Only points with t <= T are used.
  T         : decision time, ms epoch.
  market    : {source, category, endDate_ms|None, startTime_ms|None}

Resampling (same as ml/features.py): a 1-minute grid anchored at T going back
360 minutes (361 values, oldest first, last = T). Grid value = last observed
price at or before the grid time (NaN when there is none). Irregular live
polling (20s) and 1-minute backfill therefore map onto the same grid.
"""
import math

import numpy as np

CATEGORIES = ["sports", "politics", "crypto", "economics", "entertainment", "weather", "tech", "other"]
STEP_MS = 60_000
LOOKBACK_MIN = 360
MOVE_MIN_DELTA = 0.03     # a ">= 3pt move" = |g[k] - g[k-j]| >= 0.03 for some j in 1..10
MOVE_WINDOW_MIN = 10
MOVE_COOLDOWN_MIN = 10
VOL_EPS = 0.0005          # added to both sides of vol ratios
PIN_LO, PIN_HI = 0.02, 0.98
GAME_LEN_H = 4.0          # live proxy: within 4h after scheduled start
LIVE_END_H = 6.0          # live proxy (sports, no start): ends within 6h

FEATURES = [
    "p", "dist_mid", "dist_bound",
    "vol_15m", "vol_1h", "vol_6h", "vr_15m_1h", "vr_1h_6h",
    "ret_5m", "ret_15m", "ret_1h", "abs_ret_5m", "abs_ret_15m", "abs_ret_1h",
    "maxjump_1h", "range_1h", "range_6h", "pos_range_6h", "active_frac_1h",
    "n_moves_6h", "min_since_move",
    "log_hours_to_end", "past_end", "start_rel", "live_proxy",
    "hour_utc", "dow", "is_kalshi", "n_hist_min",
] + [f"cat_{c}" for c in CATEGORIES]

NAN = float("nan")


def resample_back(ts_ms, ps, anchor_ms, n, step=STEP_MS):
    """Values at anchor - k*step for k = n..0 (oldest first, last = anchor)."""
    times = anchor_ms - np.arange(n, -1, -1, dtype=np.float64) * step
    idx = np.searchsorted(ts_ms, times, side="right") - 1
    out = np.full(n + 1, np.nan)
    ok = idx >= 0
    out[ok] = ps[idx[ok]]
    return out


def _std(x):
    # population stdev, sequential two-pass (same arithmetic as the JS port)
    s = 0.0
    for v in x:
        s += v
    m = s / len(x)
    q = 0.0
    for v in x:
        q += (v - m) ** 2
    return math.sqrt(q / len(x))


def _diffs(g, n_last):
    L = len(g)
    out = []
    for k in range(max(L - n_last, 1), L):
        a, b = g[k], g[k - 1]
        if not (math.isnan(a) or math.isnan(b)):
            out.append(a - b)
    return out


def _ret(g, mins):
    L = len(g)
    last, prev = g[L - 1], g[L - 1 - mins]
    return NAN if (math.isnan(last) or math.isnan(prev)) else last - prev


def _range(vals):
    v = [x for x in vals if not math.isnan(x)]
    return (min(v), max(v), len(v)) if v else (NAN, NAN, 0)


def is_pinned(g):
    """Last 61 grid values all <= 0.02 or all >= 0.98 (market effectively resolved)."""
    lo, hi, n = _range(g[-61:])
    return n > 0 and (hi <= PIN_LO or lo >= PIN_HI)


def grid_for(ts_ms, ps, T):
    return resample_back(np.asarray(ts_ms, dtype=np.float64), np.asarray(ps, dtype=np.float64), float(T), LOOKBACK_MIN)


def compute_features(g, T, market):
    """g = grid_for(...) (361 values). Returns the feature vector in FEATURES order."""
    g = [float(v) for v in g]
    L = len(g)
    p = g[L - 1]
    n_hist = sum(1 for v in g if not math.isnan(v))

    d15, d60, d360 = _diffs(g, 15), _diffs(g, 60), _diffs(g, 360)
    vol15 = _std(d15) if len(d15) >= 10 else NAN
    vol1 = _std(d60) if len(d60) >= 20 else NAN
    vol6 = _std(d360) if len(d360) >= 60 else NAN
    vr1 = NAN if (math.isnan(vol15) or math.isnan(vol1)) else (vol15 + VOL_EPS) / (vol1 + VOL_EPS)
    vr2 = NAN if (math.isnan(vol1) or math.isnan(vol6)) else (vol1 + VOL_EPS) / (vol6 + VOL_EPS)
    r5, r15, r60 = _ret(g, 5), _ret(g, 15), _ret(g, 60)
    maxjump = NAN
    if len(d60) >= 20:
        maxjump = 0.0
        for v in d60:
            if abs(v) > maxjump:
                maxjump = abs(v)
    active = NAN
    if len(d60) >= 20:
        c = 0
        for v in d60:
            if abs(v) > 1e-9:
                c += 1
        active = c / len(d60)
    lo1, hi1, n1 = _range(g[L - 61:])
    range1 = hi1 - lo1 if n1 >= 2 else NAN
    lo6, hi6, n6 = _range(g)
    range6 = hi6 - lo6 if n6 >= 2 else NAN
    pos6 = (p - lo6) / (hi6 - lo6) if (n6 >= 2 and hi6 - lo6 > 1e-9 and not math.isnan(p)) else NAN

    # >= 3pt moves: detector replay on the grid (10-min window, 10-min cooldown)
    n_moves, last_fire, last_cond = 0, -10**9, -1
    for k in range(1, L):
        gk = g[k]
        if math.isnan(gk):
            continue
        cond = False
        for j in range(1, MOVE_WINDOW_MIN + 1):
            if k - j < 0:
                break
            gj = g[k - j]
            if not math.isnan(gj) and abs(gk - gj) >= MOVE_MIN_DELTA - 1e-9:
                cond = True
                break
        if cond:
            last_cond = k
            if k - last_fire >= MOVE_COOLDOWN_MIN:
                n_moves += 1
                last_fire = k
    min_since = float(L - 1 - last_cond) if last_cond >= 0 else NAN

    cat = market.get("category") or "other"
    if cat not in CATEGORIES:
        cat = "other"
    end = market.get("endDate_ms")
    end = None if end is None or (isinstance(end, float) and math.isnan(end)) else float(end)
    start = market.get("startTime_ms")
    start = None if start is None or (isinstance(start, float) and math.isnan(start)) else float(start)
    if end is None:
        lhte, past_end = NAN, NAN
    else:
        h = (end - T) / 3_600_000.0
        lhte = math.log1p(max(h, 0.0))
        past_end = 1.0 if h < 0 else 0.0
    if start is None:
        start_rel = NAN
    else:
        s = (T - start) / 3_600_000.0
        start_rel = math.log1p(s) if s >= 0 else -math.log1p(-s)
    if start is not None:
        s = (T - start) / 3_600_000.0
        live = 1.0 if (s >= 0 and s <= GAME_LEN_H) else 0.0
    elif cat == "sports" and end is not None:
        h = (end - T) / 3_600_000.0
        live = 1.0 if (h >= -1.0 and h <= LIVE_END_H) else 0.0
    else:
        live = 0.0

    days = math.floor(T / 86_400_000)
    hour = math.floor((T - days * 86_400_000) / 3_600_000)
    dow = (days + 3) % 7  # 1970-01-01 was a Thursday (Mon=0)

    f = {
        "p": p,
        "dist_mid": abs(p - 0.5),
        "dist_bound": min(p, 1.0 - p),
        "vol_15m": vol15, "vol_1h": vol1, "vol_6h": vol6,
        "vr_15m_1h": vr1, "vr_1h_6h": vr2,
        "ret_5m": r5, "ret_15m": r15, "ret_1h": r60,
        "abs_ret_5m": abs(r5), "abs_ret_15m": abs(r15), "abs_ret_1h": abs(r60),
        "maxjump_1h": maxjump, "range_1h": range1, "range_6h": range6, "pos_range_6h": pos6,
        "active_frac_1h": active,
        "n_moves_6h": float(n_moves), "min_since_move": min_since,
        "log_hours_to_end": lhte, "past_end": past_end, "start_rel": start_rel, "live_proxy": live,
        "hour_utc": float(hour), "dow": float(dow),
        "is_kalshi": 1.0 if market.get("source") == "kalshi" else 0.0,
        "n_hist_min": float(n_hist),
    }
    for c in CATEGORIES:
        f[f"cat_{c}"] = 1.0 if c == cat else 0.0
    return [f[k] for k in FEATURES]
