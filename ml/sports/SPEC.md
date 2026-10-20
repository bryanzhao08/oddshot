# In-game "about to happen" models: spec

Tipoff's iPhone app wants to say, during a live game, things like "Arsenal are pressing: 31% chance of a
goal in the next 10 minutes" or "Chiefs drive: 64% chance this ends in a touchdown". This folder trains
one gradient-boosted model per sport. The app runs them **on the phone** (Swift) from ESPN's public
live data, so **every feature must be computable from the live feeds described here, exactly the same
way in Python and Swift.** No leakage: features at time t use only events at or before t.

Work only inside `ml/sports/` (code, data, reports) and write the exported models to
`server/ml/sports/`. Use the venv at `ml/.venv` (xgboost 3.4, sklearn, pandas, numpy; `pip install`
more into it if you need, e.g. `optuna`, `pyarrow`, `nfl_data_py`). Raw downloads go under
`ml/sports/data/raw/` (gitignored). No API keys, public data only, be polite (≤ 8 concurrent requests,
retry with backoff, cache every response on disk so re-runs are free).

ESPN base: `https://site.web.api.espn.com/apis/site/v2/sports/{sport}/{league}`
- `/scoreboard?dates=YYYYMMDD` → `events[].id`, status
- `/summary?event={id}` → soccer: `commentary[]`, `header.competitions[0].competitors[]` (`id`, `homeAway`,
  `team.displayName`); basketball: `plays[]` (`period.number`, `clock.displayValue` "MM:SS", `homeScore`,
  `awayScore`, `scoringPlay`, `scoreValue`, `team.id`)

---

## 1. Soccer: `soccer.json`, "this team scores within the next 10 minutes"

**Data:** ESPN summaries for completed matches in eng.1, esp.1, ita.1, ger.1, fra.1, usa.1,
uefa.champions, seasons 2023-24, 2024-25, 2025-26 (as many as you can get; aim for 4,000+ matches).

**Timeline** (normalize each match to this; the Swift side builds the same thing live):
`[{ "min": float, "team": "home"|"away", "kind": "shot"|"shot_on_target"|"corner"|"goal"|"red" }]`
- `min = commentary.time.value / 60` (stoppage time just keeps counting: 47.5 etc.).
- Team: `commentary.play.team.displayName` matched to a competitor's `team.displayName`. If missing, parse
  the "(Team Name)" in the text or "Corner, Team Name." / "Goal! A 1, B 0." Drop events you can't attribute.
- kinds from `play.type.text` (case-insensitive):
  - goal: starts with "Goal" (includes "Goal - Header", "Penalty - Scored"); NOT "Own Goal" for the scorer:
    an own goal counts as a goal for the *other* team.
  - shot_on_target: "Shot On Target", "Saved"; a goal is also a shot_on_target AND a shot.
  - shot: any shot type ("Shot Off Target", "Shot Blocked", "Shot Hit Woodwork", on-target, goals).
  - corner: "Corner Awarded". red: "Red Card" (second yellow too if ESPN marks it red).
  - Document the exact mapping you used in `ml/sports/README.md`; Swift will copy it.

**Samples:** for each match, each team, each integer minute t in 1…88 (skip t where the match already
ended): one row from that team's perspective. Label `y = 1` if that team scores a goal with `t < min ≤ t+10`.

**Features** (team = "us", opponent = "them"), all from timeline events with `min ≤ t`:
`minute, is_home, goal_diff (us−them), goals_us, goals_them, red_us, red_them,
shots_us, shots_them, sot_us, sot_them, corners_us, corners_them,
shots_us_10, shots_them_10, sot_us_10, sot_them_10, corners_us_10, corners_them_10   (window (t−10, t])
shots_us_5, sot_us_5, corners_us_5                                                   (window (t−5, t])
mins_since_goal (any team; = minute if no goal yet), mins_since_our_shot (= minute if none),
second_half (minute > 45)`

## 2. American football: `football.json`, "this drive ends in a touchdown" (+ any score)

**Data:** nflverse play-by-play 2016–2025 (`nfl_data_py.import_pbp_data` or the parquet releases at
github.com/nflverse/nflverse-data). Plays with a posteam and down in 1–4 (scrimmage plays), regular +
post season.

**Labels:** `y_td = fixed_drive_result == "Touchdown"`; also train `y_score` (Touchdown or Field goal) as a
second booster in the same file.

