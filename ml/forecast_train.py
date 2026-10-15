"""Train + evaluate the Moment Forecaster; export server/ml/forecaster.json.

Task: at decision time T (info <= T only), will the market make a big move soon?
  y        = max_{k in (0, 30 min]} |p(T+k) - p(T)| >= 0.05   (classifier)
  max_move = that max |move|                                 (regressor)
Data: ml/data/forecast.parquet from ml/forecast_data.py.

Leakage protocol (same as ml/train.py):
  * groups = Polymarket event / Kalshi event. TEST = latest 20% of time AND
    test-hashed groups; TRAIN = other groups, before T_test - 60 min purge.
  * CAL (calibration) = 30% of train groups in the latest 25% of train time;
    FIT = the remaining groups before T_cal - purge.
  * Optuna tuning: 4 grouped expanding-window folds on FIT (validation groups
    removed from each fold's training data, 60-min purge).

Usage: ml/.venv/bin/python ml/forecast_train.py [--trials 60] [--tune-rows 200000]
"""
import argparse
import json
import math
import os
import sys
import time
import warnings
from datetime import datetime, timezone

import lightgbm as lgb
import numpy as np
import optuna
import pandas as pd
import xgboost as xgb
from scipy.stats import spearmanr
from sklearn.impute import SimpleImputer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.metrics import (average_precision_score, brier_score_loss, log_loss, mean_absolute_error,
                             mean_squared_error, roc_auc_score)
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from forecast_features import CATEGORIES, FEATURES, compute_features, grid_for  # noqa: E402
from train import choose_calibrator, cv_folds, h01, js_like_predict, lgb_model, lgb_space, xgb_space, xgb_trees  # noqa: E402

warnings.filterwarnings("ignore")
optuna.logging.set_verbosity(optuna.logging.WARNING)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER_ML = os.path.join(ROOT, "server", "ml")
PURGE_MS = 60 * 60_000
SEED = 7
HEUR_FEATURES = ["h_vol30", "h_range30", "dist_mid", "live_proxy", "h_end_1h", "cat_sports"]


# ----------------------------------------------------------------- helpers
def make_splits(df):
    t = df["t_ms"].values
    T_test = np.quantile(t, 0.8)
    gtest = df["group"].map(lambda g: h01(g, "test") < 0.25).values
    test = gtest & (t >= T_test)
    train = (~gtest) & (t < T_test - PURGE_MS)
    T_cal = np.quantile(t[train], 0.75)
    gcal = df["group"].map(lambda g: h01(g, "cal") < 0.3).values
    cal = train & gcal & (t >= T_cal)
    fit = train & (~gcal) & (t < T_cal - PURGE_MS)
    return fit, cal, test, T_test, T_cal


def lift(y, s, q):
    k = max(int(round(q * len(y))), 1)
    top = np.argsort(-s, kind="mergesort")[:k]
    return float(y[top].mean() / max(y.mean(), 1e-9)), float(y[top].mean())


def cls_metrics(y, prob, score=None):
    score = prob if score is None else score
    l5, r5 = lift(y, score, 0.05)
    l10, r10 = lift(y, score, 0.10)
    return {"roc_auc": roc_auc_score(y, score), "pr_auc": average_precision_score(y, score),
            "brier": brier_score_loss(y, prob), "log_loss": log_loss(y, np.clip(prob, 1e-6, 1 - 1e-6)),
            "lift_top5": l5, "rate_top5": r5, "lift_top10": l10, "rate_top10": r10}


def xgb_cls(p, n_jobs=8):
    return xgb.XGBClassifier(**{k: v for k, v in p.items()}, tree_method="hist", objective="binary:logistic",
                             eval_metric="logloss", random_state=SEED, n_jobs=n_jobs)


def xgb_reg(p, n_jobs=8):
    return xgb.XGBRegressor(**{k: v for k, v in p.items()}, tree_method="hist", objective="reg:squarederror",
                            random_state=SEED, n_jobs=n_jobs)


