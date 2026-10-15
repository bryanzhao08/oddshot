"""Train + evaluate spike "is it real?" models; export the chosen model for JS.

Split (leakage-free):
  * groups = Polymarket event / Kalshi event (sibling markets co-move, so they
    are kept together). Groups are hashed into TRAIN (75%) / TEST (25%).
  * TEST  = test-groups, detection time >= T_test (latest 20% of timestamps).
  * TRAIN = train-groups, detection time <  T_test - 60 min (purge: the label
    looks 30-60 min ahead).
  * Inside TRAIN: CAL (calibration) = 30% of train-groups in the latest 25% of
    train time; FIT = the other groups, before the CAL period (- purge).
  * Hyperparameter search: expanding-window time-series CV on FIT (4 folds,
    validation groups removed from each fold's training data).
No group appears in more than one of FIT / CAL / TEST.

Usage: ml/.venv/bin/python ml/train.py [--trials 60] [--label y30]
"""
import argparse
import hashlib
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
from sklearn.calibration import _SigmoidCalibration
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, precision_recall_curve, roc_auc_score
from sklearn.model_selection import KFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from features import FEATURES  # noqa: E402

warnings.filterwarnings("ignore")
optuna.logging.set_verbosity(optuna.logging.WARNING)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER_ML = os.path.join(ROOT, "server", "ml")
PURGE_MS = 60 * 60_000
SEED = 7
RULE_DELTA = 0.05  # live detector's plain threshold (DEFAULTS.minDelta)


