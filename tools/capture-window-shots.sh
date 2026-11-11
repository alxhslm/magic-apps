#!/usr/bin/env bash
set -euo pipefail

# Automated window screenshot capture for Magic Apps website and documentation.
# Enforces demo-profile guardrails, verifies fixtures over CDP, handles focus
# and appearance switching, and outputs canonical WebP assets.
#
# Usage:
#   ./tools/capture-window-shots.sh [--app <magical|magimail|all>] [--out-dir <path>]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
exec node "$SCRIPT_DIR/capture-window-shots.mjs" "$@"
