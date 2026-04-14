#!/usr/bin/env bash
# Local DIME webhook exercises for oe_payment_manager (Azure Functions).
# Use ONLY against allaboard-testing. Point local.settings.json Values at the test DB before `func start`.
#
# Prerequisites:
#   1) cd oe_payment_manager && npm install && func start   (default http://localhost:7071)
#   2) DB_NAME=allaboard-testing in oe_payment_manager/local.settings.json (or merge local.settings.testing.json)
#   3) Discover IDs: cd ai_scripts && ./db-query.sh "SELECT TOP 3 ..." --testing
#      (see oe_payment_manager/test_scripts/oe-payment-manager-test-discovery.sql)
#      Or omit env vars: the script can prompt to fetch defaults from allaboard-testing (resolve-defaults.cjs).
#
# Which test (FIRST argument). $0 in shell docs = this script path; from test_scripts use ./webhook-test.sh …
#   recurring-group-success       → group recurring (prompt: group or y)
#   recurring-individual-success  → individual recurring (prompt: individual or y)
#   ach-success                   → one-off ACH (one prompt: group|individual|enrollment|all|y|n)
#   ach-success-group             → ACH, enrollment for a member on a group (GroupId set)
#   ach-success-individual        → ACH, enrollment for a member not on a group (GroupId null)
#   credit-card-*                 → one-off card (prompt: enrollment or y)
#
# Usage (from repo root):
#   ./oe_payment_manager/test_scripts/webhook-test.sh help
#   GROUP_SCHEDULE_ID='...' ./oe_payment_manager/test_scripts/webhook-test.sh recurring-group-success
#   ENROLLMENT_ID='...' ./oe_payment_manager/test_scripts/webhook-test.sh credit-card-success
#   ./oe_payment_manager/test_scripts/webhook-test.sh cleanup --testing
#
# Env:
#   WEBHOOK_URL   default http://localhost:7071/api/webhooks/dime
#   TX_PREFIX     default LOCAL_TEST (marks rows for cleanup)
#   CC_CHARGE_AMOUNT / ACH_CHARGE_AMOUNT — override mock amount (defaults 50 / 75; resolve-defaults sets WEBHOOK_TEST_ENROLLMENT_PREMIUM_AMOUNT)
#   WEBHOOK_TEST_TEMPLATE_INVOICE_ID — set by resolve-defaults for group scope (Cramerton-style ~17k); ach_charge JSON includes invoice_id
#   INDIVIDUAL_RECURRING_AMOUNT — individual recurring mock amount (default 99; individual mode sets WEBHOOK_TEST_INDIVIDUAL_PLAN_PREMIUM_AMOUNT)
#
# Safety: exits if oe_payment_manager/local.settings.json has DB_NAME=allaboard-prod (help is allowed).
# For webhook scenarios (not help/cleanup): exits if the Functions host is not reachable (see assert_local_functions_running).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# test_scripts/ lives under oe_payment_manager/ — repo root is two levels up
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:7071/api/webhooks/dime}"
TX_PREFIX="${TX_PREFIX:-LOCAL_TEST}"
# Credit card / ACH: optional WEBHOOK_TEST_ENROLLMENT_PREMIUM_AMOUNT from resolve-defaults (enrollment PremiumAmount).
CC_CHARGE_AMOUNT="${WEBHOOK_TEST_ENROLLMENT_PREMIUM_AMOUNT:-${CC_CHARGE_AMOUNT:-50.00}}"
ACH_CHARGE_AMOUNT="${WEBHOOK_TEST_ENROLLMENT_PREMIUM_AMOUNT:-${ACH_CHARGE_AMOUNT:-75.00}}"
INDIVIDUAL_RECURRING_AMOUNT="${WEBHOOK_TEST_INDIVIDUAL_PLAN_PREMIUM_AMOUNT:-${INDIVIDUAL_RECURRING_AMOUNT:-99.00}}"