def h01(s, salt=""):
    return int(hashlib.md5((salt + s).encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


# ----------------------------------------------------------------- metrics
def prec_at_recall(y, s, r=0.8):
    p, rec, _ = precision_recall_curve(y, s)
    ok = rec >= r
    return float(p[ok].max()) if ok.any() else float("nan")


def alerts_for_recall(y, s, target_tp):
    """Fewest alerts (top-scored) needed to capture >= target_tp real events."""
    order = np.argsort(-s, kind="mergesort")
    tp = np.cumsum(y[order])
    k = np.searchsorted(tp, target_tp)  # first index with tp >= target
    return int(min(k + 1, len(y)))


def metrics(y, prob, score=None, rule_mask=None):
    score = prob if score is None else score
    out = {
        "roc_auc": roc_auc_score(y, score),
        "pr_auc": average_precision_score(y, score),
        "brier": brier_score_loss(y, prob),
        "log_loss": log_loss(y, np.clip(prob, 1e-6, 1 - 1e-6)),
        "prec_at_r80": prec_at_recall(y, score, 0.8),
    }
    if rule_mask is not None:
        tp_rule = int(y[rule_mask].sum())
        n_rule = int(rule_mask.sum())
        n_model = alerts_for_recall(y, score, tp_rule)
        out["alerts_at_rule_recall"] = n_model
        out["alert_reduction_vs_rule"] = 1 - n_model / n_rule
        # at recall 0.8: alerts vs ranking by |z| is computed by caller
    return out


# ----------------------------------------------------------------- splits
def make_splits(df):
    t = df["t_ms"].values
    T_test = np.quantile(t, 0.8)
    gtest = df["group"].map(lambda g: h01(g, "test") < 0.25).values
    test = gtest & (t >= T_test)
    train = (~gtest) & (t < T_test - PURGE_MS)
    tt = t[train]
    T_cal = np.quantile(tt, 0.75)
    gcal = df["group"].map(lambda g: h01(g, "cal") < 0.3).values
    cal = train & gcal & (t >= T_cal)
    fit = train & (~gcal) & (t < T_cal - PURGE_MS)
    return fit, cal, test, T_test, T_cal


def cv_folds(dfit, k=4):
    """Grouped expanding-window folds on the FIT set (indices relative to dfit):
    validate on time slice i; train on everything before it (minus purge) whose
    group does not appear in the validation slice."""
    t = dfit["t_ms"].values
    grp = dfit["group"].values
    edges = np.quantile(t, np.linspace(0.4, 1.0, k + 1))
    folds = []
    for i in range(k):
        lo, hi = edges[i], edges[i + 1]
        val = (t >= lo) & (t <= hi)
        vg = set(grp[val])
        tr = (t < lo - PURGE_MS) & ~np.isin(grp, list(vg))
        if val.sum() > 50 and tr.sum() > 200:
            folds.append((np.where(tr)[0], np.where(val)[0]))
    return folds


# ----------------------------------------------------------------- models
def xgb_model(p):
    return xgb.XGBClassifier(
        n_estimators=p["n_estimators"], max_depth=p["max_depth"], learning_rate=p["learning_rate"],
        subsample=p["subsample"], colsample_bytree=p["colsample_bytree"], min_child_weight=p["min_child_weight"],
        reg_lambda=p["reg_lambda"], reg_alpha=p["reg_alpha"], gamma=p["gamma"],
        tree_method="hist", objective="binary:logistic", eval_metric="logloss", random_state=SEED, n_jobs=4,
    )


def lgb_model(p):
    return lgb.LGBMClassifier(
        n_estimators=p["n_estimators"], num_leaves=p["num_leaves"], max_depth=p["max_depth"],
        learning_rate=p["learning_rate"], subsample=p["subsample"], subsample_freq=1,
        colsample_bytree=p["colsample_bytree"], min_child_samples=p["min_child_samples"],
        reg_lambda=p["reg_lambda"], reg_alpha=p["reg_alpha"], random_state=SEED, n_jobs=4, verbose=-1,
    )


def xgb_space(tr):
    return {
        "n_estimators": tr.suggest_int("n_estimators", 50, 600, log=True),
        "max_depth": tr.suggest_int("max_depth", 2, 7),
        "learning_rate": tr.suggest_float("learning_rate", 0.01, 0.3, log=True),
        "subsample": tr.suggest_float("subsample", 0.5, 1.0),
        "colsample_bytree": tr.suggest_float("colsample_bytree", 0.4, 1.0),
        "min_child_weight": tr.suggest_float("min_child_weight", 1, 50, log=True),
        "reg_lambda": tr.suggest_float("reg_lambda", 1e-3, 30, log=True),
        "reg_alpha": tr.suggest_float("reg_alpha", 1e-3, 10, log=True),
        "gamma": tr.suggest_float("gamma", 1e-3, 5, log=True),
    }


def lgb_space(tr):
    return {
        "n_estimators": tr.suggest_int("n_estimators", 50, 600, log=True),
        "num_leaves": tr.suggest_int("num_leaves", 4, 64, log=True),
        "max_depth": tr.suggest_int("max_depth", 2, 8),
        "learning_rate": tr.suggest_float("learning_rate", 0.01, 0.3, log=True),
        "subsample": tr.suggest_float("subsample", 0.5, 1.0),
        "colsample_bytree": tr.suggest_float("colsample_bytree", 0.4, 1.0),
        "min_child_samples": tr.suggest_int("min_child_samples", 5, 200, log=True),
        "reg_lambda": tr.suggest_float("reg_lambda", 1e-3, 30, log=True),
        "reg_alpha": tr.suggest_float("reg_alpha", 1e-3, 10, log=True),
    }


def cv_auc(make, X, y, folds):
    aucs = []
    for tr, va in folds:
        m = make()
        m.fit(X[tr], y[tr])
        aucs.append(roc_auc_score(y[va], m.predict_proba(X[va])[:, 1]))
    return float(np.mean(aucs)), aucs


def tune(name, space, build, X, y, folds, trials):
    def obj(tr):
        p = space(tr)
        return cv_auc(lambda: build(p), X, y, folds)[0]

    st = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=SEED))
    t0 = time.time()
    st.optimize(obj, n_trials=trials)
    print(f"  {name}: best CV AUC {st.best_value:.4f} in {time.time() - t0:.0f}s  {st.best_params}")
    return st.best_params, st.best_value


