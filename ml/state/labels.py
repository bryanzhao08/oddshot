"""Workstream B: per-minute true game-state labels from ESPN play-by-play.

    labels_for(espn_sport, espn_league, event_id, side) -> DataFrame
        [minute_utc, state, period, game_clock, score_us, score_them]

`side` is "home" or "away": the ESPN side the Polymarket price refers to ("us").
Every ESPN summary response is cached under ml/state/data/raw/espn/.

CLI:
    ml/.venv/bin/python ml/state/labels.py                 # all games in data/markets.parquet
    ml/.venv/bin/python ml/state/labels.py --event football nfl 401872996 home   # one game, print timeline

See ml/state/README.md for the exact rules per sport.
"""
from __future__ import annotations

import argparse
import bisect
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd
import requests

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
RAW = DATA / "raw" / "espn"
SUMMARY_URL = "https://site.web.api.espn.com/apis/site/v2/sports/{sport}/{league}/summary?event={eid}"
MAX_CONCURRENCY = 8
COLUMNS = ["minute_utc", "state", "period", "game_clock", "score_us", "score_them"]

# ---------------------------------------------------------------------------
# Fetch + cache
# ---------------------------------------------------------------------------
_sem = threading.BoundedSemaphore(MAX_CONCURRENCY)
_local = threading.local()


def _session() -> requests.Session:
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = "oddshot-research/1.0"
        _local.s = s
    return s


def cache_path(sport: str, league: str, eid) -> Path:
    return RAW / f"{sport}_{league}_{eid}.json"


def fetch_summary(sport: str, league: str, eid, refresh: bool = False, retries: int = 5) -> dict:
    """Return the ESPN summary JSON, from disk cache if present (every response is cached)."""
    p = cache_path(sport, league, eid)
    if p.exists() and not refresh:
        return json.loads(p.read_text())
    RAW.mkdir(parents=True, exist_ok=True)
    url = SUMMARY_URL.format(sport=sport, league=league, eid=eid)
    last = None
    for attempt in range(retries):
        try:
            with _sem:
                r = _session().get(url, timeout=30)
            if r.status_code == 200:
                p.write_text(r.text)
                return r.json()
            last = f"HTTP {r.status_code}"
            if r.status_code in (400, 404):
                break
        except requests.RequestException as e:  # network hiccup
            last = repr(e)
        time.sleep(min(30, 1.5 * 2 ** attempt))
    raise RuntimeError(f"ESPN summary failed {sport}/{league}/{eid}: {last}")


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------
def _ts(s) -> pd.Timestamp | None:
    if not s:
        return None
    try:
        return pd.Timestamp(s).tz_convert("UTC") if pd.Timestamp(s).tzinfo else pd.Timestamp(s).tz_localize("UTC")
    except (ValueError, TypeError):
        return None


def _teams(d: dict) -> dict:
    """{'home': {...}, 'away': {...}} with id, names, final score."""
    out = {}
    for c in d["header"]["competitions"][0]["competitors"]:
        t = c.get("team", {})
        out[c["homeAway"]] = {
            "id": str(t.get("id", c.get("id"))),
            "names": {n for n in (t.get("displayName"), t.get("shortDisplayName"), t.get("name"),
                                  t.get("location"), t.get("abbreviation")) if n},
            "displayName": t.get("displayName", ""),
            "score": int(c["score"]) if str(c.get("score", "")).isdigit() else None,
        }
    return out


def _side_of_team_id(teams: dict, tid) -> str | None:
    if tid is None:
        return None
    tid = str(tid)
    for s in ("home", "away"):
        if teams[s]["id"] == tid:
            return s
    return None


def _side_of_team_name(teams: dict, name) -> str | None:
    if not name:
        return None
    for s in ("home", "away"):
        if name in teams[s]["names"]:
            return s
    return None


MAX_CLUMP_FRAC = 0.25  # > 25% of plays sharing a timestamp with >= 4 others -> batch-stamped, unusable
MIN_IN_WINDOW = 0.7     # >= 70% of plays must carry a wallclock within [start - 1h, start + 8h]


