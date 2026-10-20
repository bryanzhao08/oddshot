"""Small XGBoost tree export and reference evaluator for the phone format."""

from __future__ import annotations

import json
import math

import numpy as np
import xgboost as xgb


def xgb_trees(booster: xgb.Booster, feature_count: int) -> list[dict]:
    """Copy the flat-node format used by ml/train.py, with no external imports."""
    trees = []
    for raw in booster.get_dump(dump_format="json", with_stats=True):
        root = json.loads(raw)
        nodes = {}

        def walk(node):
            nodes[node["nodeid"]] = node
            for child in node.get("children", []):
                walk(child)

        walk(root)
        count = max(nodes) + 1
        feat, threshold = [-1] * count, [0.0] * count
        yes, no, missing = [-1] * count, [-1] * count, [-1] * count
        value, cover = [0.0] * count, [0.0] * count

        def fill(idx):
            node = nodes[idx]
            cover[idx] = float(node["cover"])
            if "leaf" in node:
                value[idx] = float(node["leaf"])
                return value[idx]
            name = node["split"]
            feat[idx] = int(name[1:]) if name.startswith("f") else int(name)
            if not 0 <= feat[idx] < feature_count:
                raise ValueError(f"Bad exported feature {name}")
            threshold[idx] = float(np.float32(node["split_condition"]))
            yes[idx], no[idx], missing[idx] = node["yes"], node["no"], node["missing"]
            left, right = fill(yes[idx]), fill(no[idx])
            total = cover[yes[idx]] + cover[no[idx]]
            value[idx] = (left * cover[yes[idx]] + right * cover[no[idx]]) / total if total else 0.0
            return value[idx]

        fill(0)
        trees.append({"f": feat, "t": threshold, "y": yes, "n": no, "m": missing, "v": value})
    return trees


def js_like_predict(model: dict, X: np.ndarray) -> np.ndarray:
    """Float32 comparisons match the existing Swift/JS tree traversal."""
    X = np.asarray(X, dtype=float)
    out = np.full(len(X), model["base_margin"], dtype=float)
    for tree in model["trees"]:
        for row in range(len(X)):
            idx = 0
            while tree["f"][idx] >= 0:
                x = X[row, tree["f"][idx]]
                if math.isnan(x):
                    idx = tree["m"][idx]
                elif np.float32(x) < np.float32(tree["t"][idx]):
                    idx = tree["y"][idx]
                else:
                    idx = tree["n"][idx]
            out[row] += tree["v"][idx]
    return out


def export_xgb(booster: xgb.Booster, X: np.ndarray) -> dict:
    X = np.asarray(X, dtype=float)
    trees = xgb_trees(booster, X.shape[1])
    matrix = xgb.DMatrix(X, missing=np.nan)
    margin = booster.predict(matrix, output_margin=True)
    leaves = booster.predict(matrix, pred_leaf=True).astype(int)
    leaf_sum = np.asarray([
        sum(tree["v"][leaves[row, col]] for col, tree in enumerate(trees))
        for row in range(len(X))
    ])
    base = float(np.median(margin - leaf_sum))
    model = {"base_margin": base, "trees": trees}
    error = float(np.max(np.abs(js_like_predict(model, X) - margin)))
    if error >= 1e-4:
        raise AssertionError(f"XGBoost export margin error {error:.8g} >= 1e-4")
    return model
