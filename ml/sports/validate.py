"""Independent, runnable audit of sport model exports and chronological splits.

Run after training with ``ml/.venv/bin/python ml/sports/validate.py``.  The
tree walker intentionally does not import the training export implementation.
It follows the float32 split comparisons used by the phone evaluator.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EXPORTS = ROOT / "server" / "ml" / "sports"
sys.path.insert(0, str(HERE))
LABELS = {
    "soccer": ("goal_next_10m",),
    "basketball": ("lead_change_3m",),
    "football": ("td_drive", "score_drive"),
}


def tree_margins(model: dict, matrix: np.ndarray) -> np.ndarray:
    """Evaluate the exported flat arrays without relying on trainer code."""
    x = np.asarray(matrix, dtype=np.float64)
    if x.ndim == 1:
        x = x[None, :]
    result = np.full(x.shape[0], float(model["base_margin"]), dtype=np.float64)
    for tree in model["trees"]:
        f, threshold = tree["f"], tree["t"]
        yes, no, missing, value = tree["y"], tree["n"], tree["m"], tree["v"]
        size = len(f)
        assert all(len(a) == size for a in (threshold, yes, no, missing, value))
        for row_no, row in enumerate(x):
            node = 0
            for _ in range(size):
                feature = f[node]
                if feature < 0:
                    result[row_no] += value[node]
                    break
                assert feature < x.shape[1], (feature, x.shape[1])
                field = row[feature]
                if math.isnan(field):
                    node = missing[node]
                elif np.float32(field) < np.float32(threshold[node]):
                    node = yes[node]
                else:
                    node = no[node]
                assert 0 <= node < size
            else:
                raise AssertionError("export tree contains a cycle")
    return result


def calibrated_probabilities(model: dict, matrix: np.ndarray) -> np.ndarray:
    margin = tree_margins(model, matrix)
    raw = 1.0 / (1.0 + np.exp(-np.clip(margin, -700, 700)))
    calibration = model["calibration"]
    assert calibration["type"] == "isotonic"
    xp = np.asarray(calibration["x"], dtype=np.float64)
    yp = np.asarray(calibration["y"], dtype=np.float64)
    assert len(xp) == len(yp) and len(xp) > 0
    assert np.all(np.diff(xp) >= 0), "isotonic x thresholds are unordered"
    assert np.all(np.diff(yp) >= -1e-10), "isotonic y thresholds decrease"
    assert np.all((yp >= 0) & (yp <= 1))
    return np.interp(raw, xp, yp, left=yp[0], right=yp[-1])


def verify_booster(booster_path: Path, model: dict, matrix: np.ndarray) -> float:
    import xgboost as xgb

    booster = xgb.Booster()
    booster.load_model(str(booster_path))
    expected = booster.predict(xgb.DMatrix(matrix, missing=np.nan), output_margin=True)
    actual = tree_margins(model, matrix)
    error = float(np.max(np.abs(expected - actual)))
    assert error < 1e-4, f"{booster_path.name}: raw margin error {error:.8g}"
    return error


def audit_split_manifest(path: Path) -> tuple[dict, set[str]]:
    """Require game-level disjointness and strictly ordered date boundaries."""
    manifest = json.loads(path.read_text())
    # Accept either {train:[ids], cal:[ids], test:[ids]} or a list of
    # {game_id, game_date, split} records.  Date checks use records when present.
    if isinstance(manifest, dict) and "splits" in manifest:
        named = manifest["splits"]
        assert set(named) >= {"train", "calibration", "test"}
        rows = [dict(item, split=name) for name, items in named.items() for item in items]
    else:
        rows = manifest.get("games") if isinstance(manifest, dict) else manifest
    if isinstance(rows, list):
        split = {k: set() for k in ("train", "cal", "test")}
        dates = {k: [] for k in split}
        for item in rows:
            name = "cal" if item["split"] == "calibration" else item["split"]
            assert name in split
            game_id = str(item["game_id"])
            assert game_id not in split[name], f"duplicate game {game_id}"
            split[name].add(game_id)
            if item.get("game_date") is not None:
                dates[name].append(str(item["game_date"]))
    else:
        assert isinstance(manifest, dict)
        split = {k: set(map(str, manifest[k])) for k in ("train", "cal", "test")}
        dates = {k: [] for k in split}
    assert all(split.values()), f"empty split in {path.name}"
    assert not (split["train"] & split["cal"])
    assert not (split["train"] & split["test"])
    assert not (split["cal"] & split["test"])
    if all(dates.values()):
        assert max(dates["train"]) <= min(dates["cal"]), "train/cal dates overlap"
        assert max(dates["cal"]) <= min(dates["test"]), "cal/test dates overlap"
    return {name: len(ids) for name, ids in split.items()}, split["test"]


def audit_export(sport: str, export_path: Path, model_dir: Path,
                 test_games: set[str]) -> dict:
    obj = json.loads(export_path.read_text())
    assert obj["format"] == "tipoff-sport-v1"
    assert obj["sport"] == sport
    features = obj["features"]
    assert features and len(features) == len(set(features))
    fixtures = obj["fixtures"]
    assert len(fixtures) >= 40, f"{sport}: expected 40 test fixtures, got {len(fixtures)}"
    assert all(str(f["game_id"]) in test_games for f in fixtures), \
        f"{sport}: non-test game appeared among fixtures"
    x = np.array([[np.nan if v is None else float(v) for v in fixture["x"]]
                  for fixture in fixtures], dtype=np.float64)
    assert x.shape == (len(fixtures), len(features))
    if sport == "soccer":
        from soccer_data import FEATURES, features as make_features
        assert features == FEATURES
        for fixture, vector in zip(fixtures, x):
            t, team, timeline = fixture["at"], fixture["team"], fixture["timeline"]
            expected = make_features(timeline, t, team)
            # Feeding future events must not change a current feature vector.
            prefix = [event for event in timeline if event["min"] <= t]
            assert expected == make_features(prefix, t, team)
            assert np.allclose(vector, [expected[name] for name in features],
                               rtol=0, atol=1e-8, equal_nan=True), "soccer fixture x mismatch"
    elif sport == "basketball":
        from basketball_data import FEATURES, features_at
        assert features == FEATURES
        for fixture, vector in zip(fixtures, x):
            t, timeline = fixture["at"], fixture["timeline"]
            expected = features_at(timeline, t)
            assert expected is not None
            prefix = [event for event in timeline if event["sec"] <= t]
            assert expected == features_at(prefix, t)
            assert np.allclose(vector, [expected[name] for name in features],
                               rtol=0, atol=1e-8, equal_nan=True), "basketball fixture x mismatch"
    else:
        from football_data import FEATURES
        assert features == FEATURES
        for fixture, vector in zip(fixtures, x):
            state = fixture["state"]
            expected = np.asarray([np.nan if state[name] is None else float(state[name])
                                   for name in features])
            assert np.allclose(vector, expected, rtol=0, atol=1e-6, equal_nan=True), \
                "football fixture state/x mismatch"
    errors = {}
    for label in LABELS[sport]:
        model = obj["models"][label]
        assert model["trees"], f"{sport}/{label}: no trees"
        probabilities = calibrated_probabilities(model, x)
        fixture_probabilities = np.array([float(fixture["p"][label]) for fixture in fixtures])
        error = float(np.max(np.abs(probabilities - fixture_probabilities)))
        assert error < 1e-6, f"{sport}/{label}: fixture probability error {error:.8g}"
        booster_path = model_dir / f"{sport}_{label}.ubj"
        assert booster_path.exists(), f"missing independently auditable booster {booster_path}"
        margin_error = verify_booster(booster_path, model, x)
        errors[label] = {"fixture_probability_max_error": error,
                         "xgboost_margin_max_error": margin_error}
    if sport in ("soccer", "basketball"):
        assert all(isinstance(f.get("timeline"), list) for f in fixtures)
    else:
        assert all(isinstance(f.get("state"), dict) for f in fixtures)
    assert export_path.stat().st_size < 1_500_000, f"{sport} export exceeds 1.5 MB"
    samples = sorted((EXPORTS / "samples").glob(f"{sport}_*.json"))
    if sport != "football":
        assert len(samples) >= 2, f"{sport}: expected two ESPN raw summary samples"
        for sample_path in samples[:2]:
            sample = json.loads(sample_path.read_text())
            raw = sample["raw_summary"]
            if sport == "soccer":
                from soccer_data import normalize
                parsed = normalize(raw)
            else:
                from basketball_data import normalize_timeline
                parsed = normalize_timeline(raw)
            assert parsed == sample["expected_timeline"], f"{sample_path.name}: parse mismatch"
    return {"fixtures": len(fixtures), "errors": errors}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sport", choices=[*LABELS], action="append",
                        help="Check one sport; default checks all")
    parser.add_argument("--model-dir", type=Path, default=HERE / "data" / "models")
    args = parser.parse_args()
    for sport in args.sport or LABELS:
        manifest = HERE / "data" / f"{sport}_split.json"
        assert manifest.exists(), f"missing split manifest {manifest}"
        split_counts, test_games = audit_split_manifest(manifest)
        result = audit_export(sport, EXPORTS / f"{sport}.json", args.model_dir,
                              test_games)
        print(f"{sport}: splits={split_counts} fixtures={result['fixtures']} "
              f"errors={result['errors']}")
    print("PASS: chronological game splits, JSON/XGBoost margins, calibration, fixtures")


if __name__ == "__main__":
    main()
