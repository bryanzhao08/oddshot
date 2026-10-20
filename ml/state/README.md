# ml/state: game state from odds

## State labels (workstream B): `labels.py` -> `data/states.parquet`

```
ml/.venv/bin/python ml/state/labels.py                                     # all games in data/markets.parquet
ml/.venv/bin/python ml/state/labels.py --event football nfl 401872996 home # one game, prints the timeline
ml/.venv/bin/python ml/state/test_labels.py                                # hand-checked tests (pytest works too)
```

`labels_for(espn_sport, espn_league, event_id, side)` returns one row per UTC minute with columns
`minute_utc, state, period, game_clock, score_us, score_them`. "us" is the ESPN `side` (`home`/`away`)
that the Polymarket price refers to. `period`, `game_clock`, `score_*` are for reporting only.

The CLI reads `data/markets.parquet` (`espn_sport, espn_league, espn_event_id, side`; `espn_side` also works).
It labels every distinct (game, side) pair and skips draw markets. It writes:
- `data/states.parquet`: `espn_sport, espn_league, espn_event_id (str), side, minute_utc, state, period,
  game_clock, score_us, score_them, final_score_ok`. Rows are unique per (event, side, minute).
- `data/states_coverage.csv`: one row per game-side with `ok`, `reason`, play counts and `final_score_ok`.

### Data source and caching
`https://site.web.api.espn.com/apis/site/v2/sports/{sport}/{league}/summary?event={id}`. Every 200 response
is cached as `data/raw/espn/{sport}_{league}_{id}.json`. There are at most 8 concurrent requests (semaphore +
thread pool), with 5 retries and exponential backoff. 400/404 responses fail fast.

### Common rules (all sports)
- **Event times** come from each play's `wallclock` (UTC).
- **Minute grid:** from `ceil(first play)` to `ceil(last play)`, every minute.
- **Which events count at minute t:** those with wallclock `<= t`. "State" is the situation after the latest
  event at or before t. "In the last W minutes" means the half-open window `(t - W, t]`. So a 2-minute window
  marks exactly 2 minutes: a TD at 13:58:17 is `*_scored` at 13:59 and 14:00. If the model needs labels
  shifted (for example for price latency), shift `minute_utc`.
- **Score** is the running maximum of each side's ESPN score. This removes transient glitches, such as a
  TD row showing 7 followed by a timeout row showing 6 before the PAT.
- **Who scored** comes from which side's score went up, not from team attribution. This handles own goals
  and defensive TDs.
- **Bad wallclocks.** Plays are kept in ESPN array order. The timestamps are reduced to their longest
  non-decreasing subsequence: plays edited after the fact carry a later wallclock and the later score.
  Other plays inherit the previous good timestamp and their score fields are ignored.
- **Game quality gate.** A game produces no labels (`ok=False` in coverage) if either check fails:
  - fewer than 70% of plays have a wallclock within `[start - 1h, start + 8h]`;
  - more than 25% of plays share a timestamp with 4 or more others (batch-stamped feeds).
- **Priority** when several rules fire is listed per sport, highest first.

### NFL / CFB (`football`): from `drives.previous[].plays[]`
Priority: `us_scored`/`them_scored` > `turnover_us`/`turnover_them` > `stoppage` > possession states.
- **`*_scored`:** a side's score rose in the last 2 min. This covers TD, FG, safety and PAT/2-pt.
- **`turnover_us` / `turnover_them`:** the drive result contains INT, FUMBLE or DOWNS, in the last 2 min.
  `turnover_us` means **we lost the ball**, the same convention as `red_card_us`.
  - The time used is the drive's last play whose type mentions interception or fumble. Otherwise it is the
    drive's last non-admin play.
  - Missed or blocked FGs and blocked punts are not counted as turnovers.
- **`stoppage`:** any of these:
  - the latest event is admin: Timeout, Official Timeout (TV), Two-minute warning, End Period / End of Half
    (quarter breaks, halftime);
  - no real play in the last 150 s (injury, review);
  - the possession team is unknown.
- **Possession:** the latest real play's `end.team` (falling back to `start.team`). After a kickoff, punt
  or interception this is the team now holding the ball.
- **`*_scoring_position`:** the latest real play has `0 < end.yardsToEndzone <= 30`, meaning at or inside
  the opponent 30.
- Otherwise `us_offense` / `them_offense`.

### Soccer: union of `keyEvents` and `commentary[].play` (deduplicated by play id)
Priority: `halftime` > `*_scored` > `red_card_*` > `*_pressing` > `open`.
- **`halftime`:** from a half-end event (`Halftime`, `End Regular Time` when extra time follows, or
  "... Half ends" text) to the next half-start event (`Start 2nd Half`, `Kickoff`, "... begins").
  Substitutions logged during the break don't end it. Extra-time breaks are also labelled `halftime`.
- **`*_scored`:** a goal in `(t-2, t]`.
  - Goals are `scoringPlay` rows (`Goal`, `Goal - Header/Volley`, `Penalty - Scored`, `Own Goal`).
  - The score is parsed from the text, e.g. "Goal! Brentford 1, Liverpool 0." (home team listed first).
    Team attribution is the fallback.
  - Goals overturned by VAR never get `scoringPlay`; ESPN replaces them with "Deleted After Review".
  - Shootout events are ignored.
- **`red_card_*`:** a `Red Card` row (this includes second yellows, which ESPN types as Red Card) in the
  last 3 min. `red_card_us` means we were sent off.
- **`*_pressing`:** in `(t-4, t]`, at least 2 attacking actions for one side and 0 for the other.
  Attacking actions are shots (`Shot On/Off Target`, `Shot Blocked`, `Shot Hit Woodwork`, goals, penalty
  attempts) and `Corner Awarded`. A blocked shot is credited to the shooter's team, which is ESPN's `team`.