# Re-apply after WEBHOOK_TEST_* exports (defaults.env or resolve-defaults.cjs).
refresh_charge_amounts_from_env() {
  CC_CHARGE_AMOUNT="${WEBHOOK_TEST_ENROLLMENT_PREMIUM_AMOUNT:-${CC_CHARGE_AMOUNT:-50.00}}"
  ACH_CHARGE_AMOUNT="${WEBHOOK_TEST_ENROLLMENT_PREMIUM_AMOUNT:-${ACH_CHARGE_AMOUNT:-75.00}}"
  INDIVIDUAL_RECURRING_AMOUNT="${WEBHOOK_TEST_INDIVIDUAL_PLAN_PREMIUM_AMOUNT:-${INDIVIDUAL_RECURRING_AMOUNT:-99.00}}"
}

# Refuse to run webhook/cleanup if oe_payment_manager/local.settings.json targets production.
assert_not_prod_db() {
  local settings="$REPO_ROOT/oe_payment_manager/local.settings.json"
  if [ ! -f "$settings" ]; then
    echo "❌ Refusing to run: missing $settings (cannot verify DB_NAME)."
    exit 1
  fi
  local db_name
  db_name=$(node -e "
    const fs = require('fs');
    const j = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const v = j.Values && j.Values.DB_NAME;
    process.stdout.write(v != null ? String(v).trim() : '');
  " "$settings")
  if [ "$db_name" = "allaboard-prod" ]; then
    echo "❌ Refusing to run: $settings has DB_NAME=allaboard-prod (production)."
    echo "   Point Values.DB_NAME at allaboard-testing (see oe_payment_manager/local.settings.testing.example.json),"
    echo "   restart \`func start\`, then re-run this script."
    exit 1
  fi
}

# Require Azure Functions Core Tools host (func start) for scenarios that POST to WEBHOOK_URL.
assert_local_functions_running() {
  local origin
  origin=$(echo "${WEBHOOK_URL}" | sed -E 's#(https?://[^/]+).*#\1#')
  local code
  code=$(curl -sS --connect-timeout 2 --max-time 5 -o /dev/null -w "%{http_code}" "${origin}/" 2>/dev/null) || code="000"
  [ -z "$code" ] && code="000"
  if [ "$code" = "000" ]; then
    echo "❌ Local webhook server is not reachable at ${origin}"
    echo "   Start the payment manager (from repo root):"
    echo "     cd oe_payment_manager && npm install && func start"
    echo "   Default URL: http://localhost:7071  (set WEBHOOK_URL if you use another host/port)"
    exit 1
  fi
}

usage() {
  sed -n '1,80p' "$0" | grep -E '^#' | sed 's/^# \{0,1\}//'
  cat <<EOF

Pick the scenario name first (from the test_scripts directory, ./ means this folder):

  Group recurring (DIME group schedule):     ./webhook-test.sh recurring-group-success
  Individual recurring (household schedule): ./webhook-test.sh recurring-individual-success
  ACH one-off (any enrollment):              ./webhook-test.sh ach-success
  ACH — member on a group:                   ./webhook-test.sh ach-success-group
  ACH — member not on a group:               ./webhook-test.sh ach-success-individual
  Credit card one-off:                       ./webhook-test.sh credit-card-success

When prompted for defaults, type the word or **y**.

Scenarios:
  help                      This help
  cleanup [--testing]       Delete oe.Payments / oe.PaymentWebhookEvents with $TX_PREFIX% (needs db-execute --testing)
  recurring-group-success   Group DIME schedule — needs GROUP_SCHEDULE_ID (+ optional CUSTOMER_UUID)
  recurring-group-failed    Same
  recurring-individual-success  Individual schedule — needs INDIVIDUAL_SCHEDULE_ID
  recurring-individual-failed Same
  credit-card-success       One-off — needs ENROLLMENT_ID
  credit-card-failed
  credit-card-pending
  ach-success               One-off ACH — one prompt (group / individual / enrollment / all / y)
  ach-success-group         ACH — enrollment for a member with GroupId set
  ach-success-individual    ACH — enrollment for a member with no GroupId
  ach-failed / ach-failed-group / ach-failed-individual  Same filters as ach-success*

Examples:
  ./webhook-test.sh recurring-group-success
  ./webhook-test.sh ach-success-group
  ./webhook-test.sh ach-success-individual
  GROUP_SCHEDULE_ID='sched_123' CUSTOMER_UUID='uuid-from-groups' ./webhook-test.sh recurring-group-success
  ENROLLMENT_ID='xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' ./webhook-test.sh credit-card-success
  ./webhook-test.sh cleanup --testing
EOF
}

# When defaults.env pre-fills ENROLLMENT_ID, maybe_prompt_default_test_ids returns early and never runs
# resolve-defaults — so we never get WEBHOOK_TEST_TEMPLATE_INVOICE_ID / ~17k amount. Merge from DB here.
merge_group_invoice_template_if_needed() {
  local sc="$1"
  case "$sc" in
    ach-success|ach-success-group|ach-success-individual|ach-failed|ach-failed-group|ach-failed-individual) ;;
    *) return 0 ;;
  esac
  case "$sc" in
    ach-success-individual|ach-failed-individual) return 0 ;;
  esac
  [ -n "${WEBHOOK_TEST_TEMPLATE_INVOICE_ID:-}" ] && return 0
  local merge_ok=0
  case "$sc" in
    ach-success-group|ach-failed-group) merge_ok=1 ;;
    ach-success|ach-failed)
      [ "${WEBHOOK_TEST_ENROLLMENT_SCOPE:-}" = "group" ] && merge_ok=1
      ;;
  esac
  [ "$merge_ok" -eq 1 ] || return 0
  [ -f "$REPO_ROOT/ai_scripts/.env" ] || return 0
  # shellcheck disable=SC1091
  set -a
  source "$REPO_ROOT/ai_scripts/.env"
  set +a
  export WEBHOOK_TEST_ENROLLMENT_SCOPE="${WEBHOOK_TEST_ENROLLMENT_SCOPE:-group}"
  echo ""
  echo "Merging group invoice template from DB (WEBHOOK_TEST_TEMPLATE_INVOICE_ID still empty) — WEBHOOK_TEST_ENROLLMENT_SCOPE=${WEBHOOK_TEST_ENROLLMENT_SCOPE}"
  eval "$(node "$SCRIPT_DIR/resolve-defaults.cjs" --export --mode=enrollment)" || {
    echo "⚠️  invoice template merge skipped (resolve-defaults failed)"
    return 0
  }
  refresh_charge_amounts_from_env
  if [ -n "${WEBHOOK_TEST_TEMPLATE_INVOICE_ID:-}" ]; then
    echo "  → invoice_id=${WEBHOOK_TEST_TEMPLATE_INVOICE_ID}  ACH amount=${ACH_CHARGE_AMOUNT}"
  fi
  echo ""
}

