"""Odds-only features for game-state estimation (SPEC section 3).

Everything here is written to be ported line for line to Swift (ios/Tipoff/Engine/StateModel.swift):
plain loops, no vectorised tricks that change float order.

Prices are resampled to a 1-minute grid: the value at minute m is the last observation at or before
game_start + 60*m seconds (carried forward). Prices are in percentage points (0-100).
"""

from __future__ import annotations

import math

SPORTS = ["nfl", "cfb", "soccer", "mlb", "nhl", "nba"]

FEATURES = [
    "p", "dist_mid",
    "ret_1", "ret_2", "ret_3", "ret_5", "ret_10", "ret_20",
    "absret_1", "absret_3", "absret_10",
    "vol_5", "vol_15", "vol_30", "maxjump_5", "last_sign", "run_len",
    "kf_level", "kf_vel", "kf_sd_level", "kf_sd_vel", "kf_innov", "kf_z",
    "minute", "three_way",
] + [f"sport_{s}" for s in SPORTS]

DEFAULT_KALMAN = {"q_level": 0.5, "q_velocity": 0.05, "r": 1.0}


def grid(prices, start_sec, n_minutes):
    """prices: sorted [(t_sec, p_0_1)]. Returns [p_pts or None] for minutes 0..n_minutes."""
    out = []
    j = -1
    for m in range(n_minutes + 1):
        g = start_sec + 60 * m
        while j + 1 < len(prices) and prices[j + 1][0] <= g:
            j += 1
        out.append(prices[j][1] * 100.0 if j >= 0 else None)
    return out


def kalman(series, params):
    """Local linear trend filter over a 1-minute series (None = missing, prediction only).
    Returns per-minute (level, velocity, sd_level, sd_velocity, innovation, z)."""
    ql, qv, r = params["q_level"], params["q_velocity"], params["r"]
    out = []
    x0 = x1 = None
    p00 = p01 = p11 = 0.0
    for z in series:
        if x0 is None:
            if z is None:
                out.append(None)
                continue
            x0, x1 = z, 0.0
            p00, p01, p11 = r, 0.0, 1.0
            out.append((x0, x1, math.sqrt(p00), math.sqrt(p11), 0.0, 0.0))
            continue
        # predict: x = F x, P = F P F' + Q, F = [[1,1],[0,1]]
        x0 = x0 + x1
        n00 = p00 + 2.0 * p01 + p11 + ql
        n01 = p01 + p11
        n11 = p11 + qv
        p00, p01, p11 = n00, n01, n11
        innov = 0.0
        zscore = 0.0
        if z is not None:
            innov = z - x0
            s = p00 + r
            k0 = p00 / s
            k1 = p01 / s
            x0 = x0 + k0 * innov
            x1 = x1 + k1 * innov
            n00 = (1.0 - k0) * p00
            n01 = (1.0 - k0) * p01
            n11 = p11 - k1 * p01
            p00, p01, p11 = n00, n01, n11
            zscore = innov / math.sqrt(s)
        out.append((x0, x1, math.sqrt(max(p00, 0.0)), math.sqrt(max(p11, 0.0)), innov, zscore))
    return out


def _std(xs):
    if len(xs) < 2:
        return float("nan")
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))


def features_from_grid(g, kf, m, sport, three_way):
    """Feature dict at minute m (needs g[m] not None)."""
    p = g[m]

    def at(k):
        return g[k] if 0 <= k <= m and g[k] is not None else None

    def ret(lag):
        a = at(m - lag)
        return p - a if a is not None else float("nan")

    diffs = []
    for k in range(max(1, m - 29), m + 1):
        a, b = at(k), at(k - 1)
        if a is not None and b is not None:
            diffs.append((k, a - b))

    def vol(win):
        return _std([d for k, d in diffs if k > m - win])

    jumps = [abs(d) for k, d in diffs if k > m - 5]
    last_sign = 0.0
    run = 0
    for k, d in reversed(diffs):
        s = 1.0 if d > 1e-9 else -1.0 if d < -1e-9 else 0.0
        if s == 0.0:
            continue
        if last_sign == 0.0:
            last_sign = s
        if s != last_sign:
            break
        run += 1
    k = kf[m] if kf[m] is not None else (p, 0.0, float("nan"), float("nan"), 0.0, 0.0)
    f = {
        "p": p, "dist_mid": abs(p - 50.0),
        "ret_1": ret(1), "ret_2": ret(2), "ret_3": ret(3), "ret_5": ret(5), "ret_10": ret(10), "ret_20": ret(20),
        "absret_1": abs(ret(1)), "absret_3": abs(ret(3)), "absret_10": abs(ret(10)),
        "vol_5": vol(5), "vol_15": vol(15), "vol_30": vol(30),
        "maxjump_5": max(jumps) if jumps else float("nan"),
        "last_sign": last_sign, "run_len": float(run),
        "kf_level": k[0], "kf_vel": k[1], "kf_sd_level": k[2], "kf_sd_vel": k[3], "kf_innov": k[4], "kf_z": k[5],
        "minute": float(m), "three_way": 1.0 if three_way else 0.0,
    }
    for s in SPORTS:
        f[f"sport_{s}"] = 1.0 if sport == s else 0.0
    return f


def game_features(prices, start_sec, n_minutes, sport, three_way, params=DEFAULT_KALMAN):
    """All per-minute feature dicts for one game: [(minute, features)]."""
    g = grid(prices, start_sec, n_minutes)
    kf = kalman(g, params)
    return [(m, features_from_grid(g, kf, m, sport, three_way)) for m in range(n_minutes + 1) if g[m] is not None]


def fit_kalman(series_list, grid_q=(0.5, 1.0, 2.0, 4.0, 8.0), grid_v=(0.05, 0.2, 0.5, 1.0), grid_r=(1.0, 4.0, 8.0, 16.0)):
    """Pick (q_level, q_velocity, r) maximising the Gaussian innovation likelihood on training games."""
    best = None
    for ql in grid_q:
        for qv in grid_v:
            for r in grid_r:
                prm = {"q_level": ql, "q_velocity": qv, "r": r}
                ll = 0.0
                for g in series_list:
                    x0 = x1 = None
                    p00 = p01 = p11 = 0.0
                    for z in g:
                        if z is None:
                            continue
                        if x0 is None:
                            x0, x1, p00, p01, p11 = z, 0.0, r, 0.0, 1.0
                            continue
                        x0 += x1
                        p00, p01, p11 = p00 + 2 * p01 + p11 + ql, p01 + p11, p11 + qv
                        s = p00 + r
                        v = z - x0
                        ll += -0.5 * (math.log(2 * math.pi * s) + v * v / s)
                        k0, k1 = p00 / s, p01 / s
                        x0 += k0 * v
                        x1 += k1 * v
                        p00, p01, p11 = (1 - k0) * p00, (1 - k0) * p01, p11 - k1 * p01
                if best is None or ll > best[0]:
                    best = (ll, prm)
    return best[1]
