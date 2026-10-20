# Live sport moment models

Run from the repository root with `ml/.venv/bin/python ml/sports/run_all.py`. The runner caches public ESPN and nflverse responses under `ml/sports/data/raw/`, builds game-level chronological splits, compares logistic regression, XGBoost, and an MLP, calibrates the exported XGBoost models on separate games, and writes phone-ready JSON to `server/ml/sports/`. Re-running uses disk caches. No keys or trading data are used.

## Soccer (`soccer.json`)

Input: ESPN soccer `/summary?event=ID`, `commentary[]`, and `header.competitions[0].competitors[]`. Match the home and away competitors' `team.displayName` exactly after case folding and whitespace normalization. The parser emits one `{min,team,kind}` record per attributable play, sorts by `min`, and deduplicates repeated `play.id`. `min` is exactly `commentary.time.value / 60`. ESPN sometimes caps `time.value` at 2700 or 5400 during stoppage; the parser preserves that feed value rather than inferring extra time from display text. This can mis-time stoppage events and is a source limitation.

| ESPN `play.type.text` (case-insensitive) | Timeline `kind` | Attribution |
| --- | --- | --- |
| Prefix `Goal`, `Penalty - Scored` | `goal` | Prefer scorer's `(Team Name)` in text, then `play.team.displayName`. A goal counts as a shot and shot on target in features. |
| Prefix `Own Goal` | `goal` | ESPN `play.team` is the beneficiary. If absent, parse the conceding side from `Own Goal by …, Team.` and invert. |
| Prefix `Shot On Target` or `Saved` | `shot_on_target` | `play.team`, then a parenthesized team in text. Also counts as a shot. |
| Prefix `Shot` (all other shot types, including blocked/off target/woodwork) | `shot` | Same team lookup. |
| Prefix `Corner Awarded` | `corner` | Parse `Corner, Team Name.` from text. ESPN `play.team` can be the conceding side, so an unparseable corner is dropped. |
| Contains `Red Card` | `red` | Same team lookup; ESPN second yellows count only if marked red. |

A missing or unattributable event is dropped. `Goal! A 1, B 0.` without a scorer or team is ambiguous unless score history is reconciled; the current parser drops such a goal rather than guessing. Types such as `Deleted After Review` and penalty saves are not goals. The normalizer does not use ESPN boxscore totals to fill timeline gaps, since those totals may include future events.

At every integer minute 1–88 before match end, generate one row per side. The target is a goal for that side at `t < min ≤ t+10`. All features use events at `min ≤ t`. `minute=t`; `is_home` is 1 for home; `goal_diff`, `goals_us`, `goals_them`, `red_us`, `red_them`, `shots_us`, `shots_them`, `sot_us`, `sot_them`, `corners_us`, and `corners_them` are cumulative counts. Names ending `_10` count events in `(t−10,t]`, and names ending `_5` count events in `(t−5,t]`. `mins_since_goal` uses the last goal by either side, or equals `t` if none; `mins_since_our_shot` uses the last shot (including shots on target and goals) by our side, or equals `t` if none. `second_half = int(t>45)`.

## Football (`football.json`)

Input: public nflverse 2016–2025 regular and postseason play-by-play. Keep rows with a possession team and `down` in 1–4. Features are the **preplay** state: `yardline_100`, `down`, `ydstogo`, `goal_to_go`, `qtr` (OT capped at 5), `half_seconds_remaining`, `game_seconds_remaining` (positive OT seconds left), `score_differential` from possession team's view, `posteam_timeouts_remaining`, `defteam_timeouts_remaining`. Preserve missing numeric values as NaN in Python and null in fixture JSON. `fixed_drive_result` supplies labels only: `Touchdown` for `td_drive`, `Touchdown` or `Field goal` for `score_drive`. Swift can compute the vector from ESPN scoreboard `situation` and status; label fields are never live inputs.

## Basketball (`basketball.json`)

Input: ESPN NBA `/summary?event=ID`, `plays[]`. Keep `scoringPlay=true` plays with valid period, clock and nondecreasing changed scoreboard. Parse clock `MM:SS` or bare decimal seconds. For periods 1–4, `sec=(period−1)*720+(720−clock_seconds)`. For OT period 5+, `sec=2880+(period−5)*300+(300−clock_seconds)`. Stable sort by `sec`; each timeline item is `{sec,home,away}`. Exclude games whose final normalized score differs from the summary header score.

At sample time `t`, use the last scoring state with `sec≤t`. Sample every 30 seconds from 120 through 2700 in regulation, and from 2880 to before the end of each OT period. Drop tied states. `period` and `sec_left_period` derive from `t`; `sec_left_regulation=2880−t` is negative in OT. `lead` is current leader minus trailer. `pts_leader_2m`, `pts_trailer_2m`, `pts_leader_5m`, `pts_trailer_5m` are current scores minus scores as of `t−120` or `t−300` (window open on the left). `run_trailer` is the current trailer's points since the current leader last scored. `total_points=home+away`. The target is 1 if a scoring state in `(t,t+180]` ties the score or reverses the leader from the original leader's perspective.

## Export and validation

Each file uses `tipoff-sport-v1`, an ordered `features` array, trees with arrays `f,t,y,n,m,v`, `base_margin`, and isotonic knots `{type,x,y}`. Feed feature values in **exactly** the exported order. A tree's `m` flag routes missing values. Sum `base_margin` and tree leaves, sigmoid the result, then linearly interpolate the isotonic knots (clip outside their range). `fixtures` are 40 real test rows with ordered vector `x` and calibrated `p`; soccer and basketball fixtures include normalized timelines to check Swift feature construction. `server/ml/sports/samples/` holds two raw ESPN summaries per sport with expected timelines.

Run `ml/.venv/bin/python ml/sports/validate.py` to audit split disjointness, sample features, fixture probabilities, and raw JSON tree margins against the stored XGBoost boosters with tolerance `1e-4`.
