"""Build the Moment Forecaster dataset from the cached raw 1-minute histories.

Phase 1 (metadata, cached in ml/data/forecast_meta.json):
  * Polymarket: gamma /markets?id=... (startTime = gameStartTime || eventStartTime
    || events[0].startTime, endDate) -- the same chain the live source uses.
  * Kalshi: /markets/{ticker} (endDate = expected_expiration_time || close_time,
    exactly what server/sources/kalshi.js serves; the settled close_time would
    leak the actual, often early, resolution time).
Phase 2 (rows): decision times every 10 min on the clock-minute grid of each
market, skipping the first 6h of each series and any time whose 30-min label
window runs past the end of the data; rows whose last hour is pinned at
<= 0.02 / >= 0.98 are dropped (resolved / dead markets).
  * label y = max_{k=1..30 min} |p(T+k) - p(T)| >= 0.05 ; max_move kept for regression.
  * ~15% of rows get a truncated history (30-360 min, deterministic hash) so the
    model also sees the short histories the live server has after a cold start.

Usage: ml/.venv/bin/python ml/forecast_data.py [--refresh-meta] [--step 10]
"""
import argparse
import concurrent.futures as cf
import hashlib
import json
import multiprocessing as mp
import os
import sys
import time

import numpy as np
import pandas as pd
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from collect import kalshi_history, parse_ts, pm_history  # noqa: E402
from forecast_features import FEATURES, compute_features, grid_for, is_pinned  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
META = os.path.join(DATA, "forecast_meta.json")
OUT = os.path.join(DATA, "forecast.parquet")
GAMMA = "https://gamma-api.polymarket.com"
KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
HORIZON_MIN = 30
BIG_MOVE = 0.05
SKIP_MIN = 360
TRUNC_FRAC = 0.15


def h01(s):
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def _get(url, params=None, tries=5):
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=30, headers={"User-Agent": "oddshot-ml-research/0.1"})
            if r.status_code == 429 or r.status_code >= 500:
                raise RuntimeError(f"HTTP {r.status_code}")
            return r.json() if r.status_code < 400 else None
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                print("  !", url, e, file=sys.stderr)
                return None
            time.sleep(1.5 * 2**i)


def fetch_meta(markets):
    meta = {}
    pm = [m for m in markets if m["source"] == "polymarket"]
    ids = [m["market_id"].split(":", 1)[1] for m in pm]
    batches = [ids[i:i + 25] for i in range(0, len(ids), 25)]

    def pm_batch(b):
        out = []
        for closed in ("true", "false"):
            d = _get(f"{GAMMA}/markets", [("id", x) for x in b] + [("closed", closed), ("limit", 100)])
            out.extend(d if isinstance(d, list) else [])
        return out

    def km(m):
        d = _get(f"{KALSHI}/markets/{m['ticker']}")
        return m["market_id"], (d or {}).get("market")

    with cf.ThreadPoolExecutor(4) as ex:
        for res in ex.map(pm_batch, batches):
            for g in res:
                ev = (g.get("events") or [{}])[0] or {}
                st = g.get("gameStartTime") or g.get("eventStartTime") or ev.get("startTime")
                meta[f"polymarket:{g['id']}"] = {"startTime_ms": parse_ts(st), "endDate_ms": parse_ts(g.get("endDate")),
                                                 "gameStartTime": g.get("gameStartTime"),
                                                 "eventStartTime": g.get("eventStartTime"),
                                                 "evStartTime": ev.get("startTime")}
        for mid, k in ex.map(km, [m for m in markets if m["source"] == "kalshi"]):
            if k:
                meta[mid] = {"startTime_ms": None,
                             "endDate_ms": parse_ts(k.get("expected_expiration_time") or k.get("close_time"))}
    return meta


