"""Cache completed ESPN soccer summaries for one league and season.

Example: python ml/sports/collect_soccer.py --league eng.1 --season 2023-24
Each process makes one request at a time, so parallel league collectors remain polite.
"""

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import json
from pathlib import Path
import random
import time
import requests


BASE = "https://site.web.api.espn.com/apis/site/v2/sports/soccer"
RAW = Path(__file__).resolve().parent / "data" / "raw" / "soccer"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "OddshotSportsResearch/1.0 (public ESPN data)"})


def get_json(url: str, path: Path, retries: int = 5) -> dict:
    if path.exists():
        return json.loads(path.read_text())
    for attempt in range(retries):
        try:
            response = SESSION.get(url, timeout=30)
            response.raise_for_status()
            payload = response.content
            result = json.loads(payload)
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(path.suffix + ".tmp")
            temporary.write_bytes(payload)
            temporary.replace(path)
            return result
        except (requests.RequestException, json.JSONDecodeError) as exc:
            if attempt == retries - 1:
                raise RuntimeError(f"Failed {url}: {exc}") from exc
            time.sleep(min(2**attempt, 16) + random.random())
    raise AssertionError("unreachable")


def default_dates(season: str, league: str) -> tuple[date, date]:
    year = int(season[:4])
    if league == "usa.1":
        return date(year, 1, 1), date(year, 12, 31)
    return date(year, 7, 1), date(year + 1, 6, 30)


def collect(league: str, season: str, start: date | None = None, end: date | None = None) -> dict:
    default_start, default_end = default_dates(season, league)
    start, end = start or default_start, end or default_end
    root = RAW / league / season
    root.mkdir(parents=True, exist_ok=True)
    seen: dict[str, dict] = {}
    scoreboard_counts: dict[str, int] = {}
    for year in range(start.year, end.year + 1):
        path = root / "scoreboard" / f"{year}.json"
        url = f"{BASE}/{league}/scoreboard?dates={year}&limit=1000"
        board = get_json(url, path)
        events = board.get("events", [])
        scoreboard_counts[str(year)] = len(events)
        for event in events:
            try:
                event_day = datetime.fromisoformat(event["date"].replace("Z", "+00:00")).date()
            except (KeyError, ValueError):
                continue
            if start <= event_day <= end and event.get("status", {}).get("type", {}).get("completed") is True:
                seen[str(event["id"])] = {
                    "id": str(event["id"]),
                    "date": event["date"],
                    "name": event.get("name", ""),
                    "summary": str(Path("summaries") / f"{event['id']}.json"),
                }
    matches = sorted(seen.values(), key=lambda x: (x["date"], x["id"]))
    failed: list[dict] = []
    empty_commentary: list[str] = []
    for index, event in enumerate(matches, 1):
        path = root / event["summary"]
        try:
            summary = get_json(f"{BASE}/{league}/summary?event={event['id']}", path)
            if not summary.get("commentary"):
                empty_commentary.append(event["id"])
        except RuntimeError as exc:
            failed.append({"id": event["id"], "error": str(exc)})
        if index % 50 == 0 or index == len(matches):
            print(f"{league} {season}: {index}/{len(matches)} summaries", flush=True)
    manifest = {
        "league": league,
        "season": season,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "scoreboard_counts": scoreboard_counts,
        "completed_matches": len(matches),
        "cached_summaries": len(matches) - len(failed),
        "empty_commentary": empty_commentary,
        "failed": failed,
        "events": matches,
        "collected_at": datetime.now(timezone.utc).isoformat(),
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", required=True)
    parser.add_argument("--season", required=True, help="e.g. 2023-24")
    parser.add_argument("--start", type=date.fromisoformat)
    parser.add_argument("--end", type=date.fromisoformat)
    args = parser.parse_args()
    manifest = collect(args.league, args.season, args.start, args.end)
    print(json.dumps({key: manifest[key] for key in (
        "league", "season", "start", "end", "completed_matches", "cached_summaries",
        "empty_commentary", "failed"
    )}, indent=2))


if __name__ == "__main__":
    main()