def tune(name, space, build, X, y, folds, trials, scorer):
    def obj(tr):
        p = space(tr)
        vals = []
        for a, b in folds:
            m = build(p).fit(X[a], y[a])
            vals.append(scorer(y[b], m, X[b]))
        return float(np.mean(vals))

    st = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=SEED))
    t0 = time.time()
    st.optimize(obj, n_trials=trials)
    print(f"  {name}: best CV {st.best_value:.4f} in {time.time() - t0:.0f}s  {st.best_params}", flush=True)
    return st.best_params, st.best_value


def auc_scorer(y, m, X):
    return roc_auc_score(y, m.predict_proba(X)[:, 1])


def export_xgb(booster, Xs):
    booster.feature_names = None
    trees = xgb_trees(booster, [f"f{i}" for i in range(len(FEATURES))])
    dm = xgb.DMatrix(Xs, missing=np.nan)
    margin = booster.predict(dm, output_margin=True)
    leaves = booster.predict(dm, pred_leaf=True).astype(int)
    leaf_sum = np.array([sum(trees[k]["v"][leaves[r, k]] for k in range(len(trees))) for r in range(len(leaves))])
    base = float(np.median(margin - leaf_sum))
    chk = js_like_predict({"trees": trees, "base_margin": base}, Xs)
    assert np.max(np.abs(chk - margin)) < 1e-4, np.max(np.abs(chk - margin))
    return {"base_margin": base, "trees": trees}


# ---------------------------------------------------------- heuristic fallback
def heur_from_grid(g, f):
    """Heuristic inputs from only the LAST 30 MINUTES of the grid (works on cold start).
    f = full feature dict (for dist_mid / live_proxy / hours-to-end / category)."""
    w = [float(v) for v in g[-31:]]
    d = [w[k] - w[k - 1] for k in range(1, len(w)) if not (math.isnan(w[k]) or math.isnan(w[k - 1]))]
    if len(d) >= 3:
        m = sum(d) / len(d)
        vol = math.sqrt(sum((v - m) ** 2 for v in d) / len(d))
    else:
        vol = float("nan")
    v = [x for x in w if not math.isnan(x)]
    rng = (max(v) - min(v)) if len(v) >= 2 else 0.0
    lhte = f["log_hours_to_end"]
    end1 = 1.0 if (not math.isnan(lhte) and f["past_end"] == 0 and lhte <= math.log1p(1.0)) else 0.0
    return [vol, rng, f["dist_mid"], f["live_proxy"], end1, f["cat_sports"]]


def heur_matrix(df):
    """Vectorised equivalent of heur_from_grid for full-history rows is not possible from the stored
    features, so recompute from raw history (cheap: only the last 31 minutes)."""
    from collect import kalshi_history, pm_history
    mk = {m["market_id"]: m for m in json.load(open(os.path.join(HERE, "data", "markets.json")))}
    days = json.load(open(os.path.join(HERE, "data", "collect_meta.json"))).get("days", 14)
    out = np.full((len(df), len(HEUR_FEATURES)), np.nan)
    for mid, idx in df.groupby("market_id").indices.items():
        m = mk[mid]
        pts = pm_history(m, days) if m["source"] == "polymarket" else kalshi_history(m, days)
        ts = np.array([a for a, _ in pts], float) * 1000
        ps = np.array([b for _, b in pts], float)
        sub = df.iloc[idx]
        for j, (_, r) in zip(idx, sub.iterrows()):
            T = r.t_ms
            lo = r.hist_lo_ms if r.hist_lo_ms >= 0 else -np.inf
            k0 = int(np.searchsorted(ts, lo, side="left"))
            g = grid_for(ts[k0:], ps[k0:], T)
            out[j] = heur_from_grid(g, r)
    return out


def fit_heuristic(Hf, yf, mf):
    med_vol = float(np.nanmedian(Hf[:, 0]))
    H = Hf.copy()
    H[np.isnan(H[:, 0]), 0] = med_vol
    H[:, 0] = np.sqrt(H[:, 0])  # sqrt(vol), sqrt(range): compress heavy tails
    H[:, 1] = np.sqrt(H[:, 1])
    mu, sd = H.mean(0), H.std(0) + 1e-12
    lr = LogisticRegression(C=1.0, max_iter=2000).fit((H - mu) / sd, yf)
    lin = LinearRegression().fit((H - mu) / sd, mf)
    return {"features": HEUR_FEATURES, "impute_vol30": med_vol, "transform": "sqrt on h_vol30 and h_range30",
            "mean": mu.tolist(), "scale": sd.tolist(),
            "logit_coef": lr.coef_[0].tolist(), "logit_intercept": float(lr.intercept_[0]),
            "move_coef": lin.coef_.tolist(), "move_intercept": float(lin.intercept_)}