def _monotone(events: list[dict], d: dict) -> list[dict]:
    """Validate wallclocks, sort by ESPN array order (sequenceNumber is per-at-bat in MLB) and
    force non-decreasing timestamps. Writes a quality verdict to d['_quality']."""
    n_all = len(events)
    start = _ts(((d.get("header") or {}).get("competitions") or [{}])[0].get("date"))
    if start is not None:
        lo, hi = start - pd.Timedelta(hours=1), start + pd.Timedelta(hours=8)
        events = [e for e in events if e.get("ts") is not None and lo <= e["ts"] <= hi]
    else:
        events = [e for e in events if e.get("ts") is not None]
    cnt: dict = {}
    for e in events:
        cnt[e["ts"]] = cnt.get(e["ts"], 0) + 1
    clump = sum(v for v in cnt.values() if v >= 5) / max(1, len(events))
    q = {"n_plays": n_all, "n_wallclock_ok": len(events), "clump_frac": round(clump, 3), "ok": True, "reason": ""}
    if n_all == 0 or len(events) < MIN_IN_WINDOW * n_all:
        q.update(ok=False, reason="missing/out-of-window wallclock")
    elif clump > MAX_CLUMP_FRAC:
        q.update(ok=False, reason="batch-stamped wallclock")
    d["_quality"] = q
    events.sort(key=lambda e: e["seq"])
    # Plays edited after the fact sometimes carry a much later wallclock (and the later score).
    # Keep the longest non-decreasing subsequence of timestamps; every other play gets the
    # previous kept timestamp and its score fields are ignored.
    keep = _lnds([e["ts"].value for e in events])
    prev = None
    for k, e in enumerate(events):
        if k in keep:
            prev = e["ts"]
        else:
            e["ts"] = prev if prev is not None else e["ts"]
            e["home"] = e["away"] = None
            e["ts_fixed"] = True
    m = None
    for e in events:
        if m is not None and e["ts"] < m:
            e["ts"] = m
        m = e["ts"]
    for k in ("home", "away"):  # scores never go down
        mx = 0
        for e in events:
            v = e.get(k)
            if v is None:
                e[k] = mx
            else:
                mx = max(mx, int(v))
                e[k] = mx
    return events


def _lnds(vals: list[int]) -> set[int]:
    """Indices of one longest non-decreasing subsequence (patience sorting, O(n log n))."""
    tails, tails_idx, parent = [], [], [-1] * len(vals)
    for i, v in enumerate(vals):
        j = bisect.bisect_right(tails, v)
        if j == len(tails):
            tails.append(v)
            tails_idx.append(i)
        else:
            tails[j] = v
            tails_idx[j] = i
        parent[i] = tails_idx[j - 1] if j > 0 else -1
    out, k = set(), tails_idx[-1] if tails_idx else -1
    while k >= 0:
        out.add(k)
        k = parent[k]
    return out


def _minute_grid(events: list[dict]) -> list[pd.Timestamp]:
    if not events:
        return []
    start = events[0]["ts"].ceil("min")
    end = events[-1]["ts"].ceil("min")
    return list(pd.date_range(start, end, freq="min"))


class Timeline:
    """Bisect helper over time-sorted events."""

    def __init__(self, events):
        self.ev = events
        self.t = [e["ts"].value for e in events]

    def last_idx(self, t: pd.Timestamp) -> int:
        """index of last event with ts <= t, or -1."""
        return bisect.bisect_right(self.t, t.value) - 1

    def window(self, t: pd.Timestamp, seconds: float):
        """events with t - seconds < ts <= t (half-open, so a W-second window covers W/60 minute marks)."""
        lo = bisect.bisect_right(self.t, t.value - int(seconds * 1e9))
        hi = bisect.bisect_right(self.t, t.value)
        return self.ev[lo:hi]