# ----------------------------------------------------------------- calibration
class Calibrator:
    """Maps raw model probability -> calibrated probability (isotonic or Platt)."""

    def __init__(self, kind):
        self.kind = kind

    def fit(self, p, y):
        if self.kind == "isotonic":
            self.m = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(p, y)
        elif self.kind == "platt":
            self.m = _SigmoidCalibration().fit(logit(p), y)
        return self

    def predict(self, p):
        if self.kind == "isotonic":
            return self.m.predict(p)
        if self.kind == "platt":
            return self.m.predict(logit(p))
        return p

    def export(self):
        if self.kind == "isotonic":
            return {"type": "isotonic", "x": self.m.X_thresholds_.tolist(), "y": self.m.y_thresholds_.tolist()}
        if self.kind == "platt":  # p = 1 / (1 + exp(a * logit(raw) + b))
            return {"type": "platt", "a": float(self.m.a_), "b": float(self.m.b_)}
        return {"type": "none"}


def logit(p):
    p = np.clip(p, 1e-7, 1 - 1e-7)
    return np.log(p / (1 - p))


def choose_calibrator(p, y):
    """Pick isotonic vs Platt by 5-fold CV log loss on the calibration set."""
    best, scores = None, {}
    for kind in ("platt", "isotonic"):
        ll = []
        for tr, va in KFold(5, shuffle=True, random_state=SEED).split(p):
            c = Calibrator(kind).fit(p[tr], y[tr])
            ll.append(log_loss(y[va], np.clip(c.predict(p[va]), 1e-6, 1 - 1e-6)))
        scores[kind] = float(np.mean(ll))
    best = min(scores, key=scores.get)
    return Calibrator(best).fit(p, y), scores


# ----------------------------------------------------------------- export
def xgb_trees(booster, feat_names):
    """XGBoost JSON dump -> flat node arrays. Internal node value = cover-weighted
    mean of its leaves (what xgboost's approx_contribs / Saabas uses)."""
    trees = []
    for js in booster.get_dump(dump_format="json", with_stats=True):
        root = json.loads(js)
        nodes = {}

        def walk(n):
            nodes[n["nodeid"]] = n
            for c in n.get("children", []):
                walk(c)

        walk(root)
        n_nodes = max(nodes) + 1
        f = [-1] * n_nodes
        thr = [0.0] * n_nodes
        yes = [-1] * n_nodes
        no = [-1] * n_nodes
        miss = [-1] * n_nodes
        val = [0.0] * n_nodes
        cover = [0.0] * n_nodes

        def fill(i):
            n = nodes[i]
            cover[i] = float(n["cover"])
            if "leaf" in n:
                val[i] = float(n["leaf"])
                return val[i]
            f[i] = feat_names.index(n["split"])
            thr[i] = float(np.float32(n["split_condition"]))
            yes[i], no[i], miss[i] = n["yes"], n["no"], n["missing"]
            vy, vn = fill(yes[i]), fill(no[i])
            val[i] = (vy * cover[yes[i]] + vn * cover[no[i]]) / (cover[yes[i]] + cover[no[i]])
            return val[i]

        fill(0)
        trees.append({"f": f, "t": thr, "y": yes, "n": no, "m": miss, "v": val})
    return trees


def xgb_base_margin(booster, X):
    """Recover the global bias: margin(X) - sum of leaf values."""
    margin = booster.predict(xgb.DMatrix(X, missing=np.nan), output_margin=True)
    leaves = booster.predict(xgb.DMatrix(X, missing=np.nan), pred_leaf=True).astype(int)
    return margin, leaves


def js_like_predict(model, X):
    """Python re-implementation of scorer.js tree walk (sanity check before export)."""
    out = np.full(len(X), model["base_margin"])
    for tr in model["trees"]:
        for r in range(len(X)):
            i = 0
            while tr["f"][i] >= 0:
                x = X[r, tr["f"][i]]
                if math.isnan(x):
                    i = tr["m"][i]
                else:
                    i = tr["y"][i] if np.float32(x) < np.float32(tr["t"][i]) else tr["n"][i]
            out[r] += tr["v"][i]
    return out


