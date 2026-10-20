"""Public nflverse play-by-play loader for in-drive football predictions.

Run ``python ml/sports/football_data.py`` to download and validate the 2016–2025
REG/POST play-by-play releases. Downloads and the processed cache live under
``ml/sports/data/raw/football``. ``load_football()`` returns one eligible
pre-play state per row, with final-drive labels and descriptive metadata.
"""

from __future__ import annotations

import concurrent.futures
import os
import time
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq
import requests


YEARS = tuple(range(2016, 2026))
RAW_DIR = Path(__file__).resolve().parent / "data" / "raw" / "football"
URL = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{year}.parquet"
FEATURES = [
    "yardline_100",
    "down",
    "ydstogo",
    "goal_to_go",
    "qtr",
    "half_seconds_remaining",
    "game_seconds_remaining",
    "score_differential",
    "posteam_timeouts_remaining",
    "defteam_timeouts_remaining",
]
META = [
    "game_id", "game_date", "season", "season_type", "week", "play_id",
    "fixed_drive", "fixed_drive_result", "posteam", "defteam",
    "home_team", "away_team", "posteam_score", "defteam_score",
    "play_type", "desc", "time",
]
OUTPUT_COLUMNS = META + FEATURES + ["y_td", "y_score"]


def _download(year: int, raw_dir: Path) -> Path:
    path = raw_dir / f"play_by_play_{year}.parquet"
    if path.exists():
        try:
            if path.stat().st_size > 100_000 and pq.ParquetFile(path).metadata.num_rows > 1000:
                return path
        except Exception:
            pass
    raw_dir.mkdir(parents=True, exist_ok=True)
    url = URL.format(year=year)
    last_error: Exception | None = None
    for attempt in range(5):
        tmp = path.with_suffix(".parquet.part")
        try:
            with requests.get(url, stream=True, timeout=(15, 120)) as response:
                response.raise_for_status()
                with tmp.open("wb") as f:
                    for chunk in response.iter_content(chunk_size=1 << 20):
                        if chunk:
                            f.write(chunk)
            if pq.ParquetFile(tmp).metadata.num_rows < 1000:
                raise ValueError(f"Suspiciously small PBP release: {url}")
            os.replace(tmp, path)
            return path
        except (OSError, requests.RequestException, ValueError) as exc:
            last_error = exc
            tmp.unlink(missing_ok=True)
            if attempt < 4:
                time.sleep(min(2**attempt, 16))
    raise RuntimeError(f"Could not download nflverse {year}: {last_error}")


def _extract(path: Path) -> pd.DataFrame:
    schema = set(pq.ParquetFile(path).schema.names)
    required = set(FEATURES + ["game_id", "game_date", "season_type", "posteam", "fixed_drive_result"])
    missing = required - schema
    if missing:
        raise ValueError(f"{path.name} lacks required columns: {sorted(missing)}")
    available = [c for c in dict.fromkeys(META + FEATURES) if c in schema]
    df = pd.read_parquet(path, columns=available)
    for col in META + FEATURES:
        if col not in df:
            df[col] = pd.NA

    # nflverse state columns describe the situation BEFORE the current play.
    # A fixed_drive_result is hindsight and appears only in the targets/metadata.
    eligible = (
        df["season_type"].isin(["REG", "POST"])
        & df["posteam"].notna()
        & df["down"].isin([1, 2, 3, 4])
        & df["fixed_drive_result"].notna()
    )
    df = df.loc[eligible].copy()
    df["y_td"] = df["fixed_drive_result"].eq("Touchdown").astype("int8")
    df["y_score"] = df["fixed_drive_result"].isin(["Touchdown", "Field goal"]).astype("int8")
    df["game_date"] = pd.to_datetime(df["game_date"], errors="coerce")
    if df["game_date"].isna().any():
        raise ValueError(f"Unparseable game_date in {path.name}")
    for col in FEATURES:
        df[col] = pd.to_numeric(df[col], errors="coerce").astype("float32")
    # OT can have multiple numbered periods; the live feature contract uses 5.
    df["qtr"] = df["qtr"].clip(upper=5)
    return df[OUTPUT_COLUMNS]


def load_football(
    years: tuple[int, ...] = YEARS,
    raw_dir: Path = RAW_DIR,
    *,
    refresh_processed: bool = False,
) -> pd.DataFrame:
    """Return nflverse pre-play states, preserving NaN timeout values.

    The all-years processed cache is used only for the default full date range.
    A subset is read directly from its cached annual source parquets.
    """
    raw_dir = Path(raw_dir)
    cache = raw_dir / "football_2016_2025.parquet"
    if years == YEARS and cache.exists() and not refresh_processed:
        return pd.read_parquet(cache)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        files = list(pool.map(lambda y: _download(y, raw_dir), years))
    frames = [_extract(p) for p in files]
    result = pd.concat(frames, ignore_index=True).sort_values(
        ["game_date", "game_id", "play_id"], kind="stable"
    ).reset_index(drop=True)
    if years == YEARS:
        raw_dir.mkdir(parents=True, exist_ok=True)
        tmp = cache.with_suffix(".parquet.part")
        result.to_parquet(tmp, index=False)
        os.replace(tmp, cache)
    return result


if __name__ == "__main__":
    data = load_football()
    print(f"rows={len(data):,} games={data.game_id.nunique():,} seasons={sorted(data.season.unique())}")
    print(data.groupby("season").agg(rows=("y_td", "size"), games=("game_id", "nunique"),
                                      td_rate=("y_td", "mean"), score_rate=("y_score", "mean")).to_string())
    print("missing feature counts:", data[FEATURES].isna().sum().to_dict())
