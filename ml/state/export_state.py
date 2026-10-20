"""Train a phone-sized version of the coarse state model and export it (SPEC section 4).

python ml/state/export_state.py  ->  server/ml/state/state.json
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import log_loss

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "sports"))
import features as F  # noqa: E402
import train_state as T  # noqa: E402
from export import js_like_predict, xgb_trees  # noqa: E402

OUT = HERE.parents[1] / "server" / "ml" / "state" / "state.json"


def softmax(z):
    z = z - z.max(1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(1, keepdims=True)


def main():
    report = json.loads((T.DATA / "state_report_coarse.json").read_text())
    T.KALMAN.update(report["kalman"])
    df = T.load_rows(coarse=True)
    tr, ca, te = T.split(df)
    keep = set(df.loc[tr, "state"].unique())
    df = df[df["state"].isin(keep)].reset_index(drop=True)
    tr, ca, te = T.split(df)
    classes = sorted(keep)
    y = df["state"].map({c: i for i, c in enumerate(classes)}).values
    X = df[F.FEATURES].values.astype(float)

    m = xgb.XGBClassifier(objective="multi:softprob", num_class=len(classes), tree_method="hist", max_bin=128,
                          n_estimators=160, learning_rate=0.12, max_depth=4, min_child_weight=40, subsample=0.85,
                          colsample_bytree=0.9, reg_lambda=3.0, early_stopping_rounds=20, eval_metric="mlogloss",
                          random_state=T.SEED, n_jobs=6)
    m.fit(X[tr], y[tr], eval_set=[(X[ca], y[ca])], verbose=False)
    P = m.predict_proba(X[te])
    full = report["models"]["xgboost"]
    compact = T.metrics(y[te], P, classes)
    print(f"compact: acc {compact['accuracy']:.3f} logloss {compact['log_loss']:.3f} "
          f"confident {compact['confident_share']:.1%} @ {compact['confident_accuracy']:.3f}   "
          f"(full: acc {full['accuracy']:.3f} logloss {full['log_loss']:.3f})", flush=True)

    booster = m.get_booster()
    booster.feature_names = None
    trees = xgb_trees(booster, len(F.FEATURES))
    C = len(classes)
    sample = np.concatenate([X[te][:300], X[tr][:300]])
    dm = xgb.DMatrix(sample, missing=np.nan)
    margin = booster.predict(dm, output_margin=True)
    leaves = booster.predict(dm, pred_leaf=True).astype(int)
    per_class = []
    for c in range(C):
        idx = list(range(c, len(trees), C))
        cls_trees = [trees[k] for k in idx]
        leaf_sum = np.array([sum(trees[k]["v"][leaves[r, k]] for k in idx) for r in range(len(sample))])
        base = float(np.median(margin[:, c] - leaf_sum))
        ens = {"base_margin": base, "trees": cls_trees}
        err = float(np.max(np.abs(js_like_predict(ens, sample) - margin[:, c])))
        assert err < 1e-4, (classes[c], err)
        per_class.append(ens)

    # Fixtures: raw price series + game start + minute, so Swift re-runs grid, Kalman and features.
    prices = pd.read_parquet(T.DATA / "prices.parquet")
    markets = pd.read_parquet(T.DATA / "markets.parquet").set_index("token_id")
    px_by = {k: g.sort_values("t") for k, g in prices.groupby("token_id")}
    test = df[te].reset_index(drop=True)
    fixtures = []
    rng = np.random.default_rng(T.SEED)
    for sport in sorted(test.sport.unique()):
        rows = test[test.sport == sport]
        pick = rows.iloc[rng.choice(len(rows), size=min(40, len(rows)), replace=False)]
        for r in pick.itertuples(index=False):
            px = px_by[r.market_id]
            start = int(pd.Timestamp(markets.loc[r.market_id, "game_start"]).floor("min").timestamp())
            pts = [[int(t), float(p)] for t, p in zip(px["t"], px["p"]) if t <= start + 60 * r.minute]
            x = [getattr(r, f) for f in F.FEATURES]
            probs = softmax(np.array([[js_like_predict(e, np.array([x]))[0] for e in per_class]]))[0]
            fixtures.append({"sport": sport, "start": start, "minute": int(r.minute), "prices": pts,
                             "x": [None if (isinstance(v, float) and np.isnan(v)) else v for v in x],
                             "probs": {c: float(p) for c, p in zip(classes, probs)}, "truth": r.state})

    out = {"format": "tipoff-state-v1", "trained_at": datetime.now(timezone.utc).isoformat(),
           "sports": F.SPORTS, "features": F.FEATURES, "classes": classes, "kalman": T.KALMAN,
           "models": {c: e for c, e in zip(classes, per_class)},
           "metrics": {"test_accuracy": compact["accuracy"], "test_log_loss": compact["log_loss"],
                       "confident_share": compact["confident_share"], "confident_accuracy": compact["confident_accuracy"],
                       "per_class": {c: {k: compact["per_class"][c][k] for k in ("precision", "recall", "support")} for c in classes},
                       "class_prior": report["class_share"]},
           "fixtures": fixtures}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":"), allow_nan=False))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB, {len(trees)} trees, {len(fixtures)} fixtures)")


if __name__ == "__main__":
    main()
