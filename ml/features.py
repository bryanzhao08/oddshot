"""Point-in-time features for a detected spike.

This module is the single source of truth for feature definitions. It is
mirrored line-for-line by server/ml/scorer.js (`featuresFor`); the JS test
suite checks parity against fixtures exported from here.

Inputs (all info available at detection time, nothing after it):
  ts_ms, ps : price history arrays (ms epoch, probability 0..1), ascending.
              Only points with t <= detectedAt are ever used.
  spike     : {from, to, windowMs, detectedAt_ms}
  market    : {source, category, endDate_ms (or None)}

Resampling: history is sampled onto a 1-minute grid anchored at the
pre-move time F = detectedAt - windowMs, going back 360 minutes (6h, which
is what the live detector keeps). Grid value = last observed price at or
before the grid time (NaN when there is none).
"""
import math

import numpy as np

CATEGORIES = ["sports", "politics", "crypto", "economics", "entertainment", "weather", "tech", "other"]
STEP_MS = 60_000
LOOKBACK_MIN = 360
SPIKY_MIN_DELTA = 0.03
SIGMA_FLOOR = 0.002
DEFAULT_SIGMA = 0.01

FEATURES = [
    "abs_delta", "signed_delta", "window_min", "speed", "z", "abs_z",
    "p_from", "p_to", "dist_bound", "crossed_50", "toward_bound",
    "vol_1h", "vol_6h", "ret_1h", "ret_6h", "range_6h", "momentum_align",
    "ac1_6h", "vr10_6h", "breakout", "pos_range",
    "active_frac_1h", "spiky_min_6h", "n_hist_min",
    "log_hours_to_end", "past_end",
    "hour_utc", "dow", "is_kalshi",
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
    # population stdev, computed the same way as the JS port (two-pass)
    m = sum(x) / len(x)
    return math.sqrt(sum((v - m) ** 2 for v in x) / len(x))


def compute_features(ts_ms, ps, spike, market):
    ts_ms = np.asarray(ts_ms, dtype=np.float64)
    ps = np.asarray(ps, dtype=np.float64)
    T = float(spike["detectedAt_ms"])
    W = float(spike["windowMs"])
    F = T - W
    p_from = float(spike["from"])
    p_to = float(spike["to"])
    delta = p_to - p_from  # (used by breakout below)
    ad = abs(delta)
    wmin = W / 60_000.0

    g = resample_back(ts_ms, ps, F, LOOKBACK_MIN)
    n_hist_min = int(np.sum(~np.isnan(g)))
    d = [g[k] - g[k - 1] for k in range(1, len(g)) if not (math.isnan(g[k]) or math.isnan(g[k - 1]))]
    d1 = [g[k] - g[k - 1] for k in range(len(g) - 60, len(g)) if not (math.isnan(g[k]) or math.isnan(g[k - 1]))]
    vol_1h = _std(d1) if len(d1) >= 20 else NAN
    vol_6h = _std(d) if len(d) >= 60 else NAN
    active = (sum(1 for v in d1 if abs(v) > 1e-9) / len(d1)) if len(d1) >= 20 else NAN
    last = g[-1]
    ret_1h = last - g[-61] if not (math.isnan(last) or math.isnan(g[-61])) else NAN
    ret_6h = last - g[0] if not (math.isnan(last) or math.isnan(g[0])) else NAN
    valid = [v for v in g if not math.isnan(v)]
    range_6h = (max(valid) - min(valid)) if len(valid) >= 2 else NAN
    # return autocorrelation (bid/ask bounce => negative) and 10-min variance ratio
    r = [NAN] * len(g)  # r[k] = g[k] - g[k-1]
    for k in range(1, len(g)):
        if not (math.isnan(g[k]) or math.isnan(g[k - 1])):
            r[k] = g[k] - g[k - 1]
    num, npairs = 0.0, 0
    for k in range(1, len(g) - 1):
        if not (math.isnan(r[k]) or math.isnan(r[k + 1])):
            num += r[k] * r[k + 1]
            npairs += 1
    den = sum(v * v for v in d)
    ac1 = num / den if (npairs >= 30 and den > 1e-12) else NAN
    R2, nR = 0.0, 0
    for k in range(10, len(g)):
        if not (math.isnan(g[k]) or math.isnan(g[k - 10])):
            R2 += (g[k] - g[k - 10]) ** 2
            nR += 1
    m1 = den / len(d) if len(d) else 0.0
    vr10 = (R2 / nR) / (10.0 * m1) if (nR >= 30 and m1 > 1e-12) else NAN
    if len(valid) >= 2:
        lo, hi = min(valid), max(valid)
        breakout = 1.0 if (delta > 0 and p_to > hi + 1e-9) or (delta < 0 and p_to < lo - 1e-9) else 0.0
        pos_range = (p_to - lo) / (hi - lo) if hi - lo > 1e-9 else NAN
    else:
        breakout, pos_range = NAN, NAN

    spiky = 0
    for k in range(10, len(g)):
        gk = g[k]
        if math.isnan(gk):
            continue
        for j in range(1, 11):
            gj = g[k - j]
            if not math.isnan(gj) and abs(gk - gj) >= SPIKY_MIN_DELTA - 1e-9:
                spiky += 1
                break

    sgn = 1.0 if delta > 0 else (-1.0 if delta < 0 else 0.0)
    sigma = max(vol_6h if not math.isnan(vol_6h) else DEFAULT_SIGMA, SIGMA_FLOOR)
    z = delta / (sigma * math.sqrt(max(wmin, 1.0)))
    momentum = sgn * ret_1h if not math.isnan(ret_1h) else NAN

    end = market.get("endDate_ms")
    if end is None or (isinstance(end, float) and math.isnan(end)):
        lhte, past_end = NAN, NAN
    else:
        h = (float(end) - T) / 3_600_000.0
        lhte = math.log1p(max(h, 0.0))
        past_end = 1.0 if h < 0 else 0.0

    # UTC hour / weekday (Mon=0) from epoch ms, integer arithmetic (matches JS)
    days = math.floor(T / 86_400_000)
    hour = math.floor((T - days * 86_400_000) / 3_600_000)
    dow = (days + 3) % 7  # 1970-01-01 was a Thursday (=3)

    cat = market.get("category") or "other"
    if cat not in CATEGORIES:
        cat = "other"

    f = {
        "abs_delta": ad,
        "signed_delta": delta,
        "window_min": wmin,
        "speed": ad / max(wmin, 0.25),
        "z": z,
        "abs_z": abs(z),
        "p_from": p_from,
        "p_to": p_to,
        "dist_bound": min(p_from, 1.0 - p_from),
        "crossed_50": 1.0 if (p_from < 0.5) != (p_to < 0.5) else 0.0,
        "toward_bound": 1.0 if (delta > 0 and p_to > 0.5) or (delta < 0 and p_to < 0.5) else 0.0,
        "vol_1h": vol_1h,
        "vol_6h": vol_6h,
        "ret_1h": ret_1h,
        "ret_6h": ret_6h,
        "range_6h": range_6h,
        "momentum_align": momentum,
        "ac1_6h": ac1,
        "vr10_6h": vr10,
        "breakout": breakout,
        "pos_range": pos_range,
        "active_frac_1h": active,
        "spiky_min_6h": float(spiky),
        "n_hist_min": float(n_hist_min),
        "log_hours_to_end": lhte,
        "past_end": past_end,
        "hour_utc": float(hour),
        "dow": float(dow),
        "is_kalshi": 1.0 if market.get("source") == "kalshi" else 0.0,
    }
    for c in CATEGORIES:
        f[f"cat_{c}"] = 1.0 if c == cat else 0.0
    return [f[k] for k in FEATURES]


# ---- category rules (ported from server/sources/*.js so training == serving) ----
import re

_PM_RULES = [
    ("sports", r"^(sports|nfl|nba|mlb|nhl|wnba|soccer|football|basketball|baseball|hockey|tennis|golf|ufc|mma|boxing|f1|formula-1|cricket|esports|cfb|ncaab|cbb|epl|ucl|la-liga|champions-league|olympics|nascar|league-of-legends|counter-strike-2|dota-2|valorant|chess)$"),
    ("crypto", r"^(crypto|bitcoin|ethereum|solana|xrp|crypto-prices|dogecoin|stablecoins|airdrops|memecoins)$"),
    ("weather", r"^(weather|climate|hurricanes?|temperature|global-temp|natural-disasters|earthquakes?|snow|rain)$"),
    ("tech", r"^(tech|ai|science|openai|anthropic|spacex|space|ai-rankings|big-tech|apple|google|nvidia|gpt-releases|compute)$"),
    ("economics", r"^(economy|economics|fed|fed-rates|fomc|finance|business|macro-indicators|inflation|cpi|us-cpi|gdp|stocks|commodities|interest-rates|recession|tariffs|economic-policy|jobs|ipo|ipos|earnings|equities|corporate-financials|global-rates)$"),
    ("entertainment", r"^(pop-culture|culture|entertainment|movies|music|awards|oscars|grammys|emmys|tv|celebrities|tweets-markets|youtube|twitter|elon-musk|mentions|box-office|gaming|video-games)$"),
    ("politics", r"^(politics|elections|geopolitics|world|us-presidential-election|midterms|global-elections|world-elections|trump|congress|senate|foreign-policy|middle-east|ukraine|israel|iran|china)$"),
]
_PM_KW = [
    ("sports", r"\b(vs\.?|win on \d{4}|nfl|nba|mlb|nhl|super bowl|world series|champions league|premier league|grand slam|o/u|spread:|game \d winner|bo3|bo5)\b"),
    ("crypto", r"\b(bitcoin|btc|ethereum|eth|solana|crypto|xrp|dogecoin)\b"),
    ("weather", r"\b(hurricane|temperature|weather|rainfall|snowfall|tornado|heat)\b"),
    ("economics", r"\b(fed|interest rates?|inflation|cpi|gdp|recession|s&p|nasdaq|unemployment|tariff|ipo)\b"),
    ("tech", r"\b(ai|openai|anthropic|gpt|gemini|spacex|apple|google|nvidia|tesla)\b"),
    ("entertainment", r"\b(tweets?|oscars?|grammys?|album|movie|box office|taylor swift|mrbeast|netflix)\b"),
    ("politics", r"\b(election|president|senate|house|governor|minister|trump|ceasefire|invade|war|parliament|nominee|mayor)\b"),
]


def polymarket_category(tags, text=""):
    for cat, rx in _PM_RULES:
        if any(re.match(rx, t) for t in tags):
            return cat
    for cat, rx in _PM_KW:
        if re.search(rx, text, re.I):
            return cat
    return "other"


KALSHI_CATEGORY_MAP = {
    "sports": "sports", "elections": "politics", "politics": "politics", "world": "politics",
    "economics": "economics", "financials": "economics", "commodities": "economics", "companies": "economics",
    "crypto": "crypto", "climate and weather": "weather", "weather": "weather",
    "science and technology": "tech", "tech": "tech", "entertainment": "entertainment",
    "mentions": "entertainment", "social": "entertainment",
}
