# ml/ — spike classifier

Trains the model that gives each detected spike a `pReal` score. Results and caveats
are in [REPORT.md](REPORT.md).

## Setup

```bash
bash ml/setup_env.sh   # creates ml/.venv; patches xgboost/lightgbm to use sklearn's bundled OpenMP
                       # (alternative: brew install libomp)
```

## Recollect and retrain

```bash
ml/.venv/bin/python ml/collect.py    # --pm-active 200 --pm-closed 300 --kalshi 150 --days 14 [--build-only]
ml/.venv/bin/python ml/train.py      # --trials 80 --label y30
node --test server/ml/*.test.js      # JS/Python parity check
```

- `collect.py` makes at most 4 requests at a time, retries 429s with backoff, and
  caches raw responses in `ml/data/raw/` (gitignored, ~360MB).
- `train.py` writes `server/ml/model.json`, `server/ml/fixtures.json` and
  `ml/data/results.json`.
- `ml/features.py` and `featuresFor()` in `server/ml/scorer.js` must change together.
  The parity test catches drift.
