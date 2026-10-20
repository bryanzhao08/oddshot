# Game-state estimation from odds: spec

**Goal.** Read what's happening in a game *from how the betting odds move*. This is not predicting
the final result. Example readings: "Bills on the attack, in scoring position", "Arsenal pressing",
"a goal probably just went in for Spurs", "momentum swinging to the Rays", "nothing much happening".
The phone sees a live Polymarket price every 20 s. ESPN coverage is spotty (tennis, esports and
smaller leagues have none), so the model must work from **odds only**, plus sport and elapsed game
time.

Everything lives in `ml/state/` (code, data, reports). Final exports go to `server/ml/state/`. Use
the venv `ml/.venv` (xgboost, sklearn, pandas, numpy, requests; `pip install` torch/hmmlearn if needed).
Raw downloads go in `ml/state/data/raw/` (gitignored), with every HTTP response cached on disk. Public
data only, no keys, at most 8 concurrent requests, retry with backoff.

## 1. Odds data (workstream A): `ml/state/data/markets.parquet`, `prices.parquet`

- Polymarket gamma: `GET https://gamma-api.polymarket.com/events?tag_slug={tag}&closed=true&limit=100&offset=N&order=endDate&ascending=false`
  for tags `nfl, cfb, mlb, nhl, nba, epl, laliga, ucl, mls, bundesliga, serie-a, ligue-1` (check the real
  slugs). Keep **game moneyline** markets, i.e. ones with `gameStartTime` that are a team-vs-team winner
  market, not spreads, totals or props. For soccer, keep the "Team A wins" markets; there are 3 per game
  (home / draw / away).
- For each market record: `market_id, event_slug, sport, league, title, outcome (team name the price
  refers to), game_start (UTC), token_id` and the resolved winner.
- Price history: `GET https://clob.polymarket.com/prices-history?market={token}&startTs={start-30min}&endTs={start+5h}&fidelity=1`
  (1-minute points, `t` in seconds). Find out how far back 1-minute history is available and go back as
  far as it allows (target: ≥ 1,500 games total, as many NFL / NHL / MLB / soccer as possible).
- Match each market to its ESPN event (`.../{sport}/{league}/scoreboard?dates=YYYYMMDD`, both team names
  + same date) and record `espn_sport, espn_league, espn_event_id`, plus which ESPN side the price refers
  to (`home`/`away`).

## 2. State labels (workstream B): `ml/state/data/states.parquet`

From ESPN `summary?event=ID`, which has wall-clock timestamps (`wallclock`) on plays and commentary.
For every matched game and every minute `t` (UTC, aligned to the price grid) from kickoff to the final
whistle, produce the true state **from the perspective of the side the price refers to ("us")**:

| sport | `state` classes (one per minute) |
|---|---|
| NFL / CFB | `us_scoring_position` (we have the ball at or inside the opponent 30), `us_offense` (we have the ball elsewhere), `them_offense`, `them_scoring_position`, `us_scored` / `them_scored` (TD or FG in the last 2 min), `turnover_us` / `turnover_them` (in the last 2 min), `stoppage` |
| Soccer | `us_pressing` (≥ 2 of shots/corners for us and 0 for them in [t−4, t]), `them_pressing`, `us_scored` / `them_scored` (goal in [t−2, t]), `red_card_us`/`red_card_them` (last 3 min), `open` (anything else in play), `halftime` |
| MLB | `us_batting_risp` (runner on 2nd/3rd), `us_batting`, `them_batting_risp`, `them_batting`, `us_scored` / `them_scored` (run in last 2 min), `between_innings` |
| NHL | `us_power_play`, `them_power_play`, `us_scored` / `them_scored` (goal in last 2 min), `even`, `intermission` |
| NBA | `us_run` (us outscoring them by ≥ 6 over the last 3 min), `them_run`, `lead_change` (last 2 min), `even`, `break` |

Also store `period`, `game_clock`, `score_us`, `score_them` per minute (for reporting only, **not**
as model inputs). Document the exact rules in `ml/state/README.md`.

## 3. Model (workstream C): what reads the game best from odds alone?

Inputs at minute `t`, using only prices at or before `t`:
- price level `p_t`, returns over 1, 2, 3, 5, 10 and 20 min, absolute returns, realized volatility over 5,
  15 and 30 min, max single-minute jump over 5 min, sign of the last move, run length of same-sign moves,
  and distance from 50%
- a **Kalman filter** (local linear trend: level + velocity) run over the price series, giving the filtered
  level, filtered velocity, its uncertainty, and the innovation (surprise) of the latest point
- minutes since kickoff (from `game_start`), sport one-hot, and whether it's a 3-way soccer market

Compare on a **time-ordered, game-wise** split (oldest 70% train, 10% calibration, newest 20% test):
1. a rule baseline (big up-jump → `us_scored`, steady drift up → `us_pressing`/`us_offense`, etc.)
2. **XGBoost multiclass** on the features above (one model per sport family, or one model with sport features)
3. a **GRU or 1-D CNN** on the raw last-30-minute price sequence (+ sport/time), using PyTorch
4. a **Gaussian HMM** (hmmlearn) on returns: unsupervised regimes mapped to labels by majority vote
5. optionally, XGBoost on features + the GRU's embedding

Report per sport: macro-F1, per-class precision/recall, log loss, a confusion matrix, and "top-1 state
accuracy when the model is ≥ 60% confident" (what the phone would actually say). Be honest: some states
(e.g. NFL `us_offense` vs `them_offense`) may simply not be visible in 1-minute odds. Say which ones are
reliably readable, and suggest merging classes into coarser, readable ones (e.g. `momentum_us`,
`momentum_them`, `big_moment_us`, `big_moment_them`, `calm`) if that's what the data supports.

## 4. Export (phone runs it)

The deployed model must be a tree model (XGBoost) in the format the phone already evaluates, reusing
`export_xgb` from `ml/sports/export.py`: multiclass = one tree ensemble per class (`num_class`
softmax). Ship:

```json
{"format": "tipoff-state-v1", "sports": ["nfl","soccer",...], "features": [...], "classes": [...],
 "kalman": {"q_level": ..., "q_velocity": ..., "r": ...},
 "models": {"<sport>": {"classes": [...], "base_margin": [...], "trees_per_class": [[...], ...]}},
 "metrics": {...}, "fixtures": [{"sport": "...", "prices": [[t, p], ...], "minute": 37, "x": [...], "probs": {...}}]}
```
Include 40 fixtures per sport with the **raw price series**, so the Swift feature code (including the
Kalman filter) can be tested for exact parity. Keep the file under 2 MB.

## Deliverables
`ml/state/*.py`, runnable end to end (`python ml/state/run_all.py`), `server/ml/state/state.json`,
`ml/state/REPORT.md` (data sizes, the model comparison table, the readable-states verdict, example
timelines of 3 real games showing odds vs true state vs predicted state) and `ml/state/README.md`.