def heur_predict(h, H):
    H = H.copy()
    H[np.isnan(H[:, 0]), 0] = h["impute_vol30"]
    H[:, 0] = np.sqrt(H[:, 0])
    H[:, 1] = np.sqrt(H[:, 1])
    Z = (H - np.array(h["mean"])) / np.array(h["scale"])
    p = 1 / (1 + np.exp(-(Z @ np.array(h["logit_coef"]) + h["logit_intercept"])))
    mv = np.maximum(Z @ np.array(h["move_coef"]) + h["move_intercept"], 0.0)
    return p, mv


# ----------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=60)
    ap.add_argument("--reg-trials", type=int, default=20)
    ap.add_argument("--tune-rows", type=int, default=200_000)
    args = ap.parse_args()
    t_start = time.time()

    df = pd.read_parquet(os.path.join(HERE, "data", "forecast.parquet")).sort_values("t_ms").reset_index(drop=True)
    X_all = df[FEATURES].values.astype(np.float64)
    y_all = df["y"].values.astype(int)
    m_all = df["max_move"].values
    fit, cal, test, T_test, T_cal = make_splits(df)
    assert not (set(df.group[fit]) & set(df.group[test])) and not (set(df.group[cal]) & set(df.group[test]))
    assert not (set(df.group[fit]) & set(df.group[cal]))
    print(f"rows={len(df)} markets={df.market_id.nunique()} groups={df.group.nunique()} base={y_all.mean():.4f}")
    print(f"FIT={fit.sum()} CAL={cal.sum()} TEST={test.sum()} T_cal={pd.Timestamp(T_cal, unit='ms')} "
          f"T_test={pd.Timestamp(T_test, unit='ms')}", flush=True)
    Xf, yf, mf = X_all[fit], y_all[fit], m_all[fit]
    Xc, yc = X_all[cal], y_all[cal]
    Xt, yt, mt = X_all[test], y_all[test], m_all[test]
    dfit = df[fit].reset_index(drop=True)
    dtest = df[test].reset_index(drop=True)

    # tuning subsample of FIT (random rows, time order kept) + grouped time folds
    rng = np.random.default_rng(SEED)
    sub = np.sort(rng.choice(len(dfit), min(args.tune_rows, len(dfit)), replace=False))
    dsub = dfit.iloc[sub].reset_index(drop=True)
    folds = cv_folds(dsub)
    Xs, ys, ms = Xf[sub], yf[sub], mf[sub]
    print(f"CV folds on {len(sub)} tuning rows: {[(len(a), len(b)) for a, b in folds]}", flush=True)

    results = {}
    # ---- baseline (a): 1h realized vol alone (isotonic-calibrated on CAL)
    v_c = np.nan_to_num(df.loc[cal, "vol_1h"].values, nan=-1)
    v_t = np.nan_to_num(dtest["vol_1h"].values, nan=-1)
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(v_c, yc)
    results["baseline_vol_1h"] = cls_metrics(yt, np.clip(iso.predict(v_t), 1e-6, 1 - 1e-6), score=v_t)
    results["baseline_vol_1h"]["cv_auc"] = float(np.mean(
        [roc_auc_score(ys[b], np.nan_to_num(dsub["vol_1h"].values[b], nan=-1)) for _, b in folds]))
    # ---- baseline (b): logistic regression
    lr = make_pipeline(SimpleImputer(strategy="median", add_indicator=True), StandardScaler(),
                       LogisticRegression(C=0.5, max_iter=3000))
    results["logreg"] = {"cv_auc": float(np.mean([auc_scorer(ys[b], make_pipeline(
        SimpleImputer(strategy="median", add_indicator=True), StandardScaler(),
        LogisticRegression(C=0.5, max_iter=3000)).fit(Xs[a], ys[a]), Xs[b]) for a, b in folds]))}
    lr.fit(Xf, yf)
    cl, _ = choose_calibrator(lr.predict_proba(Xc)[:, 1], yc)
    raw = lr.predict_proba(Xt)[:, 1]
    results["logreg"].update(cls_metrics(yt, np.clip(cl.predict(raw), 1e-6, 1 - 1e-6), score=raw))
    print("  baselines:", {k: round(v["roc_auc"], 4) for k, v in results.items()}, flush=True)

    # ---- tuned GBMs
    xgb_p, xgb_cv = tune("xgboost", xgb_space, lambda p: xgb_cls(p), Xs, ys, folds, args.trials, auc_scorer)
    lgb_p, lgb_cv = tune("lightgbm", lgb_space, lambda p: lgb_model({**p}).set_params(n_jobs=8), Xs, ys, folds,
                         args.trials, auc_scorer)
    fitted = {}
    for name, mk, cv in (("xgboost", lambda: xgb_cls(xgb_p), xgb_cv),
                         ("lightgbm", lambda: lgb_model(lgb_p).set_params(n_jobs=8), lgb_cv)):
        m = mk().fit(Xf, yf)
        raw_c, raw_t = m.predict_proba(Xc)[:, 1], m.predict_proba(Xt)[:, 1]
        calib, cal_scores = choose_calibrator(raw_c, yc)
        r = cls_metrics(yt, np.clip(calib.predict(raw_t), 1e-6, 1 - 1e-6), score=raw_t)
        r.update(cv_auc=cv, calibration=calib.kind, raw_brier=brier_score_loss(yt, raw_t),
                 cal_cv_logloss=cal_scores)
        results[name] = r
        fitted[name] = (m, calib)
        print(f"  {name}: test auc {r['roc_auc']:.4f} pr {r['pr_auc']:.4f} brier {r['brier']:.5f} "
              f"lift5 {r['lift_top5']:.2f} cal={calib.kind}", flush=True)

    # ---- regressor for expected max move
    def neg_rmse(y, m, X):
        return -math.sqrt(mean_squared_error(y, m.predict(X)))

    reg_space = lambda tr: {k: v for k, v in xgb_space(tr).items()}  # noqa: E731
    reg_p, reg_cv = tune("xgb-regressor", reg_space, lambda p: xgb_reg(p), Xs, ms, folds, args.reg_trials, neg_rmse)
    reg = xgb_reg(reg_p).fit(Xf, mf)
    pm_t = np.maximum(reg.predict(Xt), 0)
    iso_m = IsotonicRegression(out_of_bounds="clip").fit(v_c, m_all[cal])
    regres = {}
    for name, pred in (("xgb_regressor", pm_t), ("baseline_vol_1h_isotonic", iso_m.predict(v_t)),
                       ("baseline_constant_mean", np.full(len(mt), mf.mean()))):
        regres[name] = {"mae_pts": 100 * mean_absolute_error(mt, pred),
                        "rmse_pts": 100 * math.sqrt(mean_squared_error(mt, pred)),
                        "spearman": float(spearmanr(mt, pred).correlation) if np.std(pred) > 0 else 0.0,
                        "mean_pred_pts": 100 * float(pred.mean()), "mean_true_pts": 100 * float(mt.mean())}
    print("  regression:", json.dumps(regres), flush=True)

    # ---- heuristic fallback (last-30-min info only)
    print("  computing heuristic inputs ...", flush=True)
    Hf_idx = np.sort(rng.choice(np.where(fit)[0], min(150_000, fit.sum()), replace=False))
    Hf = heur_matrix(df.iloc[Hf_idx].reset_index(drop=True))
    heur = fit_heuristic(Hf, y_all[Hf_idx], m_all[Hf_idx])
    Ht = heur_matrix(dtest)
    hp, hm = heur_predict(heur, Ht)
    results["heuristic_fallback"] = cls_metrics(yt, hp)
    regres["heuristic_fallback"] = {"mae_pts": 100 * mean_absolute_error(mt, hm),
                                    "rmse_pts": 100 * math.sqrt(mean_squared_error(mt, hm)),
                                    "spearman": float(spearmanr(mt, hm).correlation),
                                    "mean_pred_pts": 100 * float(hm.mean()), "mean_true_pts": 100 * float(mt.mean())}
    print(f"  heuristic: auc {results['heuristic_fallback']['roc_auc']:.4f} brier "
          f"{results['heuristic_fallback']['brier']:.5f} mean p {hp.mean():.4f} vs base {yt.mean():.4f}", flush=True)

    # ---- chosen classifier: xgboost (JS evaluator walks xgboost trees)
    chosen_cv = "xgboost" if xgb_cv >= lgb_cv - 0.002 else "lightgbm"
    model, calib = fitted["xgboost"]
    booster = model.get_booster()
    p_t = np.clip(calib.predict(booster.predict(xgb.DMatrix(Xt, missing=np.nan))), 1e-6, 1 - 1e-6)
    raw_t = booster.predict(xgb.DMatrix(Xt, missing=np.nan))

    # per-category / subset metrics
    per_cat = {}
    for c in CATEGORIES + ["polymarket", "kalshi", "full_history", "truncated_history", "live_proxy"]:
        if c in CATEGORIES:
            mask = dtest["category"].values == c
        elif c in ("polymarket", "kalshi"):
            mask = dtest["source"].values == c
        elif c == "full_history":
            mask = ~dtest["trunc"].values
        elif c == "truncated_history":
            mask = dtest["trunc"].values
        else:
            mask = dtest["live_proxy"].values == 1
        if mask.sum() < 50 or len(np.unique(yt[mask])) < 2:
            per_cat[c] = {"n": int(mask.sum()), "pos": int(yt[mask].sum())}
            continue
        per_cat[c] = {"n": int(mask.sum()), "pos": int(yt[mask].sum()), "base": float(yt[mask].mean()),
                      "auc_xgb": roc_auc_score(yt[mask], raw_t[mask]),
                      "auc_vol1h": roc_auc_score(yt[mask], v_t[mask]),
                      "mean_p": float(p_t[mask].mean())}

    # group bootstrap CI (xgb AUC and gain over vol_1h)
    gt = dtest["group"].values
    gidx = {g: np.where(gt == g)[0] for g in np.unique(gt)}
    ug = np.array(list(gidx))
    bx, bd = [], []
    for _ in range(200):
        idx = np.concatenate([gidx[g] for g in rng.choice(ug, len(ug), replace=True)])
        if len(np.unique(yt[idx])) < 2:
            continue
        a = roc_auc_score(yt[idx], raw_t[idx])
        bx.append(a)
        bd.append(a - roc_auc_score(yt[idx], v_t[idx]))
    boot = {"xgb_auc_90ci": [float(np.quantile(bx, 0.05)), float(np.quantile(bx, 0.95))],
            "xgb_minus_vol1h_auc_90ci": [float(np.quantile(bd, 0.05)), float(np.quantile(bd, 0.95))]}
    # reliability by decile of calibrated p
    q = pd.qcut(p_t, 10, labels=False, duplicates="drop")
    reliab = [{"mean_p": float(p_t[q == i].mean()), "rate": float(yt[q == i].mean()), "n": int((q == i).sum())}
              for i in range(int(q.max()) + 1)]

    # importance: gain + SHAP (exact TreeSHAP on a test sample)
    gain = booster.get_score(importance_type="total_gain")
    tot = sum(gain.values()) or 1
    names = booster.feature_names or [f"f{i}" for i in range(len(FEATURES))]
    gain_imp = {}
    for k, v in gain.items():
        i = names.index(k) if k in names else int(k[1:])
        gain_imp[FEATURES[i]] = v / tot
    si = rng.choice(len(Xt), min(40_000, len(Xt)), replace=False)
    shap = booster.predict(xgb.DMatrix(Xt[si], missing=np.nan), pred_contribs=True)[:, :-1]
    shap_imp = dict(zip(FEATURES, np.abs(shap).mean(0).tolist()))

    # ---- export
    cls_exp = export_xgb(booster, Xt[:200])
    reg_booster = reg.get_booster()
    reg_exp = export_xgb(reg_booster, Xt[:200])
    trained_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    clean = lambda d: {k: (None if isinstance(v, float) and not math.isfinite(v) else v)  # noqa: E731
                       for k, v in d.items() if not isinstance(v, (dict, str))}
    out = {
        "format": "oddshot-forecaster-v1",
        "model": f"xgboost-forecast@{trained_at[:10]}",
        "trained_at": trained_at,
        "label": {"name": "y", "horizon_min": 30, "threshold": 0.05,
                  "definition": "max |p(t+k) - p(t)| over k in (0, 30 min] >= 0.05 (1-minute grid)"},
        "features": FEATURES,
        "feature_params": {"step_ms": 60000, "lookback_min": 360, "move_min_delta": 0.03, "move_window_min": 10,
                           "move_cooldown_min": 10, "vol_eps": 0.0005, "pin_lo": 0.02, "pin_hi": 0.98,
                           "game_len_h": 4, "live_end_h": 6, "min_history_min": 30},
        "classifier": {**cls_exp, "calibration": calib.export()},
        "regressor": {**reg_exp, "target": "max |dp| over next 30 min, probability units (x100 = pts)"},
        "heuristic": heur,
        "metadata": {
            "n_samples": int(len(df)), "n_fit": int(fit.sum()), "n_cal": int(cal.sum()), "n_test": int(test.sum()),
            "base_rate": float(y_all.mean()), "test_base_rate": float(yt.mean()),
            "classifier_hyperparams": xgb_p, "regressor_hyperparams": reg_p,
            "test_metrics": clean(results["xgboost"]), "regressor_test_metrics": regres["xgb_regressor"],
            "heuristic_test_metrics": clean(results["heuristic_fallback"]),
            "xgboost_version": xgb.__version__,
        },
    }
    os.makedirs(SERVER_ML, exist_ok=True)
    with open(os.path.join(SERVER_ML, "forecaster.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"exported server/ml/forecaster.json ({len(cls_exp['trees'])} + {len(reg_exp['trees'])} trees)", flush=True)
    export_fixtures(dtest, booster, reg_booster, calib, out, heur)
    embed_heuristic(heur)

    with open(os.path.join(HERE, "data", "forecast_results.json"), "w") as f:
        json.dump({"results": results, "regression": regres, "per_category": per_cat, "bootstrap": boot,
                   "reliability": reliab, "xgb_params": xgb_p, "lgb_params": lgb_p, "reg_params": reg_p,
                   "xgb_cv": xgb_cv, "lgb_cv": lgb_cv, "reg_cv_neg_rmse": reg_cv, "cv_winner": chosen_cv,
                   "gain": gain_imp, "shap": shap_imp, "heuristic": heur,
                   "n": int(len(df)), "markets": int(df.market_id.nunique()), "groups": int(df.group.nunique()),
                   "base_rate": float(y_all.mean()),
                   "split": {"fit": int(fit.sum()), "cal": int(cal.sum()), "test": int(test.sum()),
                             "T_cal": int(T_cal), "T_test": int(T_test), "fit_base": float(yf.mean()),
                             "cal_base": float(yc.mean()), "test_base": float(yt.mean()),
                             "test_groups": int(dtest.group.nunique()), "test_markets": int(dtest.market_id.nunique())},
                   "by_category": df.groupby("category")["y"].agg(["size", "mean"]).to_dict(),
                   "by_source": df.groupby("source")["y"].agg(["size", "mean"]).to_dict(),
                   "t_min": int(df.t_ms.min()), "t_max": int(df.t_ms.max()),
                   "trained_at": trained_at, "runtime_s": time.time() - t_start}, f, indent=1, default=float)
    print(f"done in {time.time() - t_start:.0f}s")


def embed_heuristic(heur):
    """Copy the fitted heuristic into forecaster.js so the fallback works without forecaster.json."""
    import re
    path = os.path.join(SERVER_ML, "forecaster.js")
    src = open(path).read()
    new = re.sub(r"/\*HEURISTIC_BEGIN\*/.*?/\*HEURISTIC_END\*/",
                 lambda _: "/*HEURISTIC_BEGIN*/" + json.dumps(heur, separators=(",", ":")) + "/*HEURISTIC_END*/",
                 src, flags=re.S)
    with open(path, "w") as f:
        f.write(new)


def export_fixtures(dtest, booster, reg_booster, calib, model_out, heur, n=50):
    """Raw inputs (market, history, now) + Python features/predictions for the JS parity test."""
    from collect import kalshi_history, pm_history
    mk = {m["market_id"]: m for m in json.load(open(os.path.join(HERE, "data", "markets.json")))}
    meta = json.load(open(os.path.join(HERE, "data", "forecast_meta.json")))
    days = json.load(open(os.path.join(HERE, "data", "collect_meta.json"))).get("days", 14)
    iso = lambda ms: (datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="milliseconds")  # noqa: E731
                      .replace("+00:00", "Z")) if ms else None
    # oversample positives and truncated histories so the fixtures exercise all paths
    pos = dtest[dtest.y == 1].sample(15, random_state=SEED)
    tr = dtest[(dtest.y == 0) & dtest.trunc].sample(10, random_state=SEED)
    rest = dtest[(dtest.y == 0) & ~dtest.trunc].sample(n, random_state=SEED)
    rows = pd.concat([pos, tr, rest])
    fx, cache = [], {}
    for _, r in rows.iterrows():
        if len(fx) >= n:
            break
        m = dict(mk[r.market_id])
        md = meta.get(r.market_id, {})
        start = md.get("startTime_ms")
        end = md.get("endDate_ms") or m.get("endDate_ms")
        if r.market_id not in cache:
            pts = pm_history(m, days) if m["source"] == "polymarket" else kalshi_history(m, days)
            cache[r.market_id] = (np.array([a for a, _ in pts], float) * 1000, np.array([b for _, b in pts], float))
        ts, ps = cache[r.market_id]
        T = int(r.t_ms)
        lo = r.hist_lo_ms if r.hist_lo_ms >= 0 else None
        if lo is None:
            k0 = max(int(np.searchsorted(ts, T - 361 * 60_000, side="right")) - 1, 0)
        else:
            k0 = int(np.searchsorted(ts, lo, side="left"))
        k1 = int(np.searchsorted(ts, T, side="right"))
        hist = [{"t": int(a), "p": float(b)} for a, b in zip(ts[k0:k1], ps[k0:k1])]
        g = grid_for([h["t"] for h in hist], [h["p"] for h in hist], T)
        mkt = {"source": m["source"], "category": m["category"],
               "endDate_ms": float(int(end)) if end else None, "startTime_ms": float(int(start)) if start else None}
        feats = compute_features(g, T, mkt)
        stored = r[FEATURES].values.astype(float)
        if not np.allclose(np.nan_to_num(feats, nan=-999), np.nan_to_num(stored, nan=-999), atol=1e-9):
            continue
        x = np.array([feats])
        dm = xgb.DMatrix(x, missing=np.nan)
        margin = float(booster.predict(dm, output_margin=True)[0])
        raw = float(booster.predict(dm)[0])
        contribs = booster.predict(dm, pred_contribs=True, approx_contribs=True)[0][:-1]
        reg = float(reg_booster.predict(dm)[0])
        hrow = heur_from_grid(g, dict(zip(FEATURES, feats)))
        hp, hm = heur_predict(heur, np.array([hrow]))
        fx.append({"market": {"id": r.market_id, "source": m["source"], "category": m["category"],
                              "endDate": iso(end), "startTime": iso(start)},
                   "now": T, "history": hist, "features": [None if math.isnan(v) else v for v in feats],
                   "margin": margin, "raw": raw, "pMove30": float(calib.predict(np.array([raw]))[0]),
                   "regMargin": reg, "expectedMovePts": 100 * max(reg, 0.0),
                   "contribs": [float(v) for v in contribs], "y": int(r.y), "max_move": float(r.max_move),
                   "heuristic": {"inputs": [None if (isinstance(v, float) and math.isnan(v)) else v for v in hrow],
                                 "pMove30": float(hp[0]), "expectedMovePts": 100 * float(hm[0])}})
    with open(os.path.join(SERVER_ML, "forecaster_fixtures.json"), "w") as f:
        json.dump({"model": model_out["model"], "rows": fx}, f, separators=(",", ":"))
    print(f"exported server/ml/forecaster_fixtures.json ({len(fx)} rows)")


if __name__ == "__main__":
    if "--embed-only" in sys.argv:  # re-embed the heuristic from an existing forecaster.json
        embed_heuristic(json.load(open(os.path.join(SERVER_ML, "forecaster.json")))["heuristic"])
    else:
        main()