def _latest(items, pred):
    for e in reversed(items):
        if pred(e):
            return e
    return None


def _scoring_events(events: list[dict]) -> list[dict]:
    """Events where the (monotone) score of a side increased; e['scorer'] = side."""
    out = []
    ph = pa = 0
    for e in events:
        dh, da = e["home"] - ph, e["away"] - pa
        if dh > 0 or da > 0:
            out.append({**e, "scorer": "home" if dh >= da else "away"})
        ph, pa = e["home"], e["away"]
    return out


def _rows(grid, states, events, tl, side, clock_fn):
    other = "away" if side == "home" else "home"
    rows = []
    for t, st in zip(grid, states):
        i = tl.last_idx(t)
        e = events[i] if i >= 0 else events[0]
        rows.append({
            "minute_utc": t, "state": st, "period": e.get("period"),
            "game_clock": clock_fn(e), "score_us": int(e[side]) if i >= 0 else 0,
            "score_them": int(e[other]) if i >= 0 else 0,
        })
    return pd.DataFrame(rows, columns=COLUMNS)


def _us(side_x, side):
    return "us" if side_x == side else "them"


# ---------------------------------------------------------------------------
# Football (NFL / CFB)
# ---------------------------------------------------------------------------
FB_ADMIN = {"timeout", "official timeout", "two-minute warning", "end period", "end of half",
            "end of game", "end of regulation", "coin toss", "end quarter"}
FB_PERIOD_END = {"end period", "end of half", "end of regulation", "end quarter"}
FB_TURNOVER_RESULTS = ("INT", "FUMBLE", "DOWNS")  # substrings of drive.result
STOPPAGE_GAP_S = 150  # football: no snap for > 2.5 min -> stoppage


def _football(d, side):
    teams = _teams(d)
    drives = (d.get("drives") or {}).get("previous") or []
    events, turnovers = [], []
    i = 0
    for dr in drives:
        dteam = _side_of_team_id(teams, (dr.get("team") or {}).get("id"))
        dplays = []
        for p in dr.get("plays", []):
            i += 1
            typ = (p.get("type") or {}).get("text", "").strip().lower()
            st, en = p.get("start") or {}, p.get("end") or {}
            pos_tid = (en.get("team") or {}).get("id") or (st.get("team") or {}).get("id")
            yte = en.get("yardsToEndzone")
            if yte is None:
                yte = st.get("yardsToEndzone")
            e = {
                "ts": _ts(p.get("wallclock")), "seq": float(i),
                "home": p.get("homeScore"), "away": p.get("awayScore"),
                "period": (p.get("period") or {}).get("number"),
                "clock": (p.get("clock") or {}).get("displayValue", ""),
                "type": typ, "admin": typ in FB_ADMIN or typ.startswith("end "),
                "period_end": typ in FB_PERIOD_END or typ.startswith("end of q"),
                "pos": _side_of_team_id(teams, pos_tid), "yte": yte, "text": p.get("text", ""),
            }
            events.append(e)
            dplays.append(e)
        res = str(dr.get("result") or dr.get("displayResult") or "").upper()
        if dteam and any(k in res for k in FB_TURNOVER_RESULTS):
            real = [e for e in dplays if not e["admin"] and e["ts"] is not None]
            hit = _latest(real, lambda e: "intercept" in e["type"] or "fumble" in e["type"]) or (real[-1] if real else None)
            if hit is not None:
                turnovers.append({"ts_ref": hit, "loser": dteam})
    events = _monotone(events, d)
    if not events:
        return None
    tl = Timeline(events)
    scores = _scoring_events(events)
    stl = Timeline(scores)
    tos = [{"ts": t["ts_ref"]["ts"], "seq": 0, "loser": t["loser"]} for t in turnovers if t["ts_ref"].get("ts") is not None]
    tos.sort(key=lambda x: x["ts"])
    ttl = Timeline(tos)
    real_idx = [k for k, e in enumerate(events) if not e["admin"]]
    real_t = [events[k]["ts"].value for k in real_idx]
    grid = _minute_grid(events)
    states = []
    for t in grid:
        sc = stl.window(t, 120)
        if sc:
            states.append(_us(sc[-1]["scorer"], side) + "_scored")
            continue
        to = ttl.window(t, 120)
        if to:
            states.append("turnover_" + _us(to[-1]["loser"], side))
            continue
        last = events[tl.last_idx(t)]
        j = bisect.bisect_right(real_t, t.value) - 1
        lastreal = events[real_idx[j]] if j >= 0 else None
        if last["admin"] or lastreal is None or (t.value - lastreal["ts"].value) > STOPPAGE_GAP_S * 1e9:
            states.append("stoppage")
            continue
        who = _us(lastreal["pos"], side) if lastreal["pos"] else None
        if who is None:
            states.append("stoppage")
            continue
        sp = lastreal["yte"] is not None and 0 < lastreal["yte"] <= 30
        states.append(f"{who}_scoring_position" if sp else f"{who}_offense")
    return _rows(grid, states, events, tl, side, lambda e: f"Q{e['period']} {e['clock']}")


