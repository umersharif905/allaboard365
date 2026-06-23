#!/usr/bin/env bash
# Replay stored oe.PaymentWebhookEvents through DimeWebhookHandler (no duplicate INSERT).
# Usage:
#   cp backend/scripts/dime-webhook-replay.template backend/scripts/dime-webhook-replay.env
#   DIME_WEBHOOK_REPLAY_DRY_RUN=1 ./backend/scripts/run-dime-webhook-replay.sh
#   ./backend/scripts/run-dime-webhook-replay.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${DIME_WEBHOOK_REPLAY_ENV:-$SCRIPT_DIR/dime-webhook-replay.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  echo "  cp $SCRIPT_DIR/dime-webhook-replay.template $SCRIPT_DIR/dime-webhook-replay.env" >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a
source "$ENV_FILE"
set +a

# backend/.env supplies DB_* / BACKEND_API_URL when not overridden in replay env
if [[ -f "$BACKEND_DIR/.env" ]]; then
  # shellcheck source=/dev/null
  set -a
  source "$BACKEND_DIR/.env"
  set +a
fi

if [[ -n "${DIME_WEBHOOK_REPLAY_DRY_RUN:-}" ]]; then
  export DRY_RUN=1
fi

export WEBHOOK_EVENT_IDS="${WEBHOOK_EVENT_IDS:-}"
export PROCESSOR_TXN_IDS="${PROCESSOR_TXN_IDS:-}"
export EVENT_TYPES="${EVENT_TYPES:-}"
export FORCE_REPROCESS="${FORCE_REPROCESS:-}"

if [[ -z "$WEBHOOK_EVENT_IDS" ]] && [[ -z "$PROCESSOR_TXN_IDS" ]]; then
  echo "dime-webhook-replay.env needs WEBHOOK_EVENT_IDS and/or PROCESSOR_TXN_IDS." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is not on PATH" >&2
  exit 1
fi

cd "$BACKEND_DIR"
echo "Executing from $BACKEND_DIR (DRY_RUN=${DRY_RUN:-0} DB_NAME=${DB_NAME:-})" >&2
exec node scripts/replay-dime-webhook-events.js
