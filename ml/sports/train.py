"""Train, compare, calibrate and export the three in-game sport models.

Call ``train_sport`` with a collector's DataFrame. Splits are by complete game
in chronological order, and neither tuning nor fitting sees the test games.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import warnings

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.impute import SimpleImputer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from export import export_xgb, js_like_predict


HERE = Path(__file__).resolve().parent
EXPORT_DIR = HERE.parents[1] / "server" / "ml" / "sports"
SEED = 2049
MAX_MLP_ROWS = 300_000

BASELINE_FEATURES = {
    "soccer": ["minute", "goal_diff", "shots_us_10", "shots_them_10"],
    "football": ["yardline_100", "down", "ydstogo", "score_differential"],
    "basketball": ["lead", "sec_left_regulation", "run_trailer", "pts_trailer_2m"],
}


def _clean_number(x):
    if isinstance(x, (np.integer, int)):
        return int(x)
    if isinstance(x, (np.floating, float)):
        return float(x) if np.isfinite(x) else None
    return x


def _jsonable(obj):
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, np.ndarray)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (np.integer, np.floating, int, float)):
        return _clean_number(obj)
    if isinstance(obj, pd.Timestamp):
        return obj.isoformat()
    return obj


def chronological_split(df: pd.DataFrame, sport: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    if df["game_id"].isna().any() or df["game_date"].isna().any():
        raise ValueError("game_id and game_date must be present on every row")
    game_dates = (df.assign(_date=pd.to_datetime(df["game_date"], utc=True))
                  .groupby("game_id", sort=False)["_date"].min().sort_values(kind="stable"))
    games = list(game_dates.index)
    n = len(games)
    if n < 10:
        raise ValueError(f"At least 10 games required; got {n}")
    train_end = max(1, int(n * 0.70))
    cal_end = max(train_end + 1, int(n * 0.80))
    partitions = (games[:train_end], games[train_end:cal_end], games[cal_end:])
    masks = tuple(df["game_id"].isin(ids).to_numpy() for ids in partitions)
    if any(not mask.any() for mask in masks):
        raise ValueError("Chronological split yielded an empty partition")
    manifest = {
        "sport": sport, "method": "earliest game_date by game_id; ordered 70/10/20",
        "splits": {name: [{"game_id": str(g), "game_date": game_dates.loc[g].isoformat()}
                          for g in ids] for name, ids in zip(("train", "calibration", "test"), partitions)},
        "n_rows": {name: int(mask.sum()) for name, mask in zip(("train", "calibration", "test"), masks)},
    }
    if not (set(partitions[0]).isdisjoint(partitions[1]) and set(partitions[0]).isdisjoint(partitions[2])
            and set(partitions[1]).isdisjoint(partitions[2])):
        raise AssertionError("A game crossed the split boundary")
    data_dir = HERE / "data"
    data_dir.mkdir(exist_ok=True)
    (data_dir / f"{sport}_split.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return *masks, manifest


def _metrics(y: np.ndarray, p: np.ndarray) -> dict:
    p = np.clip(np.asarray(p, dtype=float), 1e-7, 1 - 1e-7)
    y = np.asarray(y, dtype=int)
    order = np.argsort(-p, kind="stable")
    k = max(1, int(np.ceil(len(y) * 0.1)))
    base = float(y.mean())
    top_rate = float(y[order[:k]].mean())
    # Quantile bins are rank-based so ties do not remove calibration deciles.
    ranked = np.argsort(np.argsort(p, kind="stable"), kind="stable")
    bins = np.minimum(9, ranked * 10 // len(y))
    reliability = []
    for decile in range(10):
        selected = bins == decile
        reliability.append({"decile": decile + 1, "n": int(selected.sum()),
                            "mean_predicted": float(p[selected].mean()) if selected.any() else None,
                            "observed": float(y[selected].mean()) if selected.any() else None})
    return {"auc": float(roc_auc_score(y, p)) if len(np.unique(y)) == 2 else None,
            "log_loss": float(log_loss(y, p, labels=[0, 1])),
            "brier": float(brier_score_loss(y, p)), "base_rate": base,
            "top_decile_rate": top_rate,
            "top_decile_lift": float(top_rate / base) if base > 0 else None,
            "calibration_deciles": reliability}


def _subset_for_mlp(X: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray, int]:
    if len(y) <= MAX_MLP_ROWS:
        return X, y, len(y)
    rng = np.random.default_rng(SEED)
    picks = []
    for label in (0, 1):
        ids = np.flatnonzero(y == label)
        count = max(1, int(round(MAX_MLP_ROWS * len(ids) / len(y))))
        picks.extend(rng.choice(ids, size=min(count, len(ids)), replace=False))
    picks = np.asarray(sorted(picks))
    return X[picks], y[picks], len(picks)


MAX_TREES = {3: 500, 4: 350, 5: 220}   # keeps each exported file under 1.5 MB


def _logit(p):
    p = np.clip(p, 1e-7, 1 - 1e-7)
    return np.log(p / (1 - p)).reshape(-1, 1)


def fit_calibration(kind, raw, y):
    if kind == "isotonic":
        return IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(raw, y)
    if kind == "platt":
        return LogisticRegression(C=1e6, max_iter=1000).fit(_logit(raw), y)
    return None


def apply_calibration(kind, cal, raw):
    if kind == "isotonic":
        return np.clip(cal.predict(raw), 1e-6, 1 - 1e-6)
    if kind == "platt":
        return cal.predict_proba(_logit(raw))[:, 1]
    return raw


def choose_calibration(raw, y, games):
    """2-fold by game on the calibration split: isotonic, Platt, or none, whichever has lower log loss."""
    uniq = pd.unique(games)
    half = np.isin(games, uniq[::2])
    scores = {}
    for kind in ("none", "platt", "isotonic"):
        ll = []
        for a, b in ((half, ~half), (~half, half)):
            cal = fit_calibration(kind, raw[a], y[a])
            ll.append(log_loss(y[b], apply_calibration(kind, cal, raw[b]), labels=[0, 1]))
        scores[kind] = float(np.mean(ll))
    print(f"    calibration CV log loss: {scores}", flush=True)
    return min(scores, key=scores.get)


def _fit_one(X: np.ndarray, labels: np.ndarray, masks: tuple[np.ndarray, ...],
             game_ids: np.ndarray,
             baseline_idx: list[int], sport: str, target: str) -> tuple[dict, dict, dict, np.ndarray]:
    train_mask, cal_mask, test_mask = masks
    Xt, yt = X[train_mask], labels[train_mask]
    Xc, yc = X[cal_mask], labels[cal_mask]
    Xs, ys = X[test_mask], labels[test_mask]
    if any(len(np.unique(z)) < 2 for z in (yt, yc, ys)):
        raise ValueError(f"{sport}/{target}: each partition needs both labels")

    # Obvious-feature baseline, fitted on training games only.
    baseline = make_pipeline(SimpleImputer(strategy="median", add_indicator=True),
                             StandardScaler(), LogisticRegression(max_iter=250, random_state=SEED))
    baseline.fit(Xt[:, baseline_idx], yt)
    baseline_p = baseline.predict_proba(Xs[:, baseline_idx])[:, 1]

    # Last 12% of training games serve as an internal tuning/early-stop set.
    # Use game IDs, never a row offset, so snapshots of one game remain together.
    ordered_games = pd.unique(game_ids[train_mask])
    n_inner = max(1, int(round(len(ordered_games) * 0.12)))
    tune_mask = np.isin(game_ids[train_mask], ordered_games[-n_inner:])
    fit_mask = ~tune_mask
    if len(np.unique(yt[fit_mask])) < 2 or len(np.unique(yt[tune_mask])) < 2:
        raise ValueError(f"{sport}/{target}: internal game split needs both labels")
    grid = [
        {"max_depth": 3, "learning_rate": 0.06, "min_child_weight": 20, "subsample": 0.85},
        {"max_depth": 4, "learning_rate": 0.05, "min_child_weight": 40, "subsample": 0.85},
        {"max_depth": 5, "learning_rate": 0.05, "min_child_weight": 80, "subsample": 0.80},
    ]
    best = None
    for params in grid:
        model = xgb.XGBClassifier(objective="binary:logistic", tree_method="hist", max_bin=128,
                                  n_estimators=MAX_TREES[params["max_depth"]], eval_metric="logloss",
                                  early_stopping_rounds=30,
                                  colsample_bytree=0.9, reg_lambda=3.0, random_state=SEED,
                                  n_jobs=4, **params)
        model.fit(Xt[fit_mask], yt[fit_mask], eval_set=[(Xt[tune_mask], yt[tune_mask])], verbose=False)
        score = float(log_loss(yt[tune_mask], model.predict_proba(Xt[tune_mask])[:, 1], labels=[0, 1]))
        if best is None or score < best[0]:
            best = (score, params, int(model.best_iteration) + 1)
    assert best is not None
    _, params, trees = best
    booster = xgb.XGBClassifier(objective="binary:logistic", tree_method="hist", max_bin=128,
                                n_estimators=trees, eval_metric="logloss", colsample_bytree=0.9,
                                reg_lambda=3.0, random_state=SEED, n_jobs=4, **params)
    booster.fit(Xt, yt, verbose=False)
    raw_c = booster.predict_proba(Xc)[:, 1]
    raw_s = booster.predict_proba(Xs)[:, 1]
    cal_kind = choose_calibration(raw_c, yc, game_ids[cal_mask])
    calibrator = fit_calibration(cal_kind, raw_c, yc)
    calibrated_s = apply_calibration(cal_kind, calibrator, raw_s)

    Xm, ym, mlp_rows = _subset_for_mlp(Xt, yt)
    mlp = make_pipeline(SimpleImputer(strategy="median", add_indicator=True), StandardScaler(),
                        MLPClassifier(hidden_layer_sizes=(64, 32), activation="relu", alpha=0.001,
                                      early_stopping=True, n_iter_no_change=8, max_iter=120,
                                      random_state=SEED))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        mlp.fit(Xm, ym)
    mlp_p = mlp.predict_proba(Xs)[:, 1]

    metrics = {"baseline": _metrics(ys, baseline_p), "xgboost": _metrics(ys, raw_s),
               "xgboost_calibrated": _metrics(ys, calibrated_s), "mlp": _metrics(ys, mlp_p)}
    importance = booster.feature_importances_.tolist()
    detail = {"metrics": metrics, "n_train_rows": int(len(yt)), "n_calibration_rows": int(len(yc)),
              "n_test_rows": int(len(ys)), "mlp_train_rows": int(mlp_rows),
              "tuning": {"internal_validation_log_loss": best[0], "best_iteration": trees,
                         "parameters": params}, "feature_importances": importance,
              "best_test_model": min(("baseline", "xgboost", "mlp"),
                                     key=lambda name: metrics[name]["log_loss"])}

    model_dir = HERE / "data" / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    booster.get_booster().save_model(model_dir / f"{sport}_{target}.ubj")
    # Include test cases in the export parity sample, plus a deterministic random sample.
    rng = np.random.default_rng(SEED)
    samples = np.concatenate([Xs[:min(40, len(Xs))], Xc[:min(20, len(Xc))],
                              Xt[rng.choice(len(Xt), size=min(100, len(Xt)), replace=False)]])
    exported = export_xgb(booster.get_booster(), samples)
    if cal_kind == "isotonic":
        exported["calibration"] = {"type": "isotonic", "x": calibrator.X_thresholds_.tolist(),
                                   "y": calibrator.y_thresholds_.tolist()}
    elif cal_kind == "platt":
        # Phone: p = 1 / (1 + exp(a * logit(raw) + b))
        exported["calibration"] = {"type": "platt", "a": float(-calibrator.coef_[0][0]),
                                   "b": float(-calibrator.intercept_[0])}
    detail["calibration"] = cal_kind
    probabilities = {"baseline": baseline_p, "xgboost": raw_s,
                     "xgboost_calibrated": calibrated_s, "mlp": mlp_p}
    return detail, exported, {"booster": booster, "calibrator": calibrator}, probabilities


def _fixture(row: pd.Series, sport: str, features: list[str], predictions: dict[str, float],
             fixture_builder=None) -> dict:
    if fixture_builder:
        item = fixture_builder(row)
    elif sport == "football":
        item = {"state": row.get("state") or {f: _clean_number(row[f]) for f in features}}
    else:
        item = {"timeline": row["timeline"], "at": _clean_number(row["at"])}
        if sport == "soccer":
            item["team"] = row["team"]
    item = _jsonable(item)
    item["x"] = [_clean_number(row[f]) for f in features]
    item["p"] = predictions
    item["game_id"] = str(row["game_id"])
    return item


def train_sport(df: pd.DataFrame, sport: str, features: list[str], labels: dict[str, str],
                fixture_builder=None, output_dir: Path | str = EXPORT_DIR) -> dict:
    """Train sport labels and write a phone-ready JSON plus a detailed report JSON."""
    features = list(features)
    required = ["game_id", "game_date", *features, *labels.values()]
    missing = sorted(set(required).difference(df.columns))
    if missing:
        raise ValueError(f"{sport}: missing columns {missing}")
    df = df.dropna(subset=list(labels.values())).copy()
    df["game_date"] = pd.to_datetime(df["game_date"], utc=True)
    df.sort_values(["game_date", "game_id"], kind="stable", inplace=True)
    df.reset_index(drop=True, inplace=True)
    masks = chronological_split(df, sport)
    train_mask, cal_mask, test_mask, manifest = masks
    X = df[features].to_numpy(dtype=float, copy=True)
    X[~np.isfinite(X)] = np.nan
    baseline_idx = [features.index(f) for f in BASELINE_FEATURES[sport]]
    details, models, fitted, test_probs = {}, {}, {}, {}
    for target, column in labels.items():
        print(f"Training {sport}/{target} ({len(df):,} rows)", flush=True)
        detail, exported, fit, probs = _fit_one(X, df[column].to_numpy(dtype=int),
                                                (train_mask, cal_mask, test_mask),
                                                df["game_id"].to_numpy(),
                                                baseline_idx, sport, target)
        detail["top_features"] = sorted(zip(features, detail.pop("feature_importances")),
                                        key=lambda pair: pair[1], reverse=True)[:10]
        details[target], models[target], fitted[target], test_probs[target] = detail, exported, fit, probs
    test_indices = np.flatnonzero(test_mask)
    # Spread the examples across test games rather than taking adjacent snapshots.
    spaced = np.unique(np.linspace(0, len(test_indices) - 1, num=min(40, len(test_indices)), dtype=int))
    fixtures = []
    for pos in spaced:
        idx = int(test_indices[pos])
        row = df.iloc[idx]
        probabilities = {target: float(test_probs[target]["xgboost_calibrated"][pos]) for target in labels}
        fixtures.append(_fixture(row, sport, features, probabilities, fixture_builder))

    # Compact row-level predictions let REPORT.md identify actual named moments
    # without fitting again or storing redundant raw timelines in the cache.
    test_columns = [column for column in
                    ("game_id", "game_date", "match_name", "at", "team", "play_id", "desc", "description",
                     "posteam", "defteam", "home_team", "away_team", "time", "qtr", *features)
                    if column in df.columns]
    test_columns = list(dict.fromkeys(test_columns))
    prediction_cache = df.loc[test_mask, test_columns].reset_index(drop=True).copy()
    for target, column in labels.items():
        prediction_cache[f"y_{target}"] = df.loc[test_mask, column].to_numpy(dtype=int)
        for name, values in test_probs[target].items():
            prediction_cache[f"p_{target}_{name}"] = values
    prediction_cache.to_parquet(HERE / "data" / f"{sport}_test_predictions.parquet", index=False)

    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    primary = next(iter(labels))
    envelope = {"format": "tipoff-sport-v1", "sport": sport,
                "label": primary, "trained_at": datetime.now(timezone.utc).isoformat(),
                "features": features, "models": models,
                "metrics": {"test_auc": details[primary]["metrics"]["xgboost_calibrated"]["auc"],
                            "test_logloss": details[primary]["metrics"]["xgboost_calibrated"]["log_loss"],
                            "base_rate": details[primary]["metrics"]["xgboost_calibrated"]["base_rate"],
                            "n_train_games": len(manifest["splits"]["train"]),
                            "n_calibration_games": len(manifest["splits"]["calibration"]),
                            "n_test_games": len(manifest["splits"]["test"]),
                            **{f"base_rate_{t}": details[t]["metrics"]["xgboost_calibrated"]["base_rate"] for t in labels},
                            **{f"test_auc_{t}": details[t]["metrics"]["xgboost_calibrated"]["auc"] for t in labels}},
                "fixtures": fixtures}
    path = output / f"{sport}.json"
    path.write_text(json.dumps(_jsonable(envelope), separators=(",", ":"), allow_nan=False) + "\n")
    size = path.stat().st_size
    if size >= 1_500_000:
        raise ValueError(f"{path} is {size:,} bytes, over 1.5 MB limit")
    report = {"sport": sport, "features": features, "labels": details,
              "n_games": int(df["game_id"].nunique()), "n_rows": len(df),
              "split": {name: {"games": len(manifest["splits"][name]), "rows": manifest["n_rows"][name]}
                        for name in ("train", "calibration", "test")},
              "export_bytes": size, "export_path": str(path)}
    (HERE / "data" / f"{sport}_training_report.json").write_text(json.dumps(_jsonable(report), indent=2) + "\n")
    return report