# ---------------------------------------------------------------------------
# Soccer
# ---------------------------------------------------------------------------
def _soccer(d, side):
    teams = _teams(d)
    raw = {}
    for k in d.get("keyEvents") or []:
        raw[str(k.get("id"))] = k
    for c in d.get("commentary") or []:
        p = c.get("play")
        if p and p.get("id") is not None:
            raw.setdefault(str(p["id"]), p)
    events = []
    for i, (pid, p) in enumerate(raw.items()):
        if p.get("shootout"):
            continue
        typ = ((p.get("type") or {}).get("text") or "").strip()
        tl_ = typ.lower()
        text = p.get("text") or ""
        team = p.get("team") or {}
        s = _side_of_team_id(teams, team.get("id")) or _side_of_team_name(teams, team.get("displayName"))
        e = {"ts": _ts(p.get("wallclock")), "seq": 0.0, "pid": pid, "type": tl_, "text": text, "team": s,
             "period": (p.get("period") or {}).get("number"),
             "clock": (p.get("clock") or {}).get("displayValue", ""), "home": None, "away": None}
        if e["ts"] is None:
            continue
        is_goal = bool(p.get("scoringPlay")) or tl_.startswith("goal") or tl_.startswith("own goal") or tl_ == "penalty - scored"
        e["goal"] = is_goal
        e["attack"] = (("shot" in tl_ or tl_.startswith("goal") or tl_.startswith("penalty -")) and "own goal" not in tl_) or tl_ == "corner awarded"
        e["red"] = "red card" in tl_ or "second yellow" in tl_ or "yellow red" in tl_
        e["half_end"] = tl_ in ("halftime", "end regular time", "end extra time first half", "end of extra time first half") or bool(re.search(r"\b(first|second) half ends|half ends|extra time ends", text, re.I))
        e["half_start"] = tl_ in ("kickoff", "start 2nd half") or tl_.startswith("start ") and "half" in tl_ or bool(re.search(r"\bhalf begins|extra time begins", text, re.I))
        if is_goal:
            h, a = _parse_soccer_score(text, teams)
            if h is not None:
                e["home"], e["away"] = h, a
            elif s:  # fall back to attribution (+1 to the attributed team, flipped for own goals)
                e["delta"] = s if "own goal" not in tl_ else ("away" if s == "home" else "home")
        events.append(e)
    events.sort(key=lambda e: e["ts"])
    for k, e in enumerate(events):
        e["seq"] = float(k)
    # carry scores forward, applying fallback deltas
    h = a = 0
    for e in events:
        if e["home"] is not None:
            h, a = max(h, e["home"]), max(a, e["away"])
        elif e.get("delta"):
            if e["delta"] == "home":
                h += 1
            else:
                a += 1
        e["home"], e["away"] = h, a
    events = _monotone(events, d)
    if not events:
        return None
    tl = Timeline(events)
    scores = _scoring_events(events)
    stl = Timeline(scores)
    attacks = [e for e in events if e["attack"] and e["team"]]
    atl = Timeline(attacks)
    reds = [e for e in events if e["red"] and e["team"]]
    rtl = Timeline(reds)
    # halftime intervals: half_end -> next half_start
    breaks = []
    for k, e in enumerate(events):
        if e["half_end"]:
            nxt = next((x for x in events[k + 1:] if x["half_start"]), None)
            if nxt is not None:
                breaks.append((e["ts"].value, nxt["ts"].value))
    grid = _minute_grid(events)
    states = []
    for t in grid:
        tv = t.value
        if any(a_ <= tv < b_ for a_, b_ in breaks):
            states.append("halftime")
            continue
        sc = stl.window(t, 120)
        if sc:
            states.append(_us(sc[-1]["scorer"], side) + "_scored")
            continue
        rc = rtl.window(t, 180)
        if rc:
            states.append("red_card_" + _us(rc[-1]["team"], side))
            continue
        w = atl.window(t, 240)
        nu = sum(1 for e in w if e["team"] == side)
        nt = len(w) - nu
        if nu >= 2 and nt == 0:
            states.append("us_pressing")
        elif nt >= 2 and nu == 0:
            states.append("them_pressing")
        else:
            states.append("open")
    return _rows(grid, states, events, tl, side, lambda e: f"H{e['period']} {e['clock']}")


