"""Which model reads the game state best from odds alone? (SPEC section 3)

python ml/state/train_state.py [--coarse]

Joins ml/state/data/{markets,prices,states}.parquet into per-minute rows, splits by game in time order
(70% train / 10% calibration / 20% test), and compares a rule baseline, XGBoost multiclass, a GRU on
the raw price sequence, and a Gaussian HMM. Writes data/state_report.json and the phone export.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import classification_report, confusion_matrix, f1_score, log_loss

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "sports"))
import features as F  # noqa: E402

DATA = HERE / "data"
EXPORT = HERE.parents[1] / "server" / "ml" / "state"
SEED = 7

# Coarse, sport-agnostic readings. Fine labels map onto these so every sport shares one vocabulary.
COARSE = {
    "us_scored": "big_moment_us", "them_scored": "big_moment_them",
    "turnover_them": "big_moment_us", "turnover_us": "big_moment_them",
    "red_card_them": "big_moment_us", "red_card_us": "big_moment_them",
    "lead_change": "big_moment",
    "us_scoring_position": "pressure_us", "us_pressing": "pressure_us", "us_batting_risp": "pressure_us",
    "us_power_play": "pressure_us", "us_run": "pressure_us",
    "them_scoring_position": "pressure_them", "them_pressing": "pressure_them", "them_batting_risp": "pressure_them",
    "them_power_play": "pressure_them", "them_run": "pressure_them",
    "us_offense": "calm", "them_offense": "calm", "us_batting": "calm", "them_batting": "calm",
    "open": "calm", "even": "calm",
    "stoppage": "break", "halftime": "break", "between_innings": "break", "intermission": "break", "break": "break",
}


# ------------------------------------------------------------------ data

def load_rows(coarse: bool) -> pd.DataFrame:
    markets = pd.read_parquet(DATA / "markets.parquet")
    prices = pd.read_parquet(DATA / "prices.parquet")
    states = pd.read_parquet(DATA / "states.parquet")
    cols = {c.lower(): c for c in markets.columns}
    side_col = cols.get("espn_side") or cols.get("side")
    markets = markets.dropna(subset=["espn_event_id", side_col])
    states["minute_utc"] = pd.to_datetime(states["minute_utc"], utc=True)
    st_by = {k: g.set_index("minute_utc")["state"] for k, g in states.groupby(["espn_event_id", "side"])}
    # One series per token: US-sports moneylines have two tokens (one per team) in one market.
    px_by = {k: g.sort_values("t") for k, g in prices.groupby("token_id")}
    rows, seqs = [], []
    for m in markets.itertuples(index=False):
        md = m._asdict()
        key = (str(md["espn_event_id"]), md[side_col])
        lab = st_by.get(key)
        if lab is None:
            lab = st_by.get((int(md["espn_event_id"]), md[side_col])) if str(md["espn_event_id"]).isdigit() else None
        px = px_by.get(md["token_id"])
        if lab is None or px is None or len(px) < 30:
            continue
        start = pd.Timestamp(md["game_start"]).tz_convert("UTC") if pd.Timestamp(md["game_start"]).tzinfo else pd.Timestamp(md["game_start"], tz="UTC")
        start_sec = int(start.floor("min").timestamp())
        pts = list(zip(px["t"].astype(int).tolist(), px["p"].astype(float).tolist()))
        sport = sport_of(md)
        three_way = sport == "soccer"
        g = F.grid(pts, start_sec, 300)
        kf = F.kalman(g, KALMAN)
        for minute in range(0, 301):
            if g[minute] is None:
                continue
            ts = pd.Timestamp(start_sec + 60 * minute, unit="s", tz="UTC")
            state = lab.get(ts)
            if state is None or (isinstance(state, float) and math.isnan(state)):
                continue
            if coarse:
                state = COARSE.get(state, state)
            f = F.features_from_grid(g, kf, minute, sport, three_way)
            rows.append({"market_id": md["token_id"], "game_id": key[0], "start": start, "minute": minute,
                         "sport": sport, "state": state, **f})
            seq = [g[k] if k >= 0 and g[k] is not None else np.nan for k in range(minute - 29, minute + 1)]
            seqs.append(seq)
    df = pd.DataFrame(rows)
    df["seq"] = seqs
    return df


def sport_of(md) -> str:
    s = str(md.get("sport") or md.get("espn_league") or "").lower()
    lg = str(md.get("espn_league") or "").lower()
    if "college-football" in lg or s == "cfb":
        return "cfb"
    for key, val in (("nfl", "nfl"), ("football", "nfl"), ("mlb", "mlb"), ("baseball", "mlb"), ("nhl", "nhl"),
                     ("hockey", "nhl"), ("nba", "nba"), ("basketball", "nba")):
        if key in s or key in lg:
            return val
    return "soccer"


def split(df: pd.DataFrame):
    games = df.groupby("game_id")["start"].min().sort_values()
    n = len(games)
    tr = set(games.index[: int(n * 0.7)])
    ca = set(games.index[int(n * 0.7): int(n * 0.8)])
    return df.game_id.isin(tr).values, df.game_id.isin(ca).values, ~df.game_id.isin(tr | ca).values


# ------------------------------------------------------------------ models

def rule_baseline(df: pd.DataFrame, classes: list[str]) -> np.ndarray:
    """Hand rules on the odds: big jump = big moment, steady drift = pressure, flat = calm."""
    out = np.full((len(df), len(classes)), 0.02)

    def put(mask, cls):
        if cls in classes:
            out[mask, classes.index(cls)] = 1.0

    r3, vol = df["ret_3"].fillna(0).values, df["vol_15"].fillna(0).values
    big = np.abs(df["ret_1"].fillna(0).values) >= np.maximum(8, 4 * vol)
    up, down = r3 > 2, r3 < -2
    candidates = [("big_moment_us", big & (df["ret_1"].values > 0)), ("big_moment_them", big & (df["ret_1"].values < 0)),
                  ("us_scored", big & (df["ret_1"].values > 0)), ("them_scored", big & (df["ret_1"].values < 0)),
                  ("pressure_us", ~big & up), ("pressure_them", ~big & down),
                  ("us_scoring_position", ~big & up), ("them_scoring_position", ~big & down),
                  ("us_pressing", ~big & up), ("them_pressing", ~big & down)]
    for cls, mask in candidates:
        put(mask, cls)
    quiet = ~big & ~up & ~down
    for cls in ("calm", "open", "even", "us_offense"):
        put(quiet, cls)
    return out / out.sum(1, keepdims=True)


def fit_xgb(X, y, Xv, yv, n_class):
    best = None
    for depth, mcw in ((4, 20), (6, 40)):
        m = xgb.XGBClassifier(objective="multi:softprob", num_class=n_class, tree_method="hist", max_bin=128,
                              n_estimators=400, learning_rate=0.06, max_depth=depth, min_child_weight=mcw,
                              subsample=0.85, colsample_bytree=0.9, reg_lambda=3.0, early_stopping_rounds=30,
                              eval_metric="mlogloss", random_state=SEED, n_jobs=6)
        m.fit(X, y, eval_set=[(Xv, yv)], verbose=False)
        score = m.best_score
        if best is None or score < best[0]:
            best = (score, m)
    return best[1]


def fit_gru(train_seq, train_static, ytr, val_seq, val_static, yv, n_class, epochs=12):
    import torch
    from torch import nn

    torch.manual_seed(SEED)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"

    def prep(seq, stat):
        s = np.array(seq.tolist(), dtype=np.float32)
        last = np.nan_to_num(s[:, -1:], nan=50.0)
        s = np.where(np.isnan(s), last, s) - last          # relative to now, in points
        return torch.tensor(s[..., None]), torch.tensor(np.nan_to_num(stat.astype(np.float32)))

    class Net(nn.Module):
        def __init__(self, n_static):
            super().__init__()
            self.gru = nn.GRU(1, 48, batch_first=True)
            self.head = nn.Sequential(nn.Linear(48 + n_static, 64), nn.ReLU(), nn.Linear(64, n_class))

        def forward(self, s, x):
            _, h = self.gru(s)
            return self.head(torch.cat([h[-1], x], 1))

    s_tr, x_tr = prep(train_seq, train_static)
    s_v, x_v = prep(val_seq, val_static)
    mu, sd = x_tr.mean(0), x_tr.std(0) + 1e-6
    x_tr, x_v = (x_tr - mu) / sd, (x_v - mu) / sd
    net = Net(x_tr.shape[1]).to(dev)
    counts = np.bincount(ytr, minlength=n_class).astype(np.float32)
    weights = torch.tensor((counts.sum() / np.maximum(counts, 1)) ** 0.5).to(dev)
    lossf = nn.CrossEntropyLoss(weight=weights / weights.mean())
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    ytr_t = torch.tensor(ytr)
    best = (1e9, None)
    for _ in range(epochs):
        net.train()
        perm = torch.randperm(len(ytr_t))
        for i in range(0, len(perm), 1024):
            b = perm[i:i + 1024]
            opt.zero_grad()
            loss = lossf(net(s_tr[b].to(dev), x_tr[b].to(dev)), ytr_t[b].to(dev))
            loss.backward()
            opt.step()
        net.eval()
        with torch.no_grad():
            pv = torch.softmax(net(s_v.to(dev), x_v.to(dev)), 1).cpu().numpy()
        ll = log_loss(yv, pv, labels=list(range(n_class)))
        if ll < best[0]:
            best = (ll, {k: v.detach().clone() for k, v in net.state_dict().items()})
    net.load_state_dict(best[1])

    def predict(seq, stat):
        s, x = prep(seq, stat)
        with torch.no_grad():
            return torch.softmax(net(s.to(dev), ((x - mu) / sd).to(dev)), 1).cpu().numpy()

    return predict


def fit_hmm(train_df, test_df, classes, n_states=6):
    """Unsupervised regimes on (return, |return|, vol); each regime mapped to its most common label."""
    from hmmlearn.hmm import GaussianHMM

    def obs(d):
        return np.nan_to_num(d[["ret_1", "absret_1", "vol_5"]].values.astype(float))

    lengths = train_df.groupby("market_id", sort=False).size().values
    hmm = GaussianHMM(n_components=n_states, covariance_type="diag", n_iter=50, random_state=SEED)
    hmm.fit(obs(train_df), lengths)
    reg_tr = hmm.predict(obs(train_df), lengths)
    table = pd.crosstab(reg_tr, train_df["state"])
    dist = (table.T / table.sum(1)).T.reindex(columns=classes, fill_value=0).values + 1e-3
    dist = dist / dist.sum(1, keepdims=True)
    reg_te = hmm.predict(obs(test_df), test_df.groupby("market_id", sort=False).size().values)
    return dist[reg_te]


# ------------------------------------------------------------------ evaluation

def metrics(y, P, classes):
    pred = P.argmax(1)
    conf = P.max(1)
    sure = conf >= 0.6
    return {
        "macro_f1": float(f1_score(y, pred, average="macro", labels=list(range(len(classes))), zero_division=0)),
        "accuracy": float((pred == y).mean()),
        "log_loss": float(log_loss(y, np.clip(P, 1e-7, 1), labels=list(range(len(classes))))),
        "confident_share": float(sure.mean()),
        "confident_accuracy": float((pred[sure] == y[sure]).mean()) if sure.any() else None,
        "per_class": classification_report(y, pred, labels=list(range(len(classes))), target_names=classes,
                                           output_dict=True, zero_division=0),
        "confusion": confusion_matrix(y, pred, labels=list(range(len(classes)))).tolist(),
    }


KALMAN = dict(F.DEFAULT_KALMAN)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--coarse", action="store_true", help="train on the shared coarse vocabulary")
    ap.add_argument("--no-gru", action="store_true")
    args = ap.parse_args()

    # Fit the Kalman filter on a sample of training games first.
    prices = pd.read_parquet(DATA / "prices.parquet")
    sample = []
    for mid, g in list(prices.groupby("token_id"))[:400]:
        pts = list(zip(g["t"].astype(int), g["p"].astype(float)))
        sample.append(F.grid(sorted(pts), pts[0][0] - pts[0][0] % 60, 240))
    KALMAN.update(F.fit_kalman(sample))
    print("kalman", KALMAN, flush=True)

    df = load_rows(args.coarse)
    tr, ca, te = split(df)
    # Classes must appear in training games; drop the rest everywhere (rare, sport-specific).
    keep = set(df.loc[tr, "state"].unique())
    df = df[df["state"].isin(keep)].reset_index(drop=True)
    tr, ca, te = split(df)
    classes = sorted(keep)
    y = df["state"].map({c: i for i, c in enumerate(classes)}).values
    print(f"rows {len(df):,}  games {df.game_id.nunique():,}  classes {len(classes)}", flush=True)
    print(df.groupby("sport")["game_id"].nunique().to_dict(), flush=True)
    print(df["state"].value_counts(normalize=True).round(3).to_dict(), flush=True)

    X = df[F.FEATURES].values.astype(float)
    results = {}
    results["rule_baseline"] = metrics(y[te], rule_baseline(df[te], classes), classes)
    prior = np.bincount(y[tr], minlength=len(classes)) / tr.sum()
    results["class_prior"] = metrics(y[te], np.tile(prior, (te.sum(), 1)), classes)
    booster = fit_xgb(X[tr], y[tr], X[ca], y[ca], len(classes))
    P_xgb = booster.predict_proba(X[te])
    results["xgboost"] = metrics(y[te], P_xgb, classes)
    print("xgboost", round(results["xgboost"]["macro_f1"], 3), round(results["xgboost"]["log_loss"], 3), flush=True)
    results["hmm"] = metrics(y[te], fit_hmm(df[tr], df[te], classes), classes)
    print("hmm", round(results["hmm"]["macro_f1"], 3), flush=True)
    if not args.no_gru:
        static_cols = ["minute", "three_way"] + [f"sport_{s}" for s in F.SPORTS]
        pred = fit_gru(df.loc[tr, "seq"], df.loc[tr, static_cols].values, y[tr],
                       df.loc[ca, "seq"], df.loc[ca, static_cols].values, y[ca], len(classes))
        results["gru"] = metrics(y[te], pred(df.loc[te, "seq"], df.loc[te, static_cols].values), classes)
        print("gru", round(results["gru"]["macro_f1"], 3), round(results["gru"]["log_loss"], 3), flush=True)

    # Per-sport breakdown for the deployed model.
    per_sport = {}
    for s in sorted(df.sport.unique()):
        mask = (df.sport.values == s)[te]
        if mask.sum() > 200:
            per_sport[s] = metrics(y[te][mask], P_xgb[mask], classes)
    tag = "coarse" if args.coarse else "fine"
    report = {"classes": classes, "kalman": KALMAN, "n_rows": len(df), "n_games": int(df.game_id.nunique()),
              "games_per_sport": df.groupby("sport")["game_id"].nunique().to_dict(),
              "class_share": df["state"].value_counts(normalize=True).to_dict(),
              "models": results, "xgboost_per_sport": per_sport,
              "importance": sorted(zip(F.FEATURES, booster.feature_importances_.tolist()), key=lambda t: -t[1])[:15]}
    (DATA / f"state_report_{tag}.json").write_text(json.dumps(report, indent=1, default=float))
    booster.get_booster().save_model(DATA / f"state_xgb_{tag}.ubj")
    df.loc[te, ["market_id", "game_id", "minute", "sport", "state", "p"]].assign(
        pred=[classes[i] for i in P_xgb.argmax(1)], conf=P_xgb.max(1)).to_parquet(DATA / f"state_test_{tag}.parquet")
    print("\nSUMMARY", tag)
    for name, r in results.items():
        print(f"  {name:14s} macroF1 {r['macro_f1']:.3f}  acc {r['accuracy']:.3f}  logloss {r['log_loss']:.3f}  "
              f"confident {r['confident_share']:.1%} @ {r['confident_accuracy'] if r['confident_accuracy'] is None else round(r['confident_accuracy'], 3)}")


if __name__ == "__main__":
    main()
