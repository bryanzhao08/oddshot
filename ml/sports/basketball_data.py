"""Public ESPN NBA play-by-play collector and leakage-safe in-game features.

Run ``python ml/sports/basketball_data.py --collect`` to cache all requested
seasons, or import ``load_basketball`` for the training frame. Cached HTTP
responses are gzip-compressed JSON and are never re-fetched on normal reruns.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import random
import time
from datetime import date
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw" / "basketball"
SAMPLES = ROOT.parents[1] / "server" / "ml" / "sports" / "samples"
BASE = "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba"
FEATURES = [
    "period", "sec_left_regulation", "sec_left_period", "lead",
    "pts_leader_2m", "pts_trailer_2m", "pts_leader_5m", "pts_trailer_5m",
    "run_trailer", "total_points",
]
MONTHS = [(y, m) for y in (2023, 2024, 2025, 2026) for m in range(1, 13)
          if (y, m) >= (2023, 10) and (y, m) <= (2026, 6)]


def _fetch(url: str, cache_path: Path, session: requests.Session) -> dict:
    if cache_path.exists():
        with gzip.open(cache_path, "rt") as f:
            return json.load(f)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    error = None
    for attempt in range(6):
        try:
            response = session.get(url, timeout=35)
            if response.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"HTTP {response.status_code}")
            response.raise_for_status()
            data = response.json()
            temp = cache_path.with_suffix(".tmp")
            with gzip.open(temp, "wt") as f:
                json.dump(data, f, separators=(",", ":"))
            temp.replace(cache_path)
            return data
        except (requests.RequestException, ValueError, OSError) as exc:
            error = exc
            if attempt < 5:
                time.sleep(min(30, 0.8 * (2 ** attempt)) + random.random() * 0.3)
    raise RuntimeError(f"Failed after six attempts: {url}: {error}")


def _valid_game(event: dict) -> bool:
    if event.get("status", {}).get("type", {}).get("completed") is not True:
        return False
    season = event.get("season", {})
    # ESPN season.type: 1 preseason, 2 regular, 3 postseason.
    if season.get("type") not in (2, 3):
        return False
    season_year = season.get("year")
    return season_year in (2024, 2025, 2026)


def collect_basketball() -> list[dict]:
    """Cache one monthly scoreboard and one summary per completed NBA game."""
    RAW.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = "oddshot-sports-research/1.0 (public ESPN data)"
    events = {}
    for year, month in MONTHS:
        ym = f"{year}{month:02d}"
        url = f"{BASE}/scoreboard?dates={ym}&limit=500"
        board = _fetch(url, RAW / "scoreboards" / f"{ym}.json.gz", session)
        for event in board.get("events", []):
            if _valid_game(event):
                events[event["id"]] = event
    ordered = sorted(events.values(), key=lambda e: (e.get("date", ""), e["id"]))
    manifest = [{"id": e["id"], "date": e["date"],
                 "season": e.get("season", {})} for e in ordered]
    (RAW / "manifest.json").write_text(json.dumps(manifest, indent=2))
    for i, e in enumerate(ordered, 1):
        game_id = e["id"]
        path = RAW / "summaries" / f"{game_id}.json.gz"
        try:
            _fetch(f"{BASE}/summary?event={game_id}", path, session)
        except RuntimeError as exc:
            print(f"NBA summary unavailable {game_id}: {exc}", flush=True)
        if i % 100 == 0:
            print(f"NBA summaries cached: {i}/{len(ordered)}", flush=True)
    return manifest


def _clock_seconds(clock: str) -> float:
    try:
        parts = clock.split(":")
        return float(parts[0]) * 60 + float(parts[1]) if len(parts) == 2 else float(parts[0])
    except (IndexError, TypeError, ValueError):
        return math.nan


def normalize_timeline(summary: dict) -> list[dict]:
    """Only score-changing scoring plays; stable order for equal-time scores."""
    out = []
    previous = (0, 0)
    for play in summary.get("plays", []):
        if not play.get("scoringPlay"):
            continue
        try:
            period = int(play["period"]["number"])
            home, away = int(play["homeScore"]), int(play["awayScore"])
            left = _clock_seconds(play["clock"]["displayValue"])
        except (KeyError, TypeError, ValueError):
            continue
        length = 720 if period <= 4 else 300
        if period < 1 or not 0 <= left <= length:
            continue
        sec = ((period - 1) * 720 if period <= 4 else
               2880 + (period - 5) * 300) + (length - left)
        if (home, away) == previous:
            continue
        # A malformed score reversal is not a live scoring event.
        if home < previous[0] or away < previous[1]:
            continue
        out.append({"sec": round(sec, 2), "home": home, "away": away})
        previous = home, away
    out.sort(key=lambda x: x["sec"])  # Python stable sort keeps ESPN play order.
    return out


def _scores_at(timeline: list[dict], at: float) -> tuple[int, int]:
    home = away = 0
    for event in timeline:
        if event["sec"] > at:
            break
        home, away = event["home"], event["away"]
    return home, away


def features_at(timeline: list[dict], at: int) -> dict | None:
    """Build one leader-perspective feature vector using only plays at/before at."""
    home, away = _scores_at(timeline, at)
    if home == away:
        return None
    leader_home = home > away
    now_leader, now_trailer = (home, away) if leader_home else (away, home)
    past_2 = _scores_at(timeline, at - 120)
    past_5 = _scores_at(timeline, at - 300)
    if leader_home:
        l2, tr2 = home - past_2[0], away - past_2[1]
        l5, tr5 = home - past_5[0], away - past_5[1]
    else:
        l2, tr2 = away - past_2[1], home - past_2[0]
        l5, tr5 = away - past_5[1], home - past_5[0]
    run_trailer = 0
    prev_home = prev_away = 0
    for event in timeline:
        if event["sec"] > at:
            break
        delta_leader = (event["home"] - prev_home if leader_home
                        else event["away"] - prev_away)
        delta_trailer = (event["away"] - prev_away if leader_home
                         else event["home"] - prev_home)
        if delta_leader:
            run_trailer = 0
        run_trailer += delta_trailer
        prev_home, prev_away = event["home"], event["away"]
    if at < 2880:
        period = at // 720 + 1
        sec_left_period = 720 - (at % 720)
    else:
        period = 5 + (at - 2880) // 300
        sec_left_period = 300 - ((at - 2880) % 300)
    return {
        "period": int(period), "sec_left_regulation": 2880 - at,
        "sec_left_period": int(sec_left_period), "lead": now_leader - now_trailer,
        "pts_leader_2m": l2, "pts_trailer_2m": tr2,
        "pts_leader_5m": l5, "pts_trailer_5m": tr5,
        "run_trailer": run_trailer, "total_points": home + away,
    }


def _label_at(timeline: list[dict], at: int) -> int:
    home, away = _scores_at(timeline, at)
    initial_leader = 1 if home > away else -1
    for event in timeline:
        if at < event["sec"] <= at + 180:
            new_leader = 1 if event["home"] > event["away"] else -1 if event["home"] < event["away"] else 0
            if new_leader != initial_leader:
                return 1
    return 0


def _game_rows(game_id: str, game_date: str, summary: dict) -> tuple[list[dict], list[dict]]:
    timeline = normalize_timeline(summary)
    if not timeline:
        return [], timeline
    try:
        competitors = summary["header"]["competitions"][0]["competitors"]
        final_home = int(next(c["score"] for c in competitors if c["homeAway"] == "home"))
        final_away = int(next(c["score"] for c in competitors if c["homeAway"] == "away"))
        if (timeline[-1]["home"], timeline[-1]["away"]) != (final_home, final_away):
            return [], timeline
    except (KeyError, IndexError, StopIteration, ValueError, TypeError):
        return [], timeline
    periods = [int(p.get("period", {}).get("number", 0)) for p in summary.get("plays", [])]
    max_period = max(periods, default=4)
    if max_period < 4:
        return [], timeline
    game_end = 2880 + max(0, max_period - 4) * 300
    times = list(range(120, 2701, 30))
    if max_period > 4:
        times += list(range(2880, game_end, 30))
    rows = []
    for at in times:
        if at >= game_end:
            continue
        features = features_at(timeline, at)
        if features is None:
            continue
        rows.append({"game_id": game_id, "game_date": game_date[:10], "at": at,
                     "y": _label_at(timeline, at), **features, "timeline": timeline})
    return rows, timeline


def load_basketball(collect: bool = True) -> pd.DataFrame:
    """Return game-grouped rows for 2023-24 through 2025-26 NBA seasons."""
    manifest_path = RAW / "manifest.json"
    if collect:
        manifest = collect_basketball()
    elif manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    else:
        raise FileNotFoundError("NBA cache absent; call load_basketball(collect=True)")
    rows = []
    sample_count = 0
    SAMPLES.mkdir(parents=True, exist_ok=True)
    for entry in manifest:
        path = RAW / "summaries" / f"{entry['id']}.json.gz"
        if not path.exists():
            continue
        try:
            with gzip.open(path, "rt") as f:
                summary = json.load(f)
            game_rows, timeline = _game_rows(entry["id"], entry["date"], summary)
        except (OSError, ValueError, KeyError) as exc:
            print(f"NBA parse failed {entry['id']}: {exc}", flush=True)
            continue
        rows.extend(game_rows)
        if game_rows and sample_count < 2:
            sample = {"game_id": entry["id"], "source": f"{BASE}/summary?event={entry['id']}",
                      "raw_summary": summary, "expected_timeline": timeline}
            (SAMPLES / f"basketball_{entry['id']}.json").write_text(json.dumps(sample, separators=(",", ":")))
            sample_count += 1
    return pd.DataFrame(rows, columns=["game_id", "game_date", "at", "y", *FEATURES, "timeline"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--collect", action="store_true", help="fetch missing public ESPN responses")
    args = parser.parse_args()
    frame = load_basketball(collect=args.collect)
    print(f"NBA: {frame.game_id.nunique()} games, {len(frame)} samples, y rate {frame.y.mean():.4f}")