def _parse_soccer_score(text: str, teams: dict):
    """'Goal! Nottingham Forest 0, Arsenal 1. ...' -> (home, away)."""
    hn, an = teams["home"]["displayName"], teams["away"]["displayName"]
    m = re.search(re.escape(hn) + r"\s+(\d+),\s+" + re.escape(an) + r"\s+(\d+)", text)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r"[A-Za-z][^,.!]*?\s(\d+),\s[^,.!]*?\s(\d+)\.", text)  # generic "X n, Y m."
    if m:
        return int(m.group(1)), int(m.group(2))
    return None, None


# ---------------------------------------------------------------------------
# Baseball (MLB)
# ---------------------------------------------------------------------------
def _baseball(d, side):
    plays = d.get("plays") or []
    events = []
    for i, p in enumerate(plays):
        per = p.get("period") or {}
        half = per.get("type")  # Top / Bottom / Mid / End
        typ = ((p.get("type") or {}).get("type") or (p.get("type") or {}).get("text") or "").lower()
        e = {"ts": _ts(p.get("wallclock")), "seq": float(i), "half": half,
             "period": per.get("number"), "outs": p.get("outs"), "type": typ,
             "risp": ("onSecond" in p) or ("onThird" in p), "summary": p.get("summaryType"),
             # ESPN pre-fills the post-at-bat score on 'Start Batter' rows, so only trust scoring rows
             "home": p.get("homeScore") if p.get("scoringPlay") else None,
             "away": p.get("awayScore") if p.get("scoringPlay") else None}
        events.append(e)
    events = _monotone(events, d)
    if not events:
        return None
    outs = 0  # ESPN pre-fills post-at-bat outs on 'Start Batter' rows too; trust play results only
    for e in events:
        if e["type"] in ("start-inning",) or e["half"] not in ("Top", "Bottom"):
            outs = 0
        elif e["type"] in ("play-result", "play result") and e["outs"] is not None:
            outs = e["outs"]
        e["outs"] = outs
    # a half-inning is "live" from its first batter/pitch row; Start Inning rows and pitching
    # changes before that are still part of the break between innings
    live = False
    for e in events:
        if e["type"] in ("start-inning",) or e["half"] not in ("Top", "Bottom"):
            live = False
        elif e["summary"] in ("A", "P"):
            live = True
        e["live"] = live
    tl = Timeline(events)
    stl = Timeline(_scoring_events(events))
    grid = _minute_grid(events)
    states = []
    for t in grid:
        sc = stl.window(t, 120)
        if sc:
            states.append(_us(sc[-1]["scorer"], side) + "_scored")
            continue
        e = events[tl.last_idx(t)]
        if e["half"] not in ("Top", "Bottom") or not e["live"]:
            states.append("between_innings")
            continue
        bat = "away" if e["half"] == "Top" else "home"
        states.append(_us(bat, side) + ("_batting_risp" if e["risp"] else "_batting"))
    return _rows(grid, states, events, tl, side,
                 lambda e: f"{e['half']} {e['period']}" + (f", {e['outs']} out" if e["half"] in ("Top", "Bottom") else ""))


