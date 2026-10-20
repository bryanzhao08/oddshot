"""Train and export every in-game model: python ml/sports/run_all.py [soccer football basketball]

Uses the cached ESPN / nflverse downloads in ml/sports/data/raw (collect first with
collect_soccer.py, basketball_data.py --collect; football downloads on first run).
"""

from __future__ import annotations

import sys

from train import train_sport


def soccer():
    from soccer_data import FEATURES, load_soccer
    df = load_soccer()
    print(f"soccer: {df.game_id.nunique():,} matches, {len(df):,} rows, base rate {df.y.mean():.3f}", flush=True)
    return train_sport(df, "soccer", FEATURES, {"goal_next_10m": "y"})


def football():
    from football_data import FEATURES, load_football
    df = load_football()
    print(f"football: {df.game_id.nunique():,} games, {len(df):,} plays", flush=True)
    return train_sport(df, "football", FEATURES, {"td_drive": "y_td", "score_drive": "y_score"})


def basketball():
    from basketball_data import FEATURES, load_basketball
    df = load_basketball(collect=False)
    print(f"basketball: {df.game_id.nunique():,} games, {len(df):,} rows, base rate {df.y.mean():.3f}", flush=True)
    return train_sport(df, "basketball", FEATURES, {"lead_change_3m": "y"})


if __name__ == "__main__":
    jobs = {"soccer": soccer, "football": football, "basketball": basketball}
    for name in sys.argv[1:] or list(jobs):
        report = jobs[name]()
        for target, detail in report["labels"].items():
            m = detail["metrics"]
            row = "  ".join(f"{k}: AUC {v['auc']:.3f} LL {v['log_loss']:.4f}" for k, v in m.items() if "auc" in v)
            print(f"{name}/{target}: {row}", flush=True)
