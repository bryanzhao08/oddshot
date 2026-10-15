"""Build the spike dataset from REAL Polymarket + Kalshi price history.

Phase 1 (download, cached in ml/data/raw/, safe to re-run):
  * Polymarket: gamma /events (active by 24h volume + recently closed by volume),
    up to 2 markets per event; CLOB /prices-history at 1-minute fidelity in
    <=7-day startTs/endTs chunks.
  * Kalshi: recently settled single markets (no MVE combos) by volume, capped per
    series; 1-minute candlesticks via the batch endpoint; price = bid/ask
    midpoint when both quoted, else last trade (mirrors server/sources/kalshi.js).
Phase 2 (build): replay the detector rule on a 1-minute grid, compute
point-in-time features (ml/features.py) and forward-looking labels.

Usage: ml/.venv/bin/python ml/collect.py [--build-only] [--pm-active N] [--pm-closed N] [--kalshi N] [--days D]
"""
import argparse
import concurrent.futures as cf
import hashlib
import json
import math
import os
import random
import sys
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from features import FEATURES, KALSHI_CATEGORY_MAP, compute_features, polymarket_category  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "data", "raw")
OUT = os.path.join(HERE, "data")
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
KALSHI = "https://api.elections.kalshi.com/trade-api/v2"

# detector replay parameters
MIN_DELTA = 0.03
WINDOW_MIN = 10
COOLDOWN_MIN = 10
MIN_PRIOR_MIN = 60
HORIZONS = (30, 60)

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "oddshot-ml-research/0.1"


def get_json(url, params=None, cache=True, tries=6):
    key = hashlib.sha1((url + json.dumps(params or {}, sort_keys=True)).encode()).hexdigest()
    path = os.path.join(RAW, key[:2], key + ".json")
    if cache and os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    for i in range(tries):
        try:
            r = SESSION.get(url, params=params, timeout=30)
            if r.status_code == 429 or r.status_code >= 500:
                raise RuntimeError(f"HTTP {r.status_code}")
            if r.status_code >= 400:
                data = {"__error": r.status_code}
                break
            data = r.json()
            break
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                print(f"  ! {url} {e}", file=sys.stderr)
                return None
            time.sleep(2.0 * 2**i)
    time.sleep(0.15)  # be polite
    if cache:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(data, f)
    return data


def parse_ts(s):
    if not s:
        return None
    s = str(s).replace(" ", "T")
    if s.endswith("+00"):
        s = s[:-3] + "Z"
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def jarr(v):
    if isinstance(v, list):
        return v
    try:
        a = json.loads(v)
        return a if isinstance(a, list) else []
    except Exception:  # noqa: BLE001
        return []


# ------------------------------------------------------------------ Polymarket
def pm_events(params, n_events):
    out, offset = [], 0
    while len(out) < n_events:
        page = get_json(f"{GAMMA}/events", {**params, "limit": 100, "offset": offset}, cache=False)
        if not page or not isinstance(page, list):
            break
        out.extend(page)
        if len(page) < 100:
            break
        offset += 100
    return out[:n_events]


def pm_select(events, closed, now_ms):
    markets = []
    for ev in events:
        tags = [str(t.get("slug") or "").lower() for t in (ev.get("tags") or []) if isinstance(t, dict)]
        ms = [m for m in (ev.get("markets") or []) if m.get("enableOrderBook") and m.get("clobTokenIds")]
        key = "volumeNum" if closed else "volume24hr"
        ms.sort(key=lambda m: -float(m.get(key) or m.get("volume") or 0))
        for m in ms[:2]:
            outs = [str(o).lower() for o in jarr(m.get("outcomes"))]
            toks = jarr(m.get("clobTokenIds"))
            if len(toks) < 1:
                continue
            i = outs.index("yes") if "yes" in outs else 0
            if i >= len(toks):
                continue
            text = f"{m.get('question') or ''} {ev.get('title') or ''}"
            end_ms = parse_ts(m.get("endDate") or ev.get("endDate"))
            stop_ms = now_ms
            if closed:
                stop_ms = parse_ts(m.get("closedTime")) or end_ms
                if not stop_ms or stop_ms > now_ms or stop_ms < now_ms - 60 * 86400_000:
                    continue
            markets.append({
                "market_id": f"polymarket:{m['id']}",
                "group": f"pm-event:{ev.get('id')}",
                "source": "polymarket",
                "title": m.get("question"),
                "category": polymarket_category(tags, text),
                "endDate_ms": end_ms,
                "stop_ms": stop_ms,
                "token": toks[i],
                "closed": closed,
            })
    return markets