# ---------------------------------------------------------------------------
# Hockey (NHL)
# ---------------------------------------------------------------------------
def _hockey(d, side):
    teams = _teams(d)
    plays = d.get("plays") or []
    events = []
    for i, p in enumerate(plays):
        ty = p.get("type") or {}
        abbr = (ty.get("abbreviation") or ty.get("text") or "").lower()
        e = {"ts": _ts(p.get("wallclock")), "seq": float(i),
             "home": p.get("homeScore"), "away": p.get("awayScore"),
             "period": (p.get("period") or {}).get("number"),
             "clock": (p.get("clock") or {}).get("displayValue", ""), "type": abbr,
             "team": _side_of_team_id(teams, (p.get("team") or {}).get("id")),
             "strength": ((p.get("strength") or {}).get("abbreviation") or "").lower(),
             "penalty": (ty.get("penaltyType") or "") if "penaltyType" in ty else None}
        events.append(e)
    events = _monotone(events, d)
    if not events:
        return None
    # power-play owner after each event
    pp = None
    for e in events:
        if e["penalty"] is not None and e["team"]:
            if e["penalty"].lower() not in ("misconduct", "game misconduct", "penalty shot"):  # no PP
                other = "away" if e["team"] == "home" else "home"
                pp = other if pp in (None, other) else None  # offsetting -> even
        elif not e["team"]:
            pass  # team-less rows (stoppages, TV timeouts) carry the strength from *before* a penalty
        elif e["strength"] in ("power-play", "short-handed"):
            pp = e["team"] if e["strength"] == "power-play" else ("away" if e["team"] == "home" else "home")
        elif e["strength"] == "even-strength":
            pp = None
        if e["type"] in ("goal",) and e["strength"] == "power-play":
            pp = None  # minor ends on PP goal
        e["pp"] = pp
    tl = Timeline(events)
    stl = Timeline(_scoring_events(events))
    grid = _minute_grid(events)
    states = []
    for t in grid:
        e = events[tl.last_idx(t)]
        if e["type"] in ("period-end",):
            states.append("intermission")
            continue
        sc = stl.window(t, 120)
        if sc:
            states.append(_us(sc[-1]["scorer"], side) + "_scored")
            continue
        if e["pp"]:
            states.append(_us(e["pp"], side) + "_power_play")
        else:
            states.append("even")
    return _rows(grid, states, events, tl, side, lambda e: f"P{e['period']} {e['clock']}")


