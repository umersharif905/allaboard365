#!/usr/bin/env bash
# Replay missed recurring_payment_success payloads → POST /api/internal/recurring-payment-success/apply
# Usage:
#   cp backend/scripts/recurring-success-replay.template backend/scripts/recurring-success-replay.env
#   # edit ...env with BACKEND_INTERNAL_BASE_URL + INTERNAL_API_TOKEN
#   RECURRING_REPLAY_DRY_RUN=1 ./backend/scripts/run-recurring-success-replay.sh   # no writes
#   ./backend/scripts/run-recurring-success-replay.sh                                  # LIVE
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${RECURRING_REPLAY_ENV:-$SCRIPT_DIR/recurring-success-replay.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  echo "  cp $SCRIPT_DIR/recurring-success-replay.template $SCRIPT_DIR/recurring-success-replay.env" >&2
  echo "Then set BACKEND_INTERNAL_BASE_URL and INTERNAL_API_TOKEN (or RECURRING_REPLAY_DIRECT_DB=1 for DB-only)." >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a
source "$ENV_FILE"
set +a

if [[ -n "${RECURRING_REPLAY_DRY_RUN:-}" ]]; then
  export DRY_RUN=1
fi

export BACKEND_INTERNAL_BASE_URL="${BACKEND_INTERNAL_BASE_URL:-}"
export INTERNAL_API_TOKEN="${INTERNAL_API_TOKEN:-}"
export PROCESSOR_TXN_IDS="${PROCESSOR_TXN_IDS:-}"
export WEBHOOK_EVENT_IDS="${WEBHOOK_EVENT_IDS:-}"
export RECURRING_REPLAY_DIRECT_DB="${RECURRING_REPLAY_DIRECT_DB:-}"

if [[ -z "$PROCESSOR_TXN_IDS" ]] && [[ -z "$WEBHOOK_EVENT_IDS" ]]; then
  echo "recurring-success-replay.env needs PROCESSOR_TXN_IDS or WEBHOOK_EVENT_IDS." >&2
  exit 1
fi

if [[ "${DRY_RUN:-}" != "1" ]] && [[ "${RECURRING_REPLAY_DIRECT_DB:-}" != "1" ]] &&
  { [[ -z "$BACKEND_INTERNAL_BASE_URL" ]] || [[ -z "$INTERNAL_API_TOKEN" ]]; }; then
  echo "HTTP live replay requires BACKEND_INTERNAL_BASE_URL and INTERNAL_API_TOKEN in $ENV_FILE" >&2
  echo "Or set RECURRING_REPLAY_DIRECT_DB=1 to apply directly against the configured SQL database." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is not on PATH" >&2
  exit 1
fi

cd "$BACKEND_DIR"
echo "Executing from $BACKEND_DIR (DRY_RUN=${DRY_RUN:-0} RECURRING_REPLAY_DIRECT_DB=${RECURRING_REPLAY_DIRECT_DB:-0})" >&2
exec node scripts/replay-recurring-success-webhooks.js
