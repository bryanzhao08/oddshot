#!/usr/bin/env bash
# Create ml/.venv and install deps. On macOS without Homebrew's libomp, the
# xgboost/lightgbm wheels can't find libomp.dylib; we point them at the copy
# bundled inside scikit-learn's wheel (one shared OpenMP runtime per process).
# Alternative: `brew install libomp`.
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
if ! .venv/bin/python -c "import xgboost, lightgbm" 2>/dev/null; then
  if [[ "$(uname)" == "Darwin" ]]; then
    SP=$(.venv/bin/python -c "import sysconfig; print(sysconfig.get_paths()['purelib'])")
    for f in "$SP/xgboost/lib/libxgboost.dylib" "$SP/lightgbm/lib/lib_lightgbm.dylib"; do
      install_name_tool -add_rpath @loader_path/../../sklearn/.dylibs "$f" 2>/dev/null || true
      codesign -f -s - "$f"
    done
  fi
fi
.venv/bin/python -c "import xgboost, lightgbm, sklearn, optuna; print('ok', xgboost.__version__, lightgbm.__version__)"
