# Spike classifier report

**Question:** when a prediction market jumps, is it a *real* information event (the
move holds) or noise (a thin-book wiggle that reverts)? Every detected spike gets a
calibrated `pReal` score from a gradient-boosted model.

## Dataset

- **32,156** candidate spikes from **826 markets** (503 event groups), built from
  10.45M real 1-minute price points, 2026-08-04 → 2026-10-15.
- Sources: Polymarket CLOB `prices-history` (28,829 spikes) and Kalshi 1-minute
  candlesticks (3,327). Mix of top-volume active markets plus markets closed in the
  previous 60 days.
- Category mix is ~75% sports, because in-play sports dominate prediction-market volume.
- **Candidate rule:** |Δp| ≥ 0.03 within ≤ 10 min on a 1-minute grid, 10-minute cooldown.
- **Label (`y30`):** a spike is real if, 30 minutes later, the price keeps at least
  50% of the move in the same direction.
- **Base rate:** 63.7% real at +30 min (60.2% at +60 min).

## Leakage protocol

- Features use only data available at detection time (prices ≤ `detectedAt`).
- Split by **time and by event group**: the test set is the latest 20% of time, and
  no event group appears in both training and test.
- A 60-minute purge separates training from later data.
- Hyperparameters are tuned with 4 time-ordered folds, keeping each fold's validation
  groups out of its training data.
- Calibration (Platt) is fitted on a separate validation slice.
- Liquidity and 24h volume are deliberately **excluded**: only today's snapshot exists
  (≈0 for closed markets), so training on them would leak.

## Results (held-out test: 1,727 spikes, 63.0% real)

| model | CV AUC | test AUC | PR-AUC | Brier | log loss | precision @ recall 0.8 | alert reduction vs rule |
|---|---|---|---|---|---|---|---|
| rule: \|z\| | 0.485 | 0.518 | 0.652 | 0.2362 | 0.674 | 0.632 | 3.4% |
| rule: \|Δ\| | 0.529 | 0.494 | 0.633 | 0.2365 | 0.693 | 0.630 | 0% |
| logistic regression | 0.572 | 0.567 | 0.678 | 0.2310 | 0.655 | 0.652 | 7.0% |
| random forest | 0.614 | 0.599 | 0.704 | 0.2287 | 0.649 | 0.676 | 9.1% |
| extra trees | 0.620 | 0.582 | 0.684 | 0.2304 | 0.654 | 0.667 | 7.1% |
| HistGradientBoosting | 0.604 | 0.578 | 0.690 | 0.2306 | 0.654 | 0.672 | 6.1% |
| **XGBoost (shipped)** | 0.620 | **0.606** | **0.704** | **0.2279** | **0.648** | **0.682** | **10.1%** |
| LightGBM | 0.621 | 0.599 | 0.703 | 0.2287 | 0.650 | 0.680 | 9.0% |

- 90% group-bootstrap CI for XGBoost test AUC: **0.563–0.641**. Its AUC lift over
  the |z| rule is +0.03 to +0.14.
- The plain threshold rule is no better than the base rate: its alerts are 63.3%
  real. Ranked by `pReal`, the model catches the same real events with ~10% fewer alerts.
- **Lift by quintile:** the real-event rate rises from **46%** in the lowest-scored
  fifth to **72%** in the highest fifth.
- **Label bands** (thresholds set on the calibration set):

  | band | rule | test rows | real |
  |---|---|---|---|
  | `event` | pReal ≥ 0.789 | 48 | 77% |
  | `likely` | pReal ≥ 0.593 | 1,487 | 65% |
  | `noise` | below 0.593 | 192 | 42% |

## Shipped model

- XGBoost, 422 trees, with Platt calibration.
- Hyperparameters: `max_depth=2`, `learning_rate=0.0362`, `subsample=0.799`,
  `colsample_bytree=0.504`, `min_child_weight=1.68`, `reg_lambda=9.87`,
  `reg_alpha=0.030`, `gamma=0.010`.
- Tuned with Optuna (80 trials each for XGBoost and LightGBM).
- Exported to `server/ml/model.json` and scored in pure JS (`server/ml/scorer.js`).
  JS matches Python to 1e-4 on 50 held-out rows.

## What drives the score

- Top features by mean |SHAP|: `cat_sports`, `momentum_align`, `window_min`,
  `pos_range`, `p_to`, `dist_bound`, `ret_6h`, `vr10_6h`, `spiky_min_6h`, `p_from`.
- Top by gain: `momentum_align`, `p_to`, `window_min`, `pos_range`, `dist_bound`,
  `ret_6h`, `vr10_6h`, `log_hours_to_end`, `ret_1h`, `p_from`.
- Plain-English takeaways:
  - **Speed:** instant 1-minute jumps are real only 57% of the time, while moves that
    build over ~10 minutes are real 73% of the time.
  - **Momentum:** spikes that extend an existing trend revert more often than spikes
    that break it.
  - **Price level:** spikes landing near 0% or 100%, or at the edge of the 6h range,
    behave differently from mid-range moves.

## Limitations (read before trusting it)

- **Weak signal.** AUC ≈ 0.6. The news that causes a move is unobserved, so price
  history alone can only say so much. Use `pReal` to rank and de-emphasize alerts,
  not as a hard filter.
- **Small test set:** about 125 event groups over 5 days. Sports-heavy.
- **No liquidity or volume features** yet. Recording them at detection time going
  forward would enable this.
- **Train/live mismatch:** training replays a 0.03 threshold on a 1-minute grid, while
  the live detector polls every 20s and fires at 0.05 or on z-score.
- **Cold start:** scores are less reliable with under 60 minutes of history (see
  `historyMinutes` in the output).
- **Drivers are approximate:** they use path attribution, which approximates SHAP.
