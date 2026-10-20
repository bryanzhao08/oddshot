# Reading the game from the odds: report

**Question.** Can the minute-by-minute movement of Polymarket odds tell you *what's happening right now*
(a goal just went in, a team is on the attack, a break in play), without a live scoreboard?

**Data.**
- Antigravity collected the prices (`collect_odds.py`, `ODDS_DATA.md`): 3,189 finished games from
  September 2024 to October 2026, with 2.0 M one-minute prices, all matched to ESPN games.
- A Claude subagent built the true states from ESPN's wall-clock-stamped play-by-play (`labels.py`,
  `README.md`): 3,171 games and 972 k labelled minutes, all reproducing the final score.
- After joining: 961,218 minutes from 3,122 games (NHL 937, NBA 761, soccer 612, CFB 382, NFL 343, MLB 87).

Split by game, in time order: the oldest 70% train, the next 10% calibrate, and the newest 20% test.

## Which model reads the game best? (coarse states, held-out games)

| Model | Accuracy | Macro-F1 | Log loss | When ≥ 60% confident |
|---|---|---|---|---|
| Always "calm" (class prior) | 50.3% | 0.10 | 1.395 | n/a |
| Hand rules (jump = moment, drift = pressure) | 40.0% | 0.15 | 2.462 | n/a |
| Gaussian HMM on returns (unsupervised) | 50.3% | 0.10 | 1.343 | 32% of minutes, 58% right |
| GRU on the raw 30-minute price sequence | 56.4% | **0.37** | 1.537 | 30% of minutes, 73% right |
| **XGBoost on odds features + Kalman filter** | **61.0%** | 0.33 | **1.054** | **49% of minutes, 75% right** |
| XGBoost, phone-sized (1,120 trees, 1.8 MB) | 60.3% | | 1.073 | 47% of minutes, 75% right |

- **Deployed: XGBoost.** It has the best calibrated probabilities (lowest log loss), the highest
  accuracy and the highest confident accuracy, and it runs on the phone.
- **GRU:** with class weighting it finds more rare moments (higher macro-F1) but is badly calibrated.
  Blending the two is the obvious next experiment.
- **HMM:** its unsupervised regimes don't line up with real game states.
- **Kalman filter:** the local linear trend tracks the price's level and speed. Its fitted settings are
  q_level 8, q_velocity 0.05 and r 1. Its "surprise" (innovation z) and speed features are among the
  most useful inputs.

## What the odds can and can't tell you (XGBoost, precision / recall on test games)

| Reading | Where it works | Precision | Recall |
|---|---|---|---|
| **Just scored, and for whom** | soccer | 0.79 | 0.36 |
| | NHL | 0.77 | 0.37 |
| | MLB | 0.70 | 0.27 |
| | NFL | 0.49 | 0.19 |
| **Break in play** (halftime, intermission, timeout) | all | 0.66 overall; NHL intermission 0.78 / 0.84; soccer halftime 0.72 / 0.82 | |
| Lead changing hands (NBA) | NBA | 0.53 | 0.14 |
| **On the attack / pressure** | NHL power play | 0.60 | 0.15 |
| | NBA run | ~0.50 | 0.13 |
| | NFL scoring position | 0.35 | 0.12 |
| | soccer pressing | ~0 | ~0 |

**Verdict.**
- **Readable:**
  - Moments, meaning a score and who got it. Soccer and hockey goals move the odds by +13 points in the
    minute they happen.
  - Breaks in play, which show as flat odds at a typical point in the game.
- **Partly readable:** hockey power plays and basketball runs. When the model says so it's right about
  60% of the time, but it rarely does.
- **Not readable from 1-minute odds:** "pressure building", e.g. a soccer team pressing or an NFL drive
  in scoring position. The odds drift a little (NFL prices rise about 0.7 points per minute for a few
  minutes before a touchdown) but not enough to separate that from noise.

So the app says it only when the model is at least 60% sure, and keeps quiet otherwise.

## What the phone says (≥ 60% confidence; "must-see" at ≥ 75% for moments)

| Model output | Soccer | NHL | MLB | NFL / CFB | NBA |
|---|---|---|---|---|---|
| big_moment_us / them | "Goal for Spurs?" | "Goal for Canadiens?" | "Padres just scored" | "Big play for Rams" | "Big swing toward Celtics" |
| pressure_us / them | "Spurs on the attack" | "Canadiens on the power play?" | "Padres threatening" | "Bills driving" | "Celtics on a run" |
| big_moment | | | | | "The lead is changing hands" |
| break | "Break in play" | | | | |
| calm | (nothing) | | | | |

These readings are used only when there's **no live ESPN scoreboard** for the game. When ESPN has the
game, the scoreboard (and the in-game models in `ml/sports/`) are the truth.

## Replays through the phone's code (held-out games)

- **NHL, Predators vs Canadiens:** the app spoke 39 times and was right 34. It caught all five goals
  one minute after each (e.g. 73' "Goal for Canadiens?" as the odds went 63% → 76%).
- **MLS, Galaxy vs Rapids:** right 12 of 17. It caught both Rapids goals (15', 50') and the late Galaxy
  goal (103', 30% → 76%). It mislabels a few calm minutes after a goal as a break.
- **NFL, Rams vs Eagles:** right 10 of 13, but it **missed most scores**. Field goals and expected
  touchdowns barely move the odds.

## Parity and limits

- **Parity:** Swift (`ios/Tipoff/Engine/StateModel.swift`) matches Python on 240 fixtures, built from
  raw price series: features to 4e-15 and probabilities to 4e-17. The phone's live entry point agrees too.
- **Lag:** moments are recognised about one minute late, because the training grid is one minute. The
  phone polls every 20 s, so in practice it's about 20–60 s after the odds move.
- **What the labels can't tell apart:** "us/them" is from the side the price refers to. Late in a
  decided game (odds at 1% or 99%) nothing moves, so nothing is readable.
- **Gaps in the data:** NFL is only 343 games, and MLB 87. More seasons would help those two most.
  ESPN's timestamps for old soccer seasons and 2024 college football were unusable, so those games are
  excluded.

Reproduce: `python ml/state/collect_odds.py`, `python ml/state/labels.py`,
`python ml/state/train_state.py --coarse` (and without `--coarse` for the detailed states), then
`python ml/state/export_state.py`.