maybe_prompt_default_test_ids() {
  local sc="$1"
  # Filters default enrollment pick for ACH/CC (resolve-defaults.cjs): group member vs not-on-a-group.
  case "$sc" in
    ach-success-group|ach-failed-group) export WEBHOOK_TEST_ENROLLMENT_SCOPE=group ;;
    ach-success-individual|ach-failed-individual) export WEBHOOK_TEST_ENROLLMENT_SCOPE=individual ;;
    ach-success|ach-failed) ;; # preserve WEBHOOK_TEST_ENROLLMENT_SCOPE for env or combined prompt below
    *) export WEBHOOK_TEST_ENROLLMENT_SCOPE="" ;;
  esac
  local need_group=""
  local need_individual=""
  local need_enrollment=""
  case "$sc" in
    recurring-group-success|recurring-group-failed) need_group=1 ;;
    recurring-individual-success|recurring-individual-failed) need_individual=1 ;;
    credit-card-success|credit-card-failed|credit-card-pending|ach-success|ach-success-group|ach-success-individual|ach-failed|ach-failed-group|ach-failed-individual) need_enrollment=1 ;;
    *) return 0 ;;
  esac

  local missing=0
  [ -n "$need_group" ] && [ -z "${GROUP_SCHEDULE_ID:-}" ] && missing=1
  [ -n "$need_individual" ] && [ -z "${INDIVIDUAL_SCHEDULE_ID:-}" ] && missing=1
  [ -n "$need_enrollment" ] && [ -z "${ENROLLMENT_ID:-}" ] && missing=1
  [ "$missing" -eq 0 ] && return 0

  echo ""
  echo "Missing test ID(s) for scenario \"$sc\":"
  [ -n "$need_group" ] && [ -z "${GROUP_SCHEDULE_ID:-}" ] && echo "  - GROUP_SCHEDULE_ID"
  [ -n "$need_individual" ] && [ -z "${INDIVIDUAL_SCHEDULE_ID:-}" ] && echo "  - INDIVIDUAL_SCHEDULE_ID"
  [ -n "$need_enrollment" ] && [ -z "${ENROLLMENT_ID:-}" ] && echo "  - ENROLLMENT_ID"
  echo ""

  # One primary mode per scenario — prompt only what applies (avoid choosing "group" for ACH by mistake).
  local default_mode=""
  if [ -n "$need_group" ] && [ -z "${GROUP_SCHEDULE_ID:-}" ]; then
    default_mode="group"
  elif [ -n "$need_individual" ] && [ -z "${INDIVIDUAL_SCHEDULE_ID:-}" ]; then
    default_mode="individual"
  elif [ -n "$need_enrollment" ] && [ -z "${ENROLLMENT_ID:-}" ]; then
    default_mode="enrollment"
  fi

  echo "Fetch defaults from allaboard-testing (same DB as db-query.sh --testing)?"
  case "$default_mode" in
    group)
      echo "  group  — group recurring only (GROUP_SCHEDULE_ID)"
      echo "  all    — also resolve individual + enrollment IDs (for other scenarios in this shell)"
      echo "  y      — same as **group**"
      ;;
    individual)
      echo "  individual — individual recurring only (INDIVIDUAL_SCHEDULE_ID + primary member plan amount)"
      echo "  all        — also resolve group + enrollment IDs"
      echo "  y          — same as **individual**"
      ;;
    enrollment)
      echo "  group       — pick enrollment for a member **on a group**, then fetch ENROLLMENT_ID (+ premium)"
      echo "  individual  — pick enrollment **not on a group**, then fetch ENROLLMENT_ID (+ premium)"
      echo "  enrollment  — fetch ENROLLMENT_ID only; scope from WEBHOOK_TEST_ENROLLMENT_SCOPE or default **group**"
      echo "  all         — also resolve GROUP_SCHEDULE_ID + INDIVIDUAL_SCHEDULE_ID"
      echo "  y           — same as **enrollment**"
      echo ""
      echo "  Tip: recurring schedule tests → recurring-group-success / recurring-individual-success"
      ;;
  esac
  echo "  n      — skip"
  echo ""
  read -r -p "Choice: " _choice
  _choice=$(echo "${_choice:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  _choice=$(echo "$_choice" | tr '[:upper:]' '[:lower:]')

  case "${_choice:-}" in
    n|no|q)
      echo "Set the env vars above, or run discovery SQL (oe-payment-manager-test-discovery.sql)."
      exit 1
      ;;
    y|yes)
      _choice="$default_mode"
      ;;
  esac

  if [ -n "$need_group" ] && [ -z "${GROUP_SCHEDULE_ID:-}" ]; then
    case "$_choice" in
      group|all) ;;
      *)
        echo "❌ For \"$sc\" type **group**, **all**, or **y** (not \"${_choice}\")."
        exit 1
        ;;
    esac
  fi
  if [ -n "$need_individual" ] && [ -z "${INDIVIDUAL_SCHEDULE_ID:-}" ]; then
    case "$_choice" in
      individual|all) ;;
      *)
        echo "❌ For \"$sc\" type **individual**, **all**, or **y**."
        exit 1
        ;;
    esac
  fi
  if [ -n "$need_enrollment" ] && [ -z "${ENROLLMENT_ID:-}" ]; then
    case "$_choice" in
      enrollment|all|group|individual) ;;
      *)
        echo "❌ For \"$sc\" type **group**, **individual**, **enrollment**, **all**, or **y** (not \"${_choice}\")."
        exit 1
        ;;
    esac
  fi

  # Map menu choice → resolve-defaults --mode=… (enrollment: group|individual mean scope, not "group" mode)
  local resolve_mode="$_choice"
  if [ "$default_mode" = "enrollment" ]; then
    case "$_choice" in
      group)
        export WEBHOOK_TEST_ENROLLMENT_SCOPE=group
        resolve_mode=enrollment
        ;;
      individual)
        export WEBHOOK_TEST_ENROLLMENT_SCOPE=individual
        resolve_mode=enrollment
        ;;
      enrollment)
        if [ -z "${WEBHOOK_TEST_ENROLLMENT_SCOPE:-}" ]; then
          export WEBHOOK_TEST_ENROLLMENT_SCOPE=group
        fi
        resolve_mode=enrollment
        ;;
      all)
        resolve_mode=all
        ;;
    esac
  fi

  if [ ! -f "$REPO_ROOT/ai_scripts/.env" ]; then
    echo "❌ Missing $REPO_ROOT/ai_scripts/.env (DB credentials for resolve-defaults.cjs)"
    exit 1
  fi

  # shellcheck disable=SC1091
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/ai_scripts/.env"
  set +a

  eval "$(node "$SCRIPT_DIR/resolve-defaults.cjs" --export --mode="${resolve_mode}")" || {
    echo "❌ resolve-defaults.cjs failed (check DB credentials and network)."
    exit 1
  }
  refresh_charge_amounts_from_env

  local still=0
  [ -n "$need_group" ] && [ -z "${GROUP_SCHEDULE_ID:-}" ] && still=1
  [ -n "$need_individual" ] && [ -z "${INDIVIDUAL_SCHEDULE_ID:-}" ] && still=1
  [ -n "$need_enrollment" ] && [ -z "${ENROLLMENT_ID:-}" ] && still=1
  if [ "$still" -ne 0 ]; then
    echo "❌ Could not resolve required ID(s) from the database (no matching rows)."
    exit 1
  fi

  echo ""
  echo "Using defaults:"
  if [ -n "$need_group" ] && [ -n "${GROUP_SCHEDULE_ID:-}" ]; then
    echo "  Group: ${WEBHOOK_TEST_GROUP_NAME:-?} (GROUP_SCHEDULE_ID=${GROUP_SCHEDULE_ID})"
  fi
  if [ -n "$need_individual" ] && [ -n "${INDIVIDUAL_SCHEDULE_ID:-}" ]; then
    echo "  Individual recurring: ${WEBHOOK_TEST_INDIVIDUAL_NAME:-?} (INDIVIDUAL_SCHEDULE_ID=${INDIVIDUAL_SCHEDULE_ID})"
    echo "  Individual plan amount (mock): ${INDIVIDUAL_RECURRING_AMOUNT}"
  fi
  if [ -n "$need_enrollment" ] && [ -n "${ENROLLMENT_ID:-}" ]; then
    local _enr_msg
    _enr_msg="  Enrollment (member): ${WEBHOOK_TEST_ENROLLMENT_MEMBER_NAME:-?} (ENROLLMENT_ID=${ENROLLMENT_ID})"
    if [ -n "${WEBHOOK_TEST_ENROLLMENT_PREMIUM_AMOUNT:-}" ]; then
      _enr_msg="${_enr_msg} premium=${WEBHOOK_TEST_ENROLLMENT_PREMIUM_AMOUNT}"
    fi
    echo "$_enr_msg"
  fi
  echo ""
}