**Features** (all available live from ESPN's scoreboard `situation` + status):
`yardline_100 (yards to the opponent end zone), down, ydstogo, goal_to_go, qtr (OT = 5),
half_seconds_remaining, game_seconds_remaining (OT: seconds left in OT), score_differential (posteam − defteam),
posteam_timeouts_remaining, defteam_timeouts_remaining (missing allowed → NaN)`

## 3. Basketball: `basketball.json`, "lead change or tie within the next 3 game minutes"

The fan moment in basketball isn't "someone scores" (always) but "this could flip". **Data:** ESPN NBA
summaries for completed games 2023-24, 2024-25, 2025-26 regular season + playoffs (`plays[]`).

**Timeline:** `[{ "sec": game seconds elapsed (12-min quarters, 5-min OT), "home": homeScore, "away": awayScore }]`
from scoring plays.

**Samples:** every 30 game-seconds from 2:00 elapsed until 3:00 before the end of regulation (and in OT).
Label `y = 1` if within the next 180 game-seconds the leader changes or the game becomes tied (if tied at t,
`y = 1` iff someone takes the lead AND it then changes or ties again; simpler alternative accepted: drop
tied-at-t rows). Perspective: the current leader.

**Features:** `period, sec_left_regulation (negative in OT → use sec_left_period too), sec_left_period,
lead (≥ 0, leader − trailer), pts_leader_2m, pts_trailer_2m, pts_leader_5m, pts_trailer_5m,
run_trailer (trailer points since the leader last scored), total_points (pace proxy)`

---

## Modelling (same recipe for all three)

- Split **by game** (never rows of one game on both sides), by time: oldest ~70% train, next ~10%
  calibration, newest ~20% test.
- Models to compare on the test set: (a) a simple baseline (logistic regression on 3–4 obvious features),
  (b) **XGBoost** (tune with optuna or a small grid, early stopping, `missing=NaN`), (c) a small **neural
  network** (sklearn `MLPClassifier`, standardized inputs, NaN → median + indicator), optionally (d)
  LightGBM/HistGradientBoosting. Report AUC, log loss, Brier, calibration (reliability table by decile) and
  lift in the top decile. Pick the deployed model by test log loss; **deploy only tree models** (XGBoost
  booster) so the phone can run them; if the MLP wins say so in the report and deploy the best tree model anyway.
- Calibrate the deployed booster: isotonic regression on the calibration split, applied to sigmoid(margin).

## Export format (the phone already evaluates this format; reuse `export_xgb` / `xgb_trees` /
`js_like_predict` from `ml/forecast_train.py` and its isotonic export)

```json
{
  "format": "tipoff-sport-v1", "sport": "soccer", "label": "goal_next_10m", "trained_at": "...",
  "features": ["minute", "is_home", ...],                // exact order of the vector
  "models": {
    "goal_next_10m": {"base_margin": -2.1, "trees": [{"f":[], "t":[], "y":[], "n":[], "m":[], "v":[]}],
                      "calibration": {"type": "isotonic", "x": [...], "y": [...]}}
  },
  "metrics": {"test_auc": 0.0, "test_logloss": 0.0, "base_rate": 0.0, "n_train_games": 0, ...},
  "fixtures": [ {"timeline": [...], "at": 63, "team": "home", "x": [...], "p": {"goal_next_10m": 0.31}} ]
}
```
- Football: `"models": {"td_drive": ..., "score_drive": ...}`; fixtures `{"state": {...feature dict...}, "x": [...], "p": {...}}`.
- Basketball: `"models": {"lead_change_3m": ...}`; fixtures include the timeline and `at` (game seconds).
- `fixtures`: 40 real rows from the test set with the exact feature vector and calibrated probability, so the
  Swift port can prove parity. Soccer/basketball fixtures must include the raw normalized timeline so the
  Swift feature code is tested too. Also save 2 raw ESPN summary JSONs per sport to
  `server/ml/sports/samples/` with the expected normalized timeline, to test Swift parsing.
- Keep each model file small (< 1.5 MB): cap trees/depth accordingly.

## Deliverables
- `ml/sports/*.py` (collect, features, train), runnable end to end: `python ml/sports/run_all.py`.
- `server/ml/sports/{soccer,football,basketball}.json` + `samples/`.
- `ml/sports/REPORT.md`: data sizes, per-model metrics table (baseline vs XGBoost vs MLP), calibration,
  top features, honest limitations, and example predictions on 3 famous moments per sport
  (e.g. a late equalizer, a goal-line stand, a 4th-quarter comeback) showing what the model said before.
- `ml/sports/README.md`: the exact timeline mapping rules and feature definitions (for the Swift port).