def pm_history(mk, days):
    stop = int(mk["stop_ms"] // 1000)
    start = stop - days * 86400
    pts = {}
    s = start
    while s < stop:
        e = min(s + 7 * 86400, stop)
        # cache key includes absolute range; active markets re-download on new runs
        d = get_json(f"{CLOB}/prices-history", {"market": mk["token"], "startTs": s, "endTs": e, "fidelity": 1})
        for q in (d or {}).get("history", []) if isinstance(d, dict) else []:
            t = int(q["t"])
            if s <= t <= e:  # the API appends the live point; drop out-of-range
                pts[t] = float(q["p"])
        s = e
    return sorted(pts.items())


# ---------------------------------------------------------------------- Kalshi
def kalshi_markets(n, now_ms, days_back=45):
    cutoff = get_json(f"{KALSHI}/historical/cutoff", cache=False) or {}
    min_close = int(now_ms / 1000) - days_back * 86400
    c = parse_ts(cutoff.get("market_settled_ts"))
    if c:
        min_close = max(min_close, int(c / 1000) + 86400)
    series = get_json(f"{KALSHI}/series", cache=False) or {}
    ser_cat = {s.get("ticker"): str(s.get("category") or "").lower() for s in series.get("series", [])}
    now_s = int(now_ms / 1000)
    pool = []
    # sample several close-time windows so we don't only get the last few hours
    n_win = 8
    span = (now_s - min_close) // n_win
    for w in range(n_win):
        lo, hi = min_close + w * span, min_close + (w + 1) * span
        cursor = None
        for _ in range(3):
            params = {"status": "settled", "min_close_ts": lo, "max_close_ts": hi, "limit": 1000, "mve_filter": "exclude"}
            if cursor:
                params["cursor"] = cursor
            d = get_json(f"{KALSHI}/markets", params, cache=False)
            if not d or "markets" not in d:
                break
            pool.extend(d["markets"])
            cursor = d.get("cursor")
            if not cursor:
                break
    seen, per_series, per_event, out = set(), {}, set(), []
    pool.sort(key=lambda m: -float(m.get("volume_fp") or 0))
    for m in pool:
        t = m["ticker"]
        if t in seen or t.startswith("KXMVE") or m.get("market_type") not in (None, "binary"):
            continue
        seen.add(t)
        ev = m.get("event_ticker") or t
        ser = ev.split("-")[0]
        if ev in per_event or per_series.get(ser, 0) >= 6:
            continue
        close_ms = parse_ts(m.get("close_time"))
        open_ms = parse_ts(m.get("open_time"))
        if not close_ms or not open_ms or close_ms - open_ms < 12 * 3600_000:
            continue  # skip ultra-short (e.g. 15-minute crypto) markets: no 6h history
        per_event.add(ev)
        per_series[ser] = per_series.get(ser, 0) + 1
        out.append({
            "market_id": f"kalshi:{t}",
            "group": f"kalshi-event:{ev}",
            "source": "kalshi",
            "title": m.get("title"),
            "category": KALSHI_CATEGORY_MAP.get(ser_cat.get(ser, ""), "other"),
            "endDate_ms": close_ms,
            "stop_ms": min(close_ms, now_ms),
            "ticker": t,
            "closed": True,
        })
        if len(out) >= n:
            break
    return out


def _f(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def kalshi_history(mk, days):
    stop = int(mk["stop_ms"] // 1000)
    start = stop - days * 86400
    pts = {}
    s = start
    while s < stop:
        e = min(s + 6 * 86400, stop)  # <= 8640 candles < 10k cap
        d = get_json(f"{KALSHI}/markets/candlesticks",
                     {"market_tickers": mk["ticker"], "start_ts": s, "end_ts": e, "period_interval": 1})
        for grp in (d or {}).get("markets", []) if isinstance(d, dict) else []:
            for c in grp.get("candlesticks", []):
                bid = _f((c.get("yes_bid") or {}).get("close_dollars"))
                ask = _f((c.get("yes_ask") or {}).get("close_dollars"))
                last = _f((c.get("price") or {}).get("close_dollars"))
                if bid is not None and ask is not None and bid > 0 and ask > 0 and ask >= bid:
                    p = (bid + ask) / 2
                elif last is not None:
                    p = last
                else:
                    continue
                pts[int(c["end_period_ts"])] = p
        s = e
    return sorted(pts.items())


# ----------------------------------------------------------------------- build
def minute_grid(pts):
    """Clock-minute grid (ms) with last-observation-carried-forward values."""
    t = np.array([a for a, _ in pts], dtype=np.int64) * 1000
    p = np.array([b for _, b in pts], dtype=np.float64)
    g0 = (t[0] // 60000 + 1) * 60000
    g1 = (t[-1] // 60000) * 60000
    gt = np.arange(g0, g1 + 1, 60000, dtype=np.int64)
    idx = np.searchsorted(t, gt, side="right") - 1
    return t, p, gt, p[idx]


def build_rows(mk, pts):
    if len(pts) < MIN_PRIOR_MIN + 70:
        return []
    t, p, gt, gp = minute_grid(pts)
    rows, last_fire = [], -10**9
    n = len(gt)
    tf = t.astype(np.float64)
    for i in range(MIN_PRIOR_MIN, n - max(HORIZONS)):
        if i - last_fire < COOLDOWN_MIN:
            continue
        best_j, best = None, 0.0
        for j in range(i - 1, max(i - WINDOW_MIN, 0) - 1, -1):
            mv = abs(gp[i] - gp[j])
            if mv > best:
                best, best_j = mv, j
        if best_j is None or best < MIN_DELTA - 1e-9:
            continue
        last_fire = i
        T = int(gt[i])
        spike = {"from": float(gp[best_j]), "to": float(gp[i]), "windowMs": (i - best_j) * 60000, "detectedAt_ms": T}
        k = np.searchsorted(t, T, side="right")
        feats = compute_features(tf[:k], p[:k], spike, mk)
        delta = spike["to"] - spike["from"]
        sgn = 1.0 if delta > 0 else -1.0
        row = {
            "market_id": mk["market_id"], "group": mk["group"], "source": mk["source"],
            "category": mk["category"], "title": mk["title"], "t_ms": T,
            "from": spike["from"], "to": spike["to"], "windowMs": spike["windowMs"],
            "endDate_ms": mk["endDate_ms"],
        }
        for h in HORIZONS:
            ret = sgn * (gp[i + h] - spike["from"]) / abs(delta)
            row[f"retain_{h}"] = float(ret)
            row[f"y{h}"] = int(ret >= 0.5)
        row.update(dict(zip(FEATURES, feats)))
        rows.append(row)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pm-active", type=int, default=200, help="active Polymarket events")
    ap.add_argument("--pm-closed", type=int, default=300, help="recently closed Polymarket events")
    ap.add_argument("--kalshi", type=int, default=150, help="settled Kalshi markets")
    ap.add_argument("--days", type=int, default=14, help="days of history per market")
    ap.add_argument("--build-only", action="store_true", help="reuse ml/data/markets.json + raw cache")
    args = ap.parse_args()
    os.makedirs(RAW, exist_ok=True)
    now_ms = time.time() * 1000
    mpath = os.path.join(OUT, "markets.json")

    if args.build_only and os.path.exists(mpath):
        with open(mpath) as f:
            markets = json.load(f)
    else:
        print("listing Polymarket events ...")
        act = pm_events({"active": "true", "closed": "false", "order": "volume24hr", "ascending": "false"}, args.pm_active)
        since = datetime.fromtimestamp(now_ms / 1000 - 60 * 86400, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        clo = pm_events({"closed": "true", "order": "volume", "ascending": "false", "end_date_min": since}, args.pm_closed)
        markets = pm_select(act, False, now_ms) + pm_select(clo, True, now_ms)
        print(f"  {len(markets)} polymarket markets")
        print("listing Kalshi markets ...")
        try:
            km = kalshi_markets(args.kalshi, now_ms)
        except Exception as e:  # noqa: BLE001
            print("  kalshi listing failed:", e)
            km = []
        print(f"  {len(km)} kalshi markets")
        markets += km
        seen, uniq = set(), []
        for m in markets:
            if m["market_id"] not in seen:
                seen.add(m["market_id"])
                uniq.append(m)
        markets = uniq
        with open(mpath, "w") as f:
            json.dump(markets, f)
        with open(os.path.join(OUT, "collect_meta.json"), "w") as f:
            json.dump({"days": args.days, "collected_at_ms": now_ms}, f)

    def work(mk):
        try:
            pts = pm_history(mk, args.days) if mk["source"] == "polymarket" else kalshi_history(mk, args.days)
            return build_rows(mk, pts), len(pts)
        except Exception as e:  # noqa: BLE001
            print("  !", mk["market_id"], e, file=sys.stderr)
            return [], 0

    rows, done, npts = [], 0, 0
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        for r, n in ex.map(work, markets):
            rows.extend(r)
            npts += n
            done += 1
            if done % 25 == 0:
                print(f"  {done}/{len(markets)} markets, {npts} points, {len(rows)} candidates", flush=True)
    df = pd.DataFrame(rows)
    df.to_parquet(os.path.join(OUT, "spikes.parquet"), index=False)
    print(f"saved {len(df)} candidate spikes from {df['market_id'].nunique() if len(df) else 0} markets "
          f"({npts} price points); base rate y30={df['y30'].mean():.3f} y60={df['y60'].mean():.3f}")


if __name__ == "__main__":
    random.seed(0)
    main()