- Otherwise `open`. Injury delays count as `open`.

### MLB (`baseball`): from `plays[]` (pitch-level, with `onFirst/onSecond/onThird`)
Priority: `*_scored` > `between_innings` > batting states.
- **`*_scored`:** a run in the last 2 min. Scores are read **only from `scoringPlay` rows**, because ESPN
  pre-fills the post-at-bat score (and outs) on "Start Batter/Pitcher" rows.
- **`between_innings`:** the latest row is End Inning (Mid/End), or the half-inning has no batter or pitch
  row yet. Start Inning and pitching-change rows before the first pitch are still part of the break.
- **Batting side:** `Top` means away bats, `Bottom` means home bats.
- **`*_batting_risp`:** the latest row has `onSecond` or `onThird`. Otherwise `*_batting`.

### NHL (`hockey`): from `plays[]` (with `strength` and penalty types)
Priority: `intermission` > `*_scored` > `*_power_play` > `even`.
- **`intermission`:** the latest event is `Period End`, until the next event (`Period Start`). This covers
  breaks before OT and the shootout.
- **`*_scored`:** a goal in the last 2 min, from score increases. Shootout attempts don't change ESPN's
  score.
- **Power-play owner**, updated event by event:
  - A penalty row (`type.penaltyType` present, except Misconduct, Game Misconduct and Penalty Shot) gives
    the PP to the opponent. If the penalised team was already on a PP, the result is even (4-on-4).
  - On rows that have a team, `strength=power-play` or `short-handed` sets or confirms the owner, and
    `even-strength` clears it.
  - Team-less rows (Stoppage, TV timeout) are ignored. They carry the pre-penalty strength.
  - ESPN gives no penalty-expiry event. A PP ends at the first team play flagged `even-strength`, usually
    within a few seconds of expiry, or at a PP goal.

### NBA (`basketball`): from `plays[]`
Priority: `break` (between periods) > `lead_change` > `us_run`/`them_run` > `break` (timeout) > `even`.
- **`break` between periods:** from `End Period` to the first live play of the next period. Substitutions
  and timeouts logged during the break don't end it.
- **`break` for a timeout:** the latest event is a timeout.
- **`lead_change`:** the strict leader switched in the last 2 min. Ties are skipped, so 10-9 -> 10-10 ->
  10-12 is one change.
- **`us_run`:** `(Δus - Δthem) >= 6` over the last 3 **wall-clock** minutes, comparing the score at t with
  the score at t-3 min. `them_run` is the mirror case. The window is the constant 180 s in `_basketball`.
  It is wall-clock for consistency with the other sports and the price grid. 3 wall minutes is roughly
  1.5 game minutes, so runs are rare (about 2% each side).

### Gaps and caveats (what ESPN doesn't give)
- **Old soccer feeds have no wallclock.** EPL Feb 2025 has none on `keyEvents`, and its commentary
  wallclocks are back-filled a month later. Those games are skipped (`missing/out-of-window wallclock`).
  2025-26 MLS/UCL and the current season are fine.
- **Old CFB feeds are batch-stamped.** 2024 games show the same wallclock on 5-10 consecutive plays and
  placeholder `00:00:00Z` stamps. They are skipped (`batch-stamped wallclock`). NFL 2024, NHL/MLB/NBA 2025
  and CFB 2026 are clean.
- **Wallclock is ESPN's logging time,** typically a few seconds after the play. Single plays are
  occasionally stamped much later; the outlier repair above handles these.
- **NHL:** no explicit PP start/end. Penalty rows plus per-play strength flags are used, so a PP that
  starts during a stoppage is labelled from the penalty row. Delayed penalties are not visible.
- **Football:**
  - Turnovers come from drive results. Muffed punts and kick-return fumbles recovered by the kicking team
    show up only if ESPN ends the drive with FUMBLE.
  - Turnovers on downs use the drive's last snap time.
  - Stoppage is about 33% of NFL minutes: TV timeouts, halftime and post-score breaks are real dead time.
- **Soccer:**
  - ESPN commentary is sparse: about 100 events per match, with no possession, passes or dangerous-attack
    data. `*_pressing` therefore relies only on shots and corners, exactly as the SPEC defines it.
  - The window is in wall-clock minutes, not match minutes.
  - Stoppage time and injury delays are `open`.
- **MLB:** steals, wild pitches and pickoffs update the runners from the row they appear on. Runner keys
  are trusted on every row, while scores and outs are not (see above).
- **Shared:** the minute grid starts at the first play, not the scheduled `game_start`, so pre-game minutes
  are absent.

### Label distributions on the test games (both sides, so `us_*` and `them_*` are symmetric)
| sport | games | side-minutes | distribution |
|---|---|---|---|
| football (2 NFL + 2 CFB) | 4 | 1682 | stoppage 34.2%, us/them_offense 19.5% each, us/them_scoring_position 6.7% each, us/them_scored 4.2% each, turnover_us/them 2.4% each |
| soccer (EPL x4, LaLiga x2) | 6 | 1418 | open 59.5%, halftime 14.0%, us/them_pressing 8.9% each, us/them_scored 3.9% each, red_card_us/them 0.5% each |
| MLB | 2 | 742 | between_innings 29.1%, us/them_batting 23.7% each, us/them_batting_risp 7.7% each, us/them_scored 4.0% each |
| NHL | 3 | 890 | even 50.1%, intermission 25.8%, us/them_power_play 7.5% each, us/them_scored 4.5% each |
| NBA | 3 | 984 | even 62.8%, break 27.4%, lead_change 6.1%, us/them_run 1.8% each |

All 18 test games reproduce ESPN's final score (`final_score_ok`).