# ----------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=60)
    ap.add_argument("--label", default="y30")
    args = ap.parse_args()

    df = pd.read_parquet(os.path.join(HERE, "data", "spikes.parquet"))
    df = df.dropna(subset=[args.label]).sort_values("t_ms").reset_index(drop=True)
    y_all = df[args.label].values.astype(int)
    X_all = df[FEATURES].values.astype(np.float64)
    fit, cal, test, T_test, T_cal = make_splits(df)
    print(f"rows={len(df)} markets={df.market_id.nunique()} groups={df.group.nunique()} base_rate={y_all.mean():.3f}")
    print(f"FIT={fit.sum()} CAL={cal.sum()} TEST={test.sum()}  "
          f"T_cal={pd.Timestamp(T_cal, unit='ms')} T_test={pd.Timestamp(T_test, unit='ms')}")
    assert not (set(df.group[fit]) & set(df.group[test])) and not (set(df.group[cal]) & set(df.group[test]))
    assert not (set(df.group[fit]) & set(df.group[cal]))

    Xf, yf = X_all[fit], y_all[fit]
    Xc, yc = X_all[cal], y_all[cal]
    Xt, yt = X_all[test], y_all[test]
    dfit = df[fit].reset_index(drop=True)
    folds = cv_folds(dfit)
    print(f"CV folds: {[(len(a), len(b)) for a, b in folds]}")
    rule_mask = df.loc[test, "abs_delta"].values >= RULE_DELTA - 1e-9
    absz_t = df.loc[test, "abs_z"].values

    imp = lambda: SimpleImputer(strategy="median", add_indicator=True)  # noqa: E731
    candidates = {
        "logreg": lambda: make_pipeline(imp(), StandardScaler(), LogisticRegression(C=0.5, max_iter=2000)),
        "random_forest": lambda: make_pipeline(imp(), RandomForestClassifier(
            n_estimators=400, min_samples_leaf=20, max_features=0.4, n_jobs=4, random_state=SEED)),
        "extra_trees": lambda: make_pipeline(imp(), ExtraTreesClassifier(
            n_estimators=400, min_samples_leaf=20, max_features=0.5, n_jobs=4, random_state=SEED)),
        "hist_gb": lambda: HistGradientBoostingClassifier(
            max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=40, l2_regularization=1.0,
            random_state=SEED),
    }
    print("tuning ...")
    xgb_p, xgb_cv = tune("xgboost", xgb_space, xgb_model, Xf, yf, folds, args.trials)
    lgb_p, lgb_cv = tune("lightgbm", lgb_space, lgb_model, Xf, yf, folds, args.trials)
    candidates["xgboost"] = lambda: xgb_model(xgb_p)
    candidates["lightgbm"] = lambda: lgb_model(lgb_p)

    results, fitted, cv_scores = {}, {}, {}
    # rule baselines: score = |z| or |delta|; mapped to probabilities by the same calibration procedure
    for name, col in (("rule_abs_z", "abs_z"), ("rule_abs_delta", "abs_delta")):
        s_c, s_t = df.loc[cal, col].values, df.loc[test, col].values
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(s_c, yc)
        r = metrics(yt, np.clip(iso.predict(s_t), 1e-6, 1 - 1e-6), score=s_t, rule_mask=rule_mask)
        r["cv_auc"] = float(np.mean([roc_auc_score(yf[va], dfit[col].values[va]) for _, va in folds]))
        results[name] = r
    # the plain detector rule as a single operating point
    rm = rule_mask
    results["rule_delta>=0.05 (binary)"] = {
        "alerts": int(rm.sum()), "recall": float(yt[rm].sum() / max(yt.sum(), 1)),
        "precision": float(yt[rm].mean()) if rm.any() else float("nan"),
    }

    for name, mk in candidates.items():
        cv = xgb_cv if name == "xgboost" else lgb_cv if name == "lightgbm" else cv_auc(mk, Xf, yf, folds)[0]
        m = mk().fit(Xf, yf)
        raw_c, raw_t = m.predict_proba(Xc)[:, 1], m.predict_proba(Xt)[:, 1]
        calib, cal_scores = choose_calibrator(raw_c, yc)
        p_t = np.clip(calib.predict(raw_t), 1e-6, 1 - 1e-6)
        # rank with raw score (isotonic creates ties); probabilities from calibrated output
        r = metrics(yt, p_t, score=raw_t, rule_mask=rule_mask)
        r["roc_auc_calibrated"] = roc_auc_score(yt, p_t)
        r["cv_auc"] = cv
        r["calibration"] = calib.kind
        r["raw_brier"] = brier_score_loss(yt, raw_t)
        results[name] = r
        fitted[name] = (m, calib)
        print(f"  {name:15s} cv_auc={cv:.4f} test_auc={r['roc_auc']:.4f} brier={r['brier']:.4f} cal={calib.kind}")

    # alerts needed for recall 0.8 (model vs |z| ranking)
    tp80 = math.ceil(0.8 * yt.sum())
    n80_z = alerts_for_recall(yt, absz_t, tp80)
    for name in list(candidates) + ["rule_abs_z", "rule_abs_delta"]:
        if name.startswith("rule"):
            s = df.loc[test, name.replace("rule_", "")].values
        else:
            m, _ = fitted[name]
            s = m.predict_proba(Xt)[:, 1]
        results[name]["alerts_at_r80"] = alerts_for_recall(yt, s, tp80)
        results[name]["alert_reduction_at_r80_vs_absz"] = 1 - results[name]["alerts_at_r80"] / n80_z

    # group-bootstrap 90% CI on test AUC (xgboost, and its gain over the |z| rule) + quintile lift
    rng = np.random.default_rng(SEED)
    gt = df.loc[test, "group"].values
    ug = np.unique(gt)
    gidx = {g: np.where(gt == g)[0] for g in ug}
    s_x = fitted["xgboost"][0].predict_proba(Xt)[:, 1]
    boots_x, boots_d = [], []
    for _ in range(1000):
        idx = np.concatenate([gidx[g] for g in rng.choice(ug, len(ug), replace=True)])
        if len(np.unique(yt[idx])) < 2:
            continue
        ax = roc_auc_score(yt[idx], s_x[idx])
        boots_x.append(ax)
        boots_d.append(ax - roc_auc_score(yt[idx], absz_t[idx]))
    ci = {"xgb_auc_90ci": [float(np.quantile(boots_x, 0.05)), float(np.quantile(boots_x, 0.95))],
          "xgb_minus_absz_auc_90ci": [float(np.quantile(boots_d, 0.05)), float(np.quantile(boots_d, 0.95))]}
    q = pd.qcut(s_x, 5, labels=False, duplicates="drop")
    ci["xgb_quintile_real_rate"] = [float(yt[q == i].mean()) for i in range(int(q.max()) + 1)]
    print("  bootstrap:", ci)

    # choose the exported model by CV AUC among the gradient-boosted models we can export (xgb / lgb)
    chosen = "xgboost" if xgb_cv >= lgb_cv - 0.002 else "lightgbm"
    if chosen == "lightgbm":
        print("  NOTE: lightgbm won CV but scorer.js exports xgboost trees; exporting xgboost anyway "
              f"(cv {xgb_cv:.4f} vs {lgb_cv:.4f})")
        chosen = "xgboost"
    model, calib = fitted["xgboost"]
    booster = model.get_booster()
    booster.feature_names = None  # dump uses f0..fN; map by index
    names = [f"f{i}" for i in range(len(FEATURES))]
    trees = xgb_trees(booster, names)
    margin, leaves = xgb_base_margin(booster, Xt[:200])
    leaf_sum = np.array([sum(trees[k]["v"][leaves[r, k]] for k in range(len(trees))) for r in range(len(leaves))])
    base_margin = float(np.median(margin - leaf_sum))
    exp = {"trees": trees, "base_margin": base_margin}
    chk = js_like_predict(exp, Xt[:200])
    assert np.max(np.abs(chk - margin)) < 1e-4, np.max(np.abs(chk - margin))

    # SHAP (exact TreeSHAP) + Saabas (approx) on TEST, gain importance
    dm = xgb.DMatrix(Xt, missing=np.nan)
    shap = booster.predict(dm, pred_contribs=True)[:, :-1]
    shap_imp = dict(zip(FEATURES, np.abs(shap).mean(0).tolist()))
    gain = booster.get_score(importance_type="total_gain")
    tot = sum(gain.values()) or 1
    gain_imp = {FEATURES[int(k[1:])]: v / tot for k, v in gain.items()}

    # label thresholds chosen on the CAL set (not test)
    p_cal = calib.predict(booster.predict(xgb.DMatrix(Xc, missing=np.nan)))
    t_event = threshold_for_precision(yc, p_cal, 0.85)
    t_noise = threshold_for_recall(yc, p_cal, 0.9)
    if t_noise >= t_event:
        t_noise = min(t_noise, t_event - 0.05)
    p_test = calib.predict(booster.predict(dm))
    lab = np.where(p_test >= t_event, "event", np.where(p_test >= t_noise, "likely", "noise"))
    label_stats = {k: {"n": int((lab == k).sum()), "real_rate": float(yt[lab == k].mean()) if (lab == k).any() else None}
                   for k in ("event", "likely", "noise")}

    trained_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    clean = lambda d: {k: (None if isinstance(v, float) and not math.isfinite(v) else v) for k, v in d.items()}  # noqa: E731
    out = {
        "format": "oddshot-gbt-v1",
        "model": f"xgboost@{trained_at[:10]}",
        "trained_at": trained_at,
        "label": {"name": args.label,
                  "definition": "price 30 min after detection retains >= 50% of the detected move in the same direction"},
        "features": FEATURES,
        "normalization": "none (trees on raw features; NaN = missing, routed by each split's default branch)",
        "feature_params": {"step_ms": 60000, "lookback_min": 360, "spiky_min_delta": 0.03, "sigma_floor": 0.002,
                           "default_sigma": 0.01, "min_returns_vol_1h": 20, "min_returns_vol_6h": 60},
        "base_margin": base_margin,
        "trees": trees,
        "calibration": calib.export(),
        "thresholds": {"event": t_event, "likely": t_noise},
        "metadata": {
            "n_samples": int(len(df)), "n_fit": int(fit.sum()), "n_cal": int(cal.sum()), "n_test": int(test.sum()),
            "base_rate": float(y_all.mean()), "hyperparams": xgb_p,
            "test_metrics": clean({k: v for k, v in results["xgboost"].items() if not isinstance(v, str)}),
            "xgboost_version": xgb.__version__,
        },
    }
    os.makedirs(SERVER_ML, exist_ok=True)
    with open(os.path.join(SERVER_ML, "model.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"exported server/ml/model.json ({len(trees)} trees)")

    export_fixtures(df, test, booster, calib, out)

    with open(os.path.join(HERE, "data", "results.json"), "w") as f:
        json.dump({"results": {k: clean(v) for k, v in results.items()}, "xgb_params": xgb_p, "lgb_params": lgb_p,
                   "xgb_cv": xgb_cv, "lgb_cv": lgb_cv, "shap": shap_imp, "gain": gain_imp,
                   "label_stats": label_stats, "thresholds": out["thresholds"],
                   "split": {"fit": int(fit.sum()), "cal": int(cal.sum()), "test": int(test.sum()),
                             "T_cal": int(T_cal), "T_test": int(T_test),
                             "test_base_rate": float(yt.mean()), "fit_base_rate": float(yf.mean())},
                   "n": int(len(df)), "base_rate": float(y_all.mean()),
                   "base_rate_y60": float(df["y60"].mean()),
                   "markets": int(df.market_id.nunique()), "groups": int(df.group.nunique()),
                   "by_source": df.groupby("source")[args.label].agg(["size", "mean"]).to_dict(),
                   "by_category": df.groupby("category")[args.label].agg(["size", "mean"]).to_dict(),
                   "calibration": calib.kind, "trained_at": trained_at, "bootstrap": ci}, f, indent=1, default=float)
    print_table(results)


def threshold_for_precision(y, p, target):
    order = np.argsort(-p)
    ps, ys = p[order], y[order]
    prec = np.cumsum(ys) / np.arange(1, len(ys) + 1)
    ok = np.where(prec >= target)[0]
    if not len(ok):
        return float(ps[0])
    # lowest threshold that still has precision >= target among items scored >= it
    return float(ps[ok.max()])


def threshold_for_recall(y, p, target):
    order = np.argsort(-p)
    ps, ys = p[order], y[order]
    rec = np.cumsum(ys) / max(ys.sum(), 1)
    k = int(np.searchsorted(rec, target))
    return float(ps[min(k, len(ps) - 1)])


def export_fixtures(df, test, booster, calib, model_out, n=50):
    """Raw inputs (spike, market, history) + Python features/predictions for the JS parity test."""
    from collect import kalshi_history, pm_history  # reuse raw cache

    with open(os.path.join(HERE, "data", "markets.json")) as f:
        mk = {m["market_id"]: m for m in json.load(f)}
    meta_path = os.path.join(HERE, "data", "collect_meta.json")
    days = json.load(open(meta_path))["days"] if os.path.exists(meta_path) else 14
    from features import compute_features

    rows = df[test].sample(frac=1.0, random_state=SEED)
    fx, cache = [], {}
    for _, r in rows.iterrows():
        if len(fx) >= n:
            break
        m = mk.get(r.market_id)
        if m is None:
            continue
        if r.market_id not in cache:
            pts = pm_history(m, days) if m["source"] == "polymarket" else kalshi_history(m, days)
            cache[r.market_id] = (np.array([a for a, _ in pts], float) * 1000, np.array([b for _, b in pts], float))
        ts, ps = cache[r.market_id]
        T = int(r.t_ms)
        lo = T - int(r.windowMs) - 361 * 60_000
        k0 = max(int(np.searchsorted(ts, lo, side="right")) - 1, 0)
        k1 = int(np.searchsorted(ts, T, side="right"))
        hist = [{"t": int(a), "p": float(b)} for a, b in zip(ts[k0:k1], ps[k0:k1])]
        spike = {"marketId": r.market_id, "from": float(r["from"]), "to": float(r["to"]),
                 "delta": float(r["to"] - r["from"]), "windowMs": int(r.windowMs),
                 "detectedAt": datetime.fromtimestamp(T / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
        end = m.get("endDate_ms")
        market = {"id": r.market_id, "source": m["source"], "category": m["category"],
                  "endDate": datetime.fromtimestamp(end / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z") if end else None}
        sp2 = {"from": spike["from"], "to": spike["to"], "windowMs": spike["windowMs"], "detectedAt_ms": T}
        mk2 = {"source": m["source"], "category": m["category"],
               "endDate_ms": float(int(end)) if end else None}
        feats = compute_features([h["t"] for h in hist], [h["p"] for h in hist], sp2, mk2)
        stored = r[FEATURES].values.astype(float)
        if not np.allclose(np.nan_to_num(feats, nan=-999), np.nan_to_num(stored, nan=-999), atol=1e-9):
            continue  # history changed since collection (shouldn't happen with cache)
        x = np.array([feats])
        dm = xgb.DMatrix(x, missing=np.nan)
        margin = float(booster.predict(dm, output_margin=True)[0])
        raw = float(booster.predict(dm)[0])
        saabas = booster.predict(dm, pred_contribs=True, approx_contribs=True)[0][:-1]
        fx.append({"spike": spike, "market": market, "history": hist,
                   "features": [None if math.isnan(v) else v for v in feats],
                   "margin": margin, "raw": raw, "pReal": float(calib.predict(np.array([raw]))[0]),
                   "contribs": [float(v) for v in saabas]})
    with open(os.path.join(SERVER_ML, "fixtures.json"), "w") as f:
        json.dump({"model": model_out["model"], "rows": fx}, f, separators=(",", ":"))
    print(f"exported server/ml/fixtures.json ({len(fx)} rows)")


def print_table(results):
    keys = ["cv_auc", "roc_auc", "pr_auc", "brier", "log_loss", "prec_at_r80", "alerts_at_r80",
            "alert_reduction_at_r80_vs_absz", "alerts_at_rule_recall", "alert_reduction_vs_rule"]
    print("\n| model | " + " | ".join(keys) + " |")
    print("|---" * (len(keys) + 1) + "|")
    for name, r in results.items():
        if "roc_auc" not in r:
            print(f"| {name} | " + json.dumps(r) + " |")
            continue
        cells = []
        for k in keys:
            v = r.get(k)
            cells.append("" if v is None else (f"{v:.4f}" if isinstance(v, float) else str(v)))
        print(f"| {name} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