def build_market(args):
    mk, days, step = args
    try:
        pts = pm_history(mk, days) if mk["source"] == "polymarket" else kalshi_history(mk, days)
    except Exception as e:  # noqa: BLE001
        print("  !", mk["market_id"], e, file=sys.stderr)
        return []
    if len(pts) < SKIP_MIN + HORIZON_MIN + 10:
        return []
    ts = np.array([a for a, _ in pts], dtype=np.float64) * 1000
    ps = np.array([b for _, b in pts], dtype=np.float64)
    g0 = (int(ts[0]) // 60000 + 1) * 60000
    g1 = (int(ts[-1]) // 60000) * 60000
    gt = np.arange(g0, g1 + 1, 60000, dtype=np.int64)
    gp = ps[np.searchsorted(ts, gt.astype(np.float64), side="right") - 1]
    market = {"source": mk["source"], "category": mk["category"],
              "endDate_ms": mk.get("endDate_ms"), "startTime_ms": mk.get("startTime_ms")}
    rows = []
    n = len(gt)
    # decision times on a 10-minute clock grid
    first = SKIP_MIN
    while first < n and (gt[first] // 60000) % step:
        first += 1
    for i in range(first, n - HORIZON_MIN, step):
        T = int(gt[i])
        hist_lo = None
        u = h01(f"{mk['market_id']}|{T}")
        if u < TRUNC_FRAC:
            hist_min = 30 + int((u / TRUNC_FRAC) * 330)
            hist_lo = T - hist_min * 60000
        if hist_lo is None:
            g = grid_for(ts, ps, T)
        else:
            k0 = int(np.searchsorted(ts, hist_lo, side="left"))
            g = grid_for(ts[k0:], ps[k0:], T)
        if np.isnan(g[-1]) or is_pinned(g):
            continue
        fut = gp[i + 1:i + 1 + HORIZON_MIN]
        mv = float(np.max(np.abs(fut - gp[i])))
        feats = compute_features(g, T, market)
        row = {"market_id": mk["market_id"], "group": mk["group"], "source": mk["source"],
               "category": mk["category"], "t_ms": T, "hist_lo_ms": hist_lo if hist_lo is not None else -1,
               "trunc": hist_lo is not None, "max_move": mv, "y": int(mv >= BIG_MOVE - 1e-9)}
        row.update(dict(zip(FEATURES, feats)))
        rows.append(row)
    return rows


def load_markets(refresh=False):
    with open(os.path.join(DATA, "markets.json")) as f:
        markets = json.load(f)
    if refresh or not os.path.exists(META):
        print("fetching market metadata ...")
        meta = fetch_meta(markets)
        with open(META, "w") as f:
            json.dump(meta, f)
    with open(META) as f:
        meta = json.load(f)
    miss = 0
    for m in markets:
        md = meta.get(m["market_id"])
        if md is None:
            miss += 1
            m["startTime_ms"] = None
            continue
        m["startTime_ms"] = md.get("startTime_ms")
        if md.get("endDate_ms"):
            m["endDate_ms"] = md["endDate_ms"]
    print(f"metadata for {len(markets) - miss}/{len(markets)} markets; "
          f"{sum(1 for m in markets if m.get('startTime_ms'))} with a start time")
    return markets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh-meta", action="store_true")
    ap.add_argument("--step", type=int, default=10)
    args = ap.parse_args()
    markets = load_markets(args.refresh_meta)
    days = json.load(open(os.path.join(DATA, "collect_meta.json"))).get("days", 14)
    rows, done = [], 0
    with mp.Pool(8) as pool:
        for r in pool.imap_unordered(build_market, [(m, days, args.step) for m in markets], chunksize=4):
            rows.extend(r)
            done += 1
            if done % 100 == 0:
                print(f"  {done}/{len(markets)} markets, {len(rows)} rows", flush=True)
    df = pd.DataFrame(rows).sort_values(["t_ms", "market_id"]).reset_index(drop=True)
    df.to_parquet(OUT, index=False)
    print(f"saved {len(df)} rows from {df.market_id.nunique()} markets / {df.group.nunique()} groups; "
          f"base rate {df.y.mean():.4f}; mean max_move {df.max_move.mean():.4f}")


if __name__ == "__main__":
    main()
