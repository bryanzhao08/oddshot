ODDSHOT MOMENT FORECASTER: REPORT
=================================

Question: using only information available now, will this market make a big move
within the next 30 minutes? This score ranks the Shot List: what to watch or shoot
before the moment happens.

  Label  y        = max |p(t+k) - p(t)| over k in (0, 30 min] >= 0.05 (1-minute grid)
  Target max_move = the same max |move|, used by the regressor (expectedMovePts = 100 x prediction)

Files
  ml/forecast_features.py   feature definitions (single source of truth)
  ml/forecast_data.py       metadata fetch + dataset build  -> ml/data/forecast.parquet
  ml/forecast_train.py      training, evaluation and export -> server/ml/forecaster.json,
                            forecaster_fixtures.json, ml/data/forecast_results.json
  server/ml/forecaster.js   pure-JS runtime (zero deps, browser-compatible)
  server/ml/forecaster.test.js  parity and fallback tests

Reproduce
  ml/.venv/bin/python ml/forecast_data.py      # --refresh-meta to re-download metadata
  ml/.venv/bin/python ml/forecast_train.py     # --trials 60 --reg-trials 25 --tune-rows 260000 (~32 min)
  node --test 'server/**/*.test.js'


DATASET
-------
- Source: the same cached raw 1-minute histories as the spike classifier
  (ml/data/raw: Polymarket CLOB prices-history and Kalshi 1-minute candles),
  2026-08-04 12:20 to 2026-10-15 06:30 UTC.
- Metadata was re-fetched into ml/data/forecast_meta.json, because the cache did not
  contain start times:
    * Polymarket: startTime = gameStartTime || eventStartTime || events[0].startTime.
      This is the same chain as the contract. 643 of 1036 markets have a start time.
    * Kalshi: endDate = expected_expiration_time || close_time, which is what
      server/sources/kalshi.js serves. The settled close_time is NOT used because it
      leaks the actual (often early) resolution time. Kalshi has no start time.
- Decision times: every 10 minutes on the clock grid. The first 6h of each series is
  skipped, and so is any time whose 30-minute label window runs past the end of the data.
- Pinned rows are dropped: if the whole last hour is <= 0.02 or >= 0.98, the market is
  treated as resolved or dead.
- Cold-start augmentation: 15% of rows get a truncated history (30 to 360 minutes,
  chosen by a deterministic hash), so the model has seen the short histories the
  server has right after a restart.
- Size: 889,184 decision rows, 857 markets, 497 event groups.
- Base rate: 3.22% overall (fit 3.65%, cal 2.15%, test 3.40%).
  Mean max move over the next 30 minutes: 0.69 pts.

  Base rate by category:
    sports         620,618 rows   3.5%
    politics       120,958        0.9%
    economics       53,790        3.6%
    crypto          36,269        5.8%
    tech            34,102        0.9%
    entertainment   15,375        2.7%
    weather          6,289       15.8%
    other            1,783        0.0%

  Base rate by source: polymarket 832,059 rows at 3.1%; kalshi 57,125 rows at 4.9%.
  When the live proxy is on, 57% of rows see a big move (vs 2.5% when off).


LEAKAGE PROTOCOL (same as ml/train.py)
--------------------------------------
- Features use prices with t <= decision time only. The 1-minute grid is anchored at
  the decision time, with last observation carried forward.
- Groups are Polymarket events and Kalshi events.
- TEST = test-hashed groups (25%) in the latest 20% of time (>= 2026-10-08 19:00).
- TRAIN = the other groups, before T_test minus a 60-minute purge (the label looks
  30 minutes ahead).
- CAL (Platt calibration) = 30% of train groups in the latest 25% of train time.
  FIT = the remaining groups before T_cal minus the purge.
- No group appears in more than one of FIT / CAL / TEST. The script asserts this.
- Split sizes: FIT 258,518 rows; CAL 33,542; TEST 50,691 (86 markets, 49 groups).
- Tuning: Optuna TPE with 60 trials each for XGBoost and LightGBM (25 for the
  regressor), on all FIT rows. 4 grouped, expanding-window, time-ordered folds;
  each fold's validation groups are removed from its training data, with a
  60-minute purge.
- Liquidity and volume are excluded. Only today's snapshot exists, so using them
  would leak.


