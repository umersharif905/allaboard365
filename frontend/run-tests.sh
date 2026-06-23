#!/usr/bin/env bash
# Thin wrapper around repo root run-tests.sh (interactive wizard lives there).
#
# Usage:
#   ./run-tests.sh                → same as ../run-tests.sh (suite wizard)
#   ./run-tests.sh full           → Vitest + all Cypress (no wizard)
#   ./run-tests.sh 5              → one enrollment Cypress spec by index
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if (( $# == 0 )); then
  exec "$ROOT/run-tests.sh"
fi
if [[ "$1" == "full" || "$1" == "frontend-full" || "$1" == "vitest-cypress" ]]; then
  exec "$ROOT/run-tests.sh" frontend-full
fi
if (( $# == 1 )) && [[ "$1" =~ ^[0-9]+$ ]]; then
  exec "$ROOT/run-tests.sh" cypress "$1"
fi
echo "Usage: $0 [full|enrollment-index]" >&2
echo "  (no args)                   suite wizard (see $ROOT/run-tests.sh help)" >&2
echo "  full                        Vitest + all Cypress" >&2
echo "  (positive integer)           single enrollment Cypress spec by list index" >&2
exit 1
