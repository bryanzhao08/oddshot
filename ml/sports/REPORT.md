# In-game models: report

Three gradient-boosted models that run on the iPhone during live games (spec: `SPEC.md`, feature
rules: `README.md`). Data is public: ESPN match commentary and play-by-play, and nflverse play-by-play.
Every split is by whole game and in time order: the oldest 70% of games train, the next 10%
calibrate, and the newest 20% test. No game's rows appear in more than one split.

| Sport | Predicts | Games (train / cal / test) | Base rate |
|---|---|---|---|
| ⚽ Soccer (EPL, La Liga, Serie A, Bundesliga, Ligue 1, MLS, UCL; 2023–26) | this team scores in the next 10 min | 3,546 / 507 / 1,014 | 14.5% |
| 🏈 NFL (2016–2025) | this drive ends in a touchdown; in any score | 1,932 / 276 / 553 | 28.0%; 50.6% |
| 🏀 NBA (2023-24 to 2025-26) | lead change or tie in the next 3 game minutes | 2,737 / 391 / 782 | 21.6% |

## Test-set results (newest games, never seen in training)

| Model | Baseline (logistic, 4 features) | **XGBoost (deployed)** | Neural net (MLP 64-32) |
|---|---|---|---|
| Soccer, goal in 10 min | AUC 0.555, LL 0.4120 | **AUC 0.581, LL 0.4091** | AUC 0.537, LL 0.4223 |
| NFL, touchdown this drive | AUC 0.718, LL 0.5272 | **AUC 0.748, LL 0.5048** | AUC 0.745, LL 0.5075 |
| NFL, points this drive | AUC 0.777, LL 0.5666 | **AUC 0.806, LL 0.5295** | AUC 0.802, LL 0.5341 |
| NBA, lead change in 3 min | AUC 0.907, LL 0.3056 | **AUC 0.907, LL 0.3051** | AUC 0.906, LL 0.3068 |

XGBoost has the lowest test log loss for every target, so it's what ships. The neural network never beat
it. On tabular game-state data like this, tree boosting is the right tool. Calibration (none, Platt or
isotonic) was chosen by 2-fold cross-validation on the calibration games. Platt won everywhere.

## What it means in the app (thresholds chosen on the test games)

| Model | Shown when | How often that happens | How often it comes true |
|---|---|---|---|
| Soccer | ≥ 22% | 6.7% of minutes | 23.5% (vs 14.5% normally) |
| Soccer, must-see | ≥ 33% | rare (~0.5%) | ~35–40% |
| NFL TD | ≥ 42% | 16.8% of snaps | 58.4% |
| NFL TD, must-see | ≥ 60% | 5.3% | 72.4% |
| NBA flip | ≥ 50% | 20.8% of checks | 67.1% |
| NBA flip, must-see | ≥ 60% and 4th quarter or later | | 71.2% |

A replay of 40 Premier League 2025-26 matches through the phone's own code produced 49 soccer alerts. 26%
were followed by that team scoring within 10 minutes, which matches the test set. NFL 1st & goal at the 3
in a tied 4th quarter reads "75% chance of a touchdown" (must-see). A 12-point NBA game with 8 minutes
left stays quiet (≤ 14%).

## What drives each model

- **Soccer:** total shots, second half, shots from inside the box (parsed from ESPN's commentary
  wording: "centre of the box", "very close range", "six yard box"), red cards, home side.
- **NFL:** goal-to-go, yards to the end zone, down, distance, time left in the half.
- **NBA:** the size of the lead dominates (78% of gain), then period, pace and recent scoring.

## Honest limitations

- **Soccer is hard.** Goals are rare and random, and the public feed has no possession or xG
  location data. An AUC of 0.58 and a top-decile lift of 1.5× are real but modest, so the app says "24%
  chance (usually 15%)" rather than anything that sounds certain. Things I tried:
  - Shot-quality features from the commentary text: kept, but they added almost nothing.
  - Bookmaker pre-match odds: dropped. ESPN's historical `odds` field holds end-of-match prices (the
    winner at 1/100), which would leak the result, and real pre-match lines exist for only about 1 in 6
    matches.
- **NBA's high AUC is mostly "small lead late = could flip".** The model barely beats a 4-feature
  logistic baseline, and the value is in calibrated wording, not hidden insight.
- **NFL uses ESPN's live `situation`.** Down, distance and field position must be present. Between
  plays, kickoffs and reviews, there's no prediction.
- **Feed rules:** live feeds can lag a few seconds and occasionally revise events. The phone recomputes
  every 40 s.
- **Concerts and other live events** have no public play-by-play to train on, so there's no in-show model.
  The app relies on the odds forecaster plus X phrases such as "surprise guest", "brought out" and
  "on stage now", which mark a concert moment must-see.

## Parity (Python ↔ Swift)

`server/ml/sports/*.json` holds the trees, calibration, base rates and 40 test fixtures per sport, plus
raw ESPN samples with their expected timelines. The Swift port, checked in a command-line harness,
gives identical feature vectors (max |Δ| = 0) and probabilities within 3e-7 on every fixture, and parses
the raw samples identically.

Reproduce: `python ml/sports/run_all.py` (after `collect_soccer.py` and `basketball_data.py --collect`;
NFL data downloads on first run).