# ---------------------------------------------------------------------------
# Basketball (NBA)
# ---------------------------------------------------------------------------
def _basketball(d, side):
    plays = d.get("plays") or []
    events = []
    for i, p in enumerate(plays):
        typ = ((p.get("type") or {}).get("text") or "").lower()
        events.append({"ts": _ts(p.get("wallclock")), "seq": float(i),
                       "home": p.get("homeScore"), "away": p.get("awayScore"),
                       "period": (p.get("period") or {}).get("number"),
                       "clock": (p.get("clock") or {}).get("displayValue", ""), "type": typ,
                       "period_end": typ in ("end period", "end game") or typ.startswith("end of"),
                       "timeout": "timeout" in typ,
                       "dead": "timeout" in typ or "substitution" in typ or typ.startswith("end")
                       or typ.startswith("start") or "challenge" in typ or "replay" in typ})
    events = _monotone(events, d)
    if not events:
        return None
    other = "away" if side == "home" else "home"
    tl = Timeline(events)
    # lead changes: strict leader switches (ties skipped)
    lc, leader = [], None
    for e in events:
        diff = e[side] - e[other]
        cur = "us" if diff > 0 else "them" if diff < 0 else None
        if cur and leader and cur != leader:
            lc.append(e)
        if cur:
            leader = cur
    # between periods = from 'End Period' until the first live play of the next period
    # (substitutions / timeouts logged during the break don't end it)
    brk = False
    for e in events:
        if e["period_end"]:
            brk = True
        elif not e["dead"]:
            brk = False
        e["between_periods"] = brk
    ltl = Timeline(lc)
    grid = _minute_grid(events)
    states = []
    for t in grid:
        i = tl.last_idx(t)
        e = events[i]
        if e["between_periods"]:
            states.append("break")
            continue
        if ltl.window(t, 120):
            states.append("lead_change")
            continue
        j = tl.last_idx(t - pd.Timedelta(seconds=180))
        us0, th0 = (events[j][side], events[j][other]) if j >= 0 else (0, 0)
        run = (e[side] - us0) - (e[other] - th0)
        if run >= 6:
            states.append("us_run")
        elif run <= -6:
            states.append("them_run")
        elif e["timeout"]:
            states.append("break")
        else:
            states.append("even")
    return _rows(grid, states, events, tl, side, lambda e: f"Q{e['period']} {e['clock']}")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
SPORT_FN = {"football": _football, "soccer": _soccer, "baseball": _baseball,
            "hockey": _hockey, "basketball": _basketball}
SPORT_CLASSES = {
    "football": ["us_scoring_position", "us_offense", "them_offense", "them_scoring_position",
                 "us_scored", "them_scored", "turnover_us", "turnover_them", "stoppage"],
    "soccer": ["us_pressing", "them_pressing", "us_scored", "them_scored", "red_card_us",
               "red_card_them", "open", "halftime"],
    "baseball": ["us_batting_risp", "us_batting", "them_batting_risp", "them_batting",
                 "us_scored", "them_scored", "between_innings"],
    "hockey": ["us_power_play", "them_power_play", "us_scored", "them_scored", "even", "intermission"],
    "basketball": ["us_run", "them_run", "lead_change", "even", "break"],
}


def labels_from_summary(d: dict, espn_sport: str, side: str) -> pd.DataFrame:
    if side not in ("home", "away"):
        raise ValueError("side must be 'home' or 'away'")
    fn = SPORT_FN.get(espn_sport)
    if fn is None:
        raise ValueError(f"unsupported sport {espn_sport}")
    df = fn(d, side)
    q = d.pop("_quality", {"ok": False, "reason": "no play-by-play"})
    if df is None or df.empty or not q.get("ok"):
        df = pd.DataFrame(columns=COLUMNS)
        q["ok"] = False
        q["reason"] = q.get("reason") or "no play-by-play"
    df.attrs["quality"] = q
    return df


def labels_for(espn_sport: str, espn_league: str, event_id, side: str) -> pd.DataFrame:
    """Per-minute state timeline for one game from the perspective of `side` (home|away)."""
    d = fetch_summary(espn_sport, espn_league, event_id)
    return labels_from_summary(d, espn_sport, side)


def final_score_check(d: dict, df: pd.DataFrame, side: str) -> bool:
    teams = _teams(d)
    other = "away" if side == "home" else "home"
    if df.empty or teams[side]["score"] is None:
        return False
    return int(df.score_us.iloc[-1]) == teams[side]["score"] and int(df.score_them.iloc[-1]) == teams[other]["score"]