CLASSIFIER RESULTS (held-out TEST: 50,691 rows, base rate 3.40%)
----------------------------------------------------------------
lift@q = big-move rate in the top q fraction of moments / base rate

  model                    CV AUC  test AUC  PR-AUC  Brier   logloss  lift@5%  lift@10%
  baseline: vol_1h alone   0.889   0.919     0.478   0.0230  0.0904   12.8x    7.7x
  logistic regression      0.929   0.932     0.560   0.0218  0.0895   12.8x    8.3x
  heuristic fallback (*)   -       0.917     0.522   0.0219  0.0866   12.9x    7.8x
  LightGBM (tuned)         0.950   0.948     0.637   0.0191  0.0730   14.0x    8.6x
  XGBoost (tuned, SHIPPED) 0.951   0.948     0.632   0.0192  0.0735   14.1x    8.6x

  (*) The heuristic sees only the last 30 minutes of history.

- Precision at the top: among the top 5% of moments ranked by the model, 47.9% make a
  >= 5-pt move within 30 minutes. In the top 10%, 29.2% do. The base rate is 3.4%.
- 90% group-bootstrap CI for XGBoost test AUC: 0.929 to 0.967.
  Gain over the vol_1h baseline: +0.018 to +0.043 AUC.
- Calibration is Platt (chosen over isotonic by CV log loss on CAL).
  Mean predicted p on test is 0.0344 vs an observed rate of 0.0335.
- Reliability by decile of calibrated p (mean p -> observed rate):
    deciles 1 to 8:  0.0003 to 0.0037 -> 0.001 to 0.005
    decile 9:        0.015 -> 0.025
    decile 10:       0.325 -> 0.292
  The top decile is slightly overconfident. Deciles 1 to 9 are slightly
  underconfident, partly because CAL has a lower base rate (2.2%) than TEST (3.4%).
- LightGBM and XGBoost are tied. XGBoost is shipped because it has the higher CV AUC
  and because the JS runtime walks XGBoost trees.

Per-segment test AUC (XGBoost vs the vol_1h baseline):
  segment            n       big moves  base    AUC xgb  AUC vol1h  mean p
  sports             20,301  792        3.9%    0.980    0.940      0.042
  economics           4,977  431        8.7%    0.896    0.872      0.092
  weather             2,115  334       15.8%    0.794    0.762      0.141
  crypto              1,586   65        4.1%    0.995    0.996      0.039
  politics           13,076   55        0.4%    0.694    0.793      0.005
  tech                7,472   34        0.5%    0.651    0.529      0.004
  entertainment       1,164   10        0.9%    0.898    0.625      0.013
  polymarket         49,886  1638       3.3%    0.947    0.918      0.034
  kalshi                805   83       10.3%    0.940    0.914      0.088
  full history       43,112  1445       3.4%    0.947    0.917      0.034
  truncated history   7,579  276        3.6%    0.952    0.930      0.038
  live_proxy = 1        705  326       46.2%    0.911    0.802      0.564

REGRESSOR: EXPECTED MAX MOVE (TEST)
  model                      MAE pts  RMSE pts  Spearman  mean pred  mean true
  XGBoost regressor (SHIP)   0.71     2.29      0.597     0.89       0.68
  vol_1h -> isotonic         0.73     2.62      0.666     0.85       0.68
  constant (train mean)      1.11     2.84      0.000     0.76       0.68
  heuristic fallback         (in ml/data/forecast_results.json)
- The regressor gives the best MAE and RMSE, but it ranks worse than plain vol_1h
  (Spearman 0.60 vs 0.67). Most targets are tiny or zero, so the rank correlation is
  dominated by ties.
- It over-predicts the test-period mean by about 0.2 pts, because the fit period was
  more volatile.
- Use pMove30 for ranking. Use expectedMovePts as a magnitude hint.


WHAT DRIVES IT
--------------
Top features by total gain:
  min_since_move    .204
  range_1h          .189
  maxjump_1h        .128
  range_6h          .121
  vol_1h            .055
  vol_6h            .049
  start_rel         .046
  log_hours_to_end  .029
  n_moves_6h        .026
  live_proxy        .026
  dist_mid          .017
  abs_ret_15m       .016

Top features by mean |SHAP| (exact TreeSHAP, 40k test rows, log-odds):
  range_6h          .63
  min_since_move    .43
  start_rel         .34
  vol_6h            .31
  range_1h          .21
  dist_mid          .17
  n_moves_6h        .16
  dist_bound        .13
  log_hours_to_end  .12
  p                 .10
  maxjump_1h        .08
  live_proxy        .08

In plain English:
- Volatility clusters. A market that moved >= 3 pts recently, or that has a wide 1h
  or 6h range, is by far the most likely to move again. This alone (vol_1h) gives
  AUC 0.92.
- Timing adds the rest:
    * Time since or to the scheduled start (games in progress, or about to start).
    * Time to resolution.
    * The live proxy: 46% of live moments make a big move.
