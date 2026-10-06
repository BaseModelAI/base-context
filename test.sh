#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The runner uses a temporary home and never moves or reads your login files.
exec node "$SCRIPT_DIR/scripts/test-offline.mjs" "$@"