def build_all(markets: pd.DataFrame, workers: int = MAX_CONCURRENCY):
    """Label every distinct (espn game, side) in markets. Returns (states, coverage).

    states is unique per (espn_event_id, side, minute_utc); draw markets (side not home/away) are skipped."""
    need = ["espn_sport", "espn_league", "espn_event_id", "side"]
    side_col = "side" if "side" in markets.columns else "espn_side"
    m = markets.rename(columns={side_col: "side"}).dropna(subset=need).copy()
    m["espn_event_id"] = m["espn_event_id"].astype(str).str.replace(r"\.0$", "", regex=True)
    m["side"] = m["side"].astype(str).str.lower()
    m = m[m["side"].isin(["home", "away"])]
    pairs = m[need].drop_duplicates().values.tolist()
    games = sorted({(s, l, e) for s, l, e, _ in pairs})
    ok = set()
    with ThreadPoolExecutor(max_workers=min(workers, MAX_CONCURRENCY)) as ex:
        futs = {ex.submit(fetch_summary, s, l, e): (s, l, e) for s, l, e in games}
        for n, f in enumerate(as_completed(futs), 1):
            try:
                f.result()
                ok.add(futs[f])
            except Exception as exc:  # noqa: BLE001
                print("fetch failed", futs[f], exc, file=sys.stderr)
            if n % 100 == 0:
                print(f"fetched {n}/{len(games)}", file=sys.stderr)
    out, cov = [], []
    for s, l, e, side in pairs:
        rec = {"espn_sport": s, "espn_league": l, "espn_event_id": e, "side": side}
        if (s, l, e) not in ok:
            cov.append({**rec, "ok": False, "reason": "fetch failed", "minutes": 0})
            continue
        try:
            d = fetch_summary(s, l, e)
            df = labels_from_summary(d, s, side)
        except Exception as exc:  # noqa: BLE001
            cov.append({**rec, "ok": False, "reason": f"error: {exc!r}"[:200], "minutes": 0})
            continue
        q = df.attrs.get("quality", {})
        fs_ok = final_score_check(d, df, side) if not df.empty else False
        cov.append({**rec, **{k: q.get(k) for k in ("ok", "reason", "n_plays", "n_wallclock_ok", "clump_frac")},
                    "minutes": len(df), "final_score_ok": fs_ok})
        if df.empty:
            continue
        df.insert(0, "side", side)
        df.insert(0, "espn_event_id", e)
        df.insert(0, "espn_league", l)
        df.insert(0, "espn_sport", s)
        df["final_score_ok"] = fs_ok
        out.append(df)
    cov = pd.DataFrame(cov)
    print(f"labelled {len(out)}/{len(pairs)} game-sides", file=sys.stderr)
    return (pd.concat(out, ignore_index=True) if out else pd.DataFrame()), cov


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--markets", default=str(DATA / "markets.parquet"))
    ap.add_argument("--out", default=str(DATA / "states.parquet"))
    ap.add_argument("--event", nargs=4, metavar=("SPORT", "LEAGUE", "EVENT_ID", "SIDE"))
    a = ap.parse_args(argv)
    if a.event:
        df = labels_for(*a.event)
        with pd.option_context("display.max_rows", None, "display.width", 200):
            print(df)
        print(df.state.value_counts())
        return
    mp = Path(a.markets)
    if not mp.exists():
        sys.exit(f"{mp} not found (workstream A has not produced it yet); use --event for single games")
    states, cov = build_all(pd.read_parquet(mp))
    cov_path = Path(a.out).with_name("states_coverage.csv")
    cov.to_csv(cov_path, index=False)
    print(f"coverage -> {cov_path}")
    if not cov.empty:
        print(cov.groupby("espn_sport").agg(game_sides=("ok", "size"), labelled=("ok", "sum")).to_string())
        print(cov[~cov.ok.astype(bool)].reason.value_counts().to_string())
    if states.empty:
        sys.exit("no states produced")
    states.to_parquet(a.out, index=False)
    print(f"wrote {a.out}: {len(states)} rows, {states.espn_event_id.nunique()} games")
    print(states.groupby("espn_sport").state.value_counts(normalize=True).round(3).to_string())


if __name__ == "__main__":
    main()
