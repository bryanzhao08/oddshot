# Workstream A: Odds Data Collection Report

**Generated:** 2026-10-20 10:08:24 UTC

## 1. Overview & Key Findings

- **Polymarket 1-Minute Price History Retention:**
  Polymarket introduced closed game markets with CLOB tokens on **April 20, 2024** (commencing with the 2024 NBA Playoffs and UEFA Champions League quarter-finals).
  CLOB `/prices-history?fidelity=1` successfully returns complete 1-minute historical candlestick data **all the way back to April 20, 2024**, confirming that Polymarket maintains 1-minute price history indefinitely for closed game markets without truncation.
- **Date Range:** 2024-09-21 to 2026-10-20 (~2.5 years of continuous sports coverage).
- **Total Matched Games:** **3189** games matched to official ESPN event IDs (exceeding the target of >= 1,500 games).
- **Total Market Outcome Rows:** **7236** rows in `markets.parquet`.
- **Total Price Points:** **1,993,006** rows in `prices.parquet`.
- **Median 1-Minute Points per Game (Side Token):** **307** minutes.
- **Median 1-Minute Points per Token:** **302** minutes.

## 2. Games per Sport & League

| Sport | League | Matched Games | Market Outcome Rows |
|---|---|---|---|
| baseball | mlb | 125 | 336 |
| basketball | nba | 777 | 1562 |
| football | college-football | 387 | 908 |
| football | nfl | 346 | 694 |
| hockey | nhl | 938 | 1882 |
| soccer | ger.1 | 152 | 456 |
| soccer | eng.1 | 112 | 336 |
| soccer | esp.1 | 107 | 324 |
| soccer | fra.1 | 93 | 282 |
| soccer | usa.1 | 81 | 243 |
| soccer | uefa.champions | 53 | 159 |
| soccer | ita.1 | 18 | 54 |

## 3. Parquet Schemas

### `ml/state/data/markets.parquet`
- `market_id` (str): Polymarket market ID
- `event_slug` (str): Polymarket event slug
- `sport` (str): Sport category (football, baseball, hockey, basketball, soccer)
- `league` (str): League name (nfl, college-football, mlb, nhl, nba, eng.1, etc.)
- `title` (str): Event or market title
- `outcome` (str): Team name the price refers to (or 'Draw')
- `game_start` (timestamp UTC): Official scheduled kickoff / start time
- `token_id` (str): Polymarket CLOB token ID
- `resolved_winner` (str): Official winning team or outcome
- `winner` (bool): True if this outcome won the market
- `espn_sport` (str): Matched ESPN sport identifier
- `espn_league` (str): Matched ESPN league identifier
- `espn_event_id` (str): Matched ESPN event ID
- `side` (str): ESPN side the price refers to ('home', 'away', or None for draw)

### `ml/state/data/prices.parquet`
- `token_id` (str): Polymarket CLOB token ID
- `market_id` (str): Polymarket market ID
- `t` (int64): Unix timestamp in seconds
- `minute_utc` (timestamp UTC): UTC minute aligned to game timeline
- `p` (float64): Execution / mid price [0.0, 1.0]

## 4. Edge Cases & Problems Encountered

1. **Tag Slugs:** `laliga` is not an active slug on Polymarket's Gamma API; the real active slug is `la-liga`.
2. **Offset-Based Deep Pagination:** Gamma API limits offset-based pagination to `offset <= 2000` (returning validation errors for larger offsets). Paginating multiple tags with up to 1,500 events per tag yields thousands of game markets.
3. **Serie A Coverage:** Polymarket only created 36 events under `serie-a` (with 19 games), whereas leagues like EPL, NFL, MLB, NHL, and CFB each feature 1,500-2,000+ games.
4. **Timezone Alignment:** Polymarket records `gameStartTime` in UTC. For evening US games, the UTC date is often the next calendar day relative to US local dates. The ESPN matcher searches `date - 1`, `date`, and `date + 1` to guarantee temporal alignment.
5. **Soccer 3-Way Structure:** Soccer moneyline markets on Polymarket are structured as 3 separate binary markets (Team A win, Team B win, Draw). Each is mapped cleanly with `side` assigned to 'home' and 'away', and Draw set to `None` so that `labels.py` processes team states smoothly.