next_tx() {
  echo "${TX_PREFIX}_${1}_${RANDOM}_$(date +%s)"
}

post_json() {
  local body="$1"
  echo "--- Response ---"
  curl -sS -X POST "$WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -H 'x-dime-signature: local-test' \
    -d "$body"
  echo ""
}

run_cleanup() {
  local testing_flag="${1:-}"
  local sql="$SCRIPT_DIR/oe-payment-manager-delete-local-test-payments.sql"
  if [ ! -f "$sql" ]; then
    echo "Missing $sql"
    exit 1
  fi
  echo "Running cleanup via db-execute.sh ..."
  "$REPO_ROOT/ai_scripts/db-execute.sh" "$sql" $testing_flag
}

scenario="${1:-help}"
if [ "$scenario" != "help" ] && [ "$scenario" != "-h" ] && [ "$scenario" != "--help" ]; then
  assert_not_prod_db
fi
# Webhook POST scenarios only (cleanup uses db-execute, not the HTTP server)
if [ "$scenario" != "help" ] && [ "$scenario" != "-h" ] && [ "$scenario" != "--help" ] && [ "$scenario" != "cleanup" ]; then
  assert_local_functions_running
fi
shift || true

# Optional: copy defaults.env.example → defaults.env and fill IDs to skip the prompt.
if [ -f "$SCRIPT_DIR/defaults.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/defaults.env"
  set +a
  refresh_charge_amounts_from_env
fi

maybe_prompt_default_test_ids "$scenario"

merge_group_invoice_template_if_needed "$scenario"

case "$scenario" in
  help|-h|--help)
    usage
    ;;
  cleanup)
    run_cleanup "${1:-}"
    ;;
  recurring-group-success)
    : "${GROUP_SCHEDULE_ID:?Set GROUP_SCHEDULE_ID from discovery query}"
    TX="$(next_tx RGRP_OK)"
    optional_uuid=""
    if [ -n "${CUSTOMER_UUID:-}" ]; then
      optional_uuid="
  \"customer_uuid\": \"$CUSTOMER_UUID\","
    fi
    body=$(cat <<EOF
{
  "type": "recurring_payment_success",
  "transaction_number": "$TX",
  "amount": "123.45",
  "schedule_id": "$GROUP_SCHEDULE_ID",$optional_uuid
  "status_code": "00",
  "status_text": "Approved",
  "transaction_type": "Recurring"
}
EOF
)
    echo "POST recurring_payment_success (group) tx=$TX"
    post_json "$body"
    ;;
  recurring-group-failed)
    : "${GROUP_SCHEDULE_ID:?Set GROUP_SCHEDULE_ID}"
    TX="$(next_tx RGRP_FAIL)"
    optional_uuid=""
    if [ -n "${CUSTOMER_UUID:-}" ]; then
      optional_uuid="
  \"customer_uuid\": \"$CUSTOMER_UUID\","
    fi
    body=$(cat <<EOF
{
  "type": "recurring_payment_failed",
  "transaction_number": "$TX",
  "amount": "123.45",
  "schedule_id": "$GROUP_SCHEDULE_ID",$optional_uuid
  "status_text": "Insufficient funds",
  "failure_reason": "Insufficient funds"
}
EOF
)
    echo "POST recurring_payment_failed (group) tx=$TX"
    post_json "$body"
    ;;
  recurring-individual-success)
    : "${INDIVIDUAL_SCHEDULE_ID:?Set INDIVIDUAL_SCHEDULE_ID from an existing oe.Payments.RecurringScheduleId}"
    TX="$(next_tx RIND_OK)"
    body=$(cat <<EOF
{
  "type": "recurring_payment_success",
  "transaction_number": "$TX",
  "amount": "$INDIVIDUAL_RECURRING_AMOUNT",
  "schedule_id": "$INDIVIDUAL_SCHEDULE_ID",
  "status_code": "00",
  "status_text": "Approved"
}
EOF
)
    echo "POST recurring_payment_success (individual) tx=$TX amount=$INDIVIDUAL_RECURRING_AMOUNT"
    post_json "$body"
    ;;
  recurring-individual-failed)
    : "${INDIVIDUAL_SCHEDULE_ID:?Set INDIVIDUAL_SCHEDULE_ID}"
    TX="$(next_tx RIND_FAIL)"
    body=$(cat <<EOF
{
  "type": "recurring_payment_failed",
  "transaction_number": "$TX",
  "amount": "$INDIVIDUAL_RECURRING_AMOUNT",
  "schedule_id": "$INDIVIDUAL_SCHEDULE_ID",
  "status_text": "Card declined"
}
EOF
)
    echo "POST recurring_payment_failed (individual) tx=$TX amount=$INDIVIDUAL_RECURRING_AMOUNT"
    post_json "$body"
    ;;
  credit-card-success)
    : "${ENROLLMENT_ID:?Set ENROLLMENT_ID from discovery query}"
    TX="$(next_tx CC_OK)"
    body=$(cat <<EOF
{
  "type": "credit_card_charge",
  "transaction_number": "$TX",
  "amount": "$CC_CHARGE_AMOUNT",
  "enrollment_id": "$ENROLLMENT_ID",
  "status_code": "00",
  "status_text": "Approved",
  "transaction_type": "Credit Card",
  "pending": false
}
EOF
)
    echo "POST credit_card_charge (success) tx=$TX amount=$CC_CHARGE_AMOUNT"
    post_json "$body"
    ;;
  credit-card-failed)
    : "${ENROLLMENT_ID:?Set ENROLLMENT_ID}"
    TX="$(next_tx CC_FAIL)"
    body=$(cat <<EOF
{
  "type": "credit_card_charge",
  "transaction_number": "$TX",
  "amount": "$CC_CHARGE_AMOUNT",
  "enrollment_id": "$ENROLLMENT_ID",
  "status_code": "05",
  "status_text": "Declined",
  "transaction_type": "Credit Card"
}
EOF
)
    echo "POST credit_card_charge (failed) tx=$TX"
    post_json "$body"
    ;;
  credit-card-pending)
    : "${ENROLLMENT_ID:?Set ENROLLMENT_ID}"
    TX="$(next_tx CC_PEND)"
    body=$(cat <<EOF
{
  "type": "credit_card_charge",
  "transaction_number": "$TX",
  "amount": "$CC_CHARGE_AMOUNT",
  "enrollment_id": "$ENROLLMENT_ID",
  "status_code": "00",
  "status_text": "Approved",
  "pending": true,
  "transaction_type": "Credit Card"
}
EOF
)
    echo "POST credit_card_charge (pending flag) tx=$TX"
    post_json "$body"
    ;;
  ach-success|ach-success-group|ach-success-individual)
    : "${ENROLLMENT_ID:?Set ENROLLMENT_ID}"
    TX="$(next_tx ACH_OK)"
    inv_line=""
    if [ -n "${WEBHOOK_TEST_TEMPLATE_INVOICE_ID:-}" ]; then
      inv_line='"invoice_id": "'"$WEBHOOK_TEST_TEMPLATE_INVOICE_ID"'",'
    fi
    body=$(cat <<EOF
{
  "type": "ach_charge",
  "transaction_number": "$TX",
  "amount": "$ACH_CHARGE_AMOUNT",
  ${inv_line}
  "enrollment_id": "$ENROLLMENT_ID",
  "status_code": "00",
  "status_text": "Approved",
  "transaction_type": "ACH",
  "pending": false
}
EOF
)
    echo "POST ach_charge (success) tx=$TX amount=$ACH_CHARGE_AMOUNT scenario=$scenario"
    post_json "$body"
    ;;
  ach-failed|ach-failed-group|ach-failed-individual)
    : "${ENROLLMENT_ID:?Set ENROLLMENT_ID}"
    TX="$(next_tx ACH_FAIL)"
    inv_line_fail=""
    if [ -n "${WEBHOOK_TEST_TEMPLATE_INVOICE_ID:-}" ]; then
      inv_line_fail='"invoice_id": "'"$WEBHOOK_TEST_TEMPLATE_INVOICE_ID"'",'
    fi
    body=$(cat <<EOF
{
  "type": "ach_charge",
  "transaction_number": "$TX",
  "amount": "$ACH_CHARGE_AMOUNT",
  ${inv_line_fail}
  "enrollment_id": "$ENROLLMENT_ID",
  "status_code": "99",
  "status_text": "Rejected",
  "transaction_type": "ACH"
}
EOF
)
    echo "POST ach_charge (failed) tx=$TX scenario=$scenario"
    post_json "$body"
    ;;
  *)
    echo "Unknown scenario: $scenario"
    usage
    exit 1
    ;;
esac