- Mid-range prices (near 50%) move more than prices near 0 or 100.
- Vol acceleration (vr_15m_1h, vr_1h_6h), hour of day and day of week contribute
  little.

Feature list (pure JS, mirrored in forecaster.js):
  p, dist_mid, dist_bound, vol_15m, vol_1h, vol_6h, vr_15m_1h, vr_1h_6h, ret_5m,
  ret_15m, ret_1h, abs_ret_*, maxjump_1h, range_1h, range_6h, pos_range_6h,
  active_frac_1h, n_moves_6h, min_since_move, log_hours_to_end, past_end, start_rel
  (signed log1p hours since start), live_proxy, hour_utc, dow, is_kalshi,
  n_hist_min, cat_* (8 categories).

How live_proxy is computed:
- If a start time is known: 1 when now is within [start, start + 4h].
- Otherwise, for sports with an endDate: 1 when the market ends within -1h to +6h.
- Otherwise: 0.
It is computed from market.startTime and endDate, NOT from market.live, so that
training and serving agree.


CHOSEN HYPERPARAMETERS
----------------------
Classifier: XGBoost, 397 trees, Platt calibration.
  max_depth=5, learning_rate=0.01524, subsample=0.935, colsample_bytree=0.438,
  min_child_weight=47.4, reg_lambda=0.215, reg_alpha=0.0098, gamma=0.0017.

Regressor: XGBoost, 150 trees, reg:squarederror.
  max_depth=5, learning_rate=0.0677, subsample=0.859, colsample_bytree=0.559,
  min_child_weight=1.44, reg_lambda=9.29, reg_alpha=0.0117, gamma=0.0172.

LightGBM (not shipped):
  n_estimators=293, num_leaves=56, max_depth=5, learning_rate=0.0162,
  subsample=0.770, colsample_bytree=0.409, min_child_samples=14,
  reg_lambda=0.0022, reg_alpha=3.95.

Heuristic fallback:
- Logistic regression plus a linear model for the move size.
- Inputs: sqrt(vol of 1-minute diffs over the last 30 min), sqrt(range over the
  last 30 min), dist_mid, live_proxy, resolves within 1h, cat_sports.
- Fitted on 150k FIT rows. Its coefficients are stored in forecaster.json and also
  embedded in forecaster.js, so it works without the JSON.
- Mean prediction on test is 0.0327 vs a base rate of 0.0340. Test AUC is 0.917.


PARITY AND RUNTIME
------------------
- server/ml/forecaster.test.js checks 50 held-out test rows, oversampled to include
  15 positives and 10 truncated histories. JS matches Python on:
    * features: to 1e-9
    * classifier margin, raw and calibrated pMove30: to 1e-4
    * regressor output and Saabas contributions: to 1e-4
    * heuristic inputs (1e-9) and heuristic outputs (1e-6)
- The tests also cover:
    * the heuristic for < 30 minutes of history
    * the heuristic when the model is missing (setForecaster(null))
    * garbage input never throwing
    * unsorted, ISO-timestamp and future points
    * a latency guard
- node --test 'server/**/*.test.js': 123/123 pass.
- Latency (Apple Silicon, Node, 6h of 20-second polling = 1,080 points):
    * model path: ~0.05 ms per call, so 600 markets take ~30 ms per tick
    * short-history heuristic path: ~0.01 ms per call
- forecaster.json is 859 KB (547 trees).


LIMITATIONS
-----------
- The high AUC is partly easy. Most moments are calm markets that stay calm, so
  ranking calm vs. active is easy. The harder question is which active market moves
  next. On that, PR-AUC is 0.63, and the top 5% of moments are right about 48% of
  the time.
- AUC is still high for sports (0.98) and live moments (0.91).
- Politics and tech: big moves are rare (about 0.5%) and news-driven. AUC is only
  0.65 to 0.69, and for politics it is BELOW the vol_1h baseline. Do not over-trust
  pMove30 for these categories.
- The test set is small: 49 event groups over about 6.5 days, and about 75% sports.
  Other categories have only tens of positive events.
- Train/serve differences:
    * Kalshi has no start time.
    * Polymarket events[0].startTime is the event's creation time for non-sports
      events, so start_rel is noisy outside sports.
    * Live polling at 20 seconds is resampled to 1 minute; brief intra-minute spikes
      are invisible, as they were in training.
- Regressor: it is biased upward in the current (calmer) period, and it ranks worse
  than vol_1h.
- Pinned markets (whole last hour <= 0.02 or >= 0.98) were excluded from training.
  The runtime still scores them (they get very low predictions), but those
  predictions are out of distribution.
- Drivers use Saabas path attribution in log-odds, which approximates SHAP.
- No liquidity or volume features are used (snapshot-only data would leak).
