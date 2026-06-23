#!/usr/bin/env bash
# Wrapper: see repo root run-tests.sh — runs backend npm test (full Jest).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/run-tests.sh" backend "$@"
