#!/usr/bin/env bash
# Full backend Jest + frontend Vitest + Cypress e2e. From repo root.
# ./run-tests.sh (no args) always shows the suite wizard first.
# Cypress auto-starts test servers :3101/:5273 if needed (Terminal on macOS); dev :3001/:5173 untouched.
#
# Usage:
#   ./run-tests.sh                 # suite wizard (All / Enrollment / Other)
#   ./run-tests.sh all             # Jest + Vitest + all Cypress (skip wizard)
#   ./run-tests.sh enrollment      # enrollment Cypress only
#   ./run-tests.sh other           # Jest + Vitest + Cypress except enrollment/
#   ./run-tests.sh backend|jest    # Jest only (no servers)
#   ./run-tests.sh cypress         # all Cypress (servers auto-start)
#
#   CI/automation: ./run-tests.sh all | enrollment | other  (or OE_NONINTERACTIVE=1 RUN_TESTS=…)
#
# DB_NAME must be a test database (default allowlist: allaboard-testing). See scripts/lib-test-db-guard.sh
#   OEO_ALLOW_NON_TEST_DB=1 — override (emergency)  |  OEO_TEST_DB_NAMES=db1,db2
#
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# shellcheck source=scripts/test-ports.sh
source "$ROOT/scripts/test-ports.sh"
# shellcheck source=scripts/start-test-servers.sh
source "$ROOT/scripts/start-test-servers.sh"
# shellcheck source=scripts/test-reports.sh
source "$ROOT/scripts/test-reports.sh"

ENROLLMENT_SPECS=(
  short-code-resolver
  link-lifecycle
  used-link-handler
  scenario-1-individual-new-member
  scenario-2-individual-existing-user
  scenario-3a-existing-member-blocked
  scenario-3b-existing-member-no-enrollment
  scenario-4-group-employee
  dependents-variations
  dob-age-qualification
  tier-dependent-validation
  unshared-amount-variations
  payment-dime-matrix
  payment-failures
  real-backend-walkthrough
  tier-dependent-real-backend
)

run_backend_tests() {
  echo "== Backend Jest (npm test — all backend tests) =="
  ( cd "$ROOT/backend" && npm test -- --json --outputFile="$OE_TEST_REPORT_DIR/jest.json" )
}

run_frontend_tests() {
  echo "== Frontend Vitest (npm run test:run) =="
  echo "   Unit/component tests (jsdom + mocks) — no Vite :${OE_TEST_FRONTEND_PORT} or API :${OE_TEST_BACKEND_PORT} needed."
  ( cd "$ROOT/frontend" && npm run test:run -- --reporter=default --reporter=json --outputFile=../test-reports/vitest.json )
}

# Start :3101/:5273 in Terminal (macOS) or background if not already healthy — no prompt.
ensure_cypress_servers() {
  echo "== Cypress needs both test servers: Vite :${OE_TEST_FRONTEND_PORT} + API :${OE_TEST_BACKEND_PORT} =="
  start_servers
}

run_cypress_all() {
  echo "== Cypress: all specs =="
  oe_run_cypress
}

run_cypress_non_enrollment() {
  echo "== Cypress: all specs except cypress/e2e/enrollment/ =="
  local _here specs
  _here="$PWD"
  cd "$ROOT/frontend" || return 1
  specs="$(find cypress/e2e \( -name '*.cy.ts' -o -name '*.cy.js' \) ! -path 'cypress/e2e/enrollment/*' | paste -sd, - -)"
  if [[ -z "$specs" ]]; then
    echo "No non-enrollment Cypress specs found." >&2
    cd "$_here" || true
    return 1
  fi
  oe_run_cypress --spec "$specs"
  local code=$?
  cd "$_here" || true
  return "$code"
}

run_cypress_enrollment_isolated_loop() {
  echo "== Cypress: enrollment/ specs — one process each, continue-on-failure =="
  local failed=0
  local _here
  _here="$PWD"
  for spec in "${ENROLLMENT_SPECS[@]}"; do
    echo ""
    echo ">>> cypress (enrollment): ${spec}.cy.ts"
    if ! oe_run_cypress --spec "cypress/e2e/enrollment/${spec}.cy.ts"; then
      echo "FAILED: $spec"
      failed=1
    fi
  done
  cd "$_here" || true
  return "$failed"
}

run_cypress_enrollment_index() {
  local idx="${1:-}"
  if ! [[ "$idx" =~ ^[0-9]+$ ]]; then
    echo "Usage: $0 cypress <1-${#ENROLLMENT_SPECS[@]}>" >&2
    return 1
  fi
  if (( idx < 1 || idx > ${#ENROLLMENT_SPECS[@]} )); then
    echo "Index must be 1–${#ENROLLMENT_SPECS[@]}" >&2
    return 1
  fi
  local spec="${ENROLLMENT_SPECS[$((idx - 1))]}"
  echo "== Cypress enrollment: [${idx}] ${spec}.cy.ts =="
  local _here
  _here="$PWD"
  oe_run_cypress --spec "cypress/e2e/enrollment/${spec}.cy.ts"
  local code=$?
  cd "$_here" || true
  return "$code"
}

# Full logging stack: separate Cypress spec + logs/* scripts (from setup-comprehensive-logging.sh)
run_comprehensive() {
  local s1="$ROOT/logs/backend/start-backend-with-logging.sh"
  local s2="$ROOT/logs/frontend/start-frontend-with-logging.sh"
  local s3="$ROOT/logs/cypress/enhanced-test-runner-with-logs.sh"
  for f in "$s1" "$s2" "$s3"; do
    if [[ ! -f "$f" ]]; then
      echo "run-tests.sh: comprehensive mode needs logging scripts (missing: $f)" >&2
      echo "  Run: ./setup-comprehensive-logging.sh" >&2
      return 1
    fi
  done
  chmod +x "$s1" "$s2" "$s3" 2>/dev/null || true

  echo "🚀 Comprehensive test (backends + Cypress with file logging)..."
  pkill -f "node app.js" 2>/dev/null || true
  pkill -f "npm run dev" 2>/dev/null || true
  sleep 2

  echo "📡 Starting backend..."
  "$s1" &
  local BACKEND_PID=$!
  sleep 5
  echo "🌐 Starting frontend..."
  "$s2" &
  local FRONTEND_PID=$!
  sleep 10
  echo "🧪 Running Cypress (enhanced logging)..."
  if ! ( cd "$ROOT" && "$s3" ); then
    local e=$?
    kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
    return "$e"
  fi
  echo "🧹 Cleaning up..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  echo "✅ Done. See logs/ for backend, frontend, and cypress run folders."
  return 0
}

run_suite_all() {
  run_backend_tests || return 1
  run_frontend_tests || return 1
  ensure_cypress_servers || return 1
  run_cypress_all || return 1
}

run_suite_enrollment() {
  ensure_cypress_servers || return 1
  run_cypress_enrollment_isolated_loop
}

run_suite_other() {
  run_backend_tests || return 1
  run_frontend_tests || return 1
  ensure_cypress_servers || return 1
  run_cypress_non_enrollment || return 1
}

run_full_suite() {
  run_suite_all
}

print_spec_menu() {
  local i=0
  echo "Enrollment Cypress specs (use: $0 cypress <number>):"
  for s in "${ENROLLMENT_SPECS[@]}"; do
    i=$((i + 1))
    printf '  %2d) %s\n' "$i" "$s"
  done
}

# Menu only — no DB check, no servers, no tests.
prompt_interactive_suite() {
  echo ""
  echo "OpenEnroll — what should we run?"
  echo "  Vitest (options 1 & 3) needs no servers. Cypress needs :${OE_TEST_FRONTEND_PORT} + :${OE_TEST_BACKEND_PORT}"
  echo "  (stable — no nodemon/HMR; dev :${OE_DEV_BACKEND_PORT}/:${OE_DEV_FRONTEND_PORT} keeps live reload)."
  echo "  Dev :${OE_DEV_BACKEND_PORT}/:${OE_DEV_FRONTEND_PORT} are never touched."
  echo ""
  echo "  1) All — backend Jest + Vitest + every Cypress spec"
  echo "  2) Enrollment — Cypress enrollment/ only (${#ENROLLMENT_SPECS[@]} specs)"
  echo "  3) Other — backend Jest + Vitest + Cypress (excluding enrollment/)"
  echo ""
  if [[ -t 0 ]]; then
    read -r -p "Select [1-3, default=1]: " OE_SUITE_CHOICE
  elif [[ -r /dev/tty ]]; then
    read -r -p "Select [1-3, default=1]: " OE_SUITE_CHOICE </dev/tty
  else
    echo "run-tests.sh: No terminal for prompts — use: ./run-tests.sh all | enrollment | other" >&2
    return 1
  fi
  OE_SUITE_CHOICE="${OE_SUITE_CHOICE:-1}"
  export OE_SUITE_CHOICE
  return 0
}

run_interactive_suite() {
  local choice="${1:-${OE_SUITE_CHOICE:-}}"
  case "$choice" in
    1) oe_begin_test_reports "all"; run_suite_all ;;
    2) oe_begin_test_reports "enrollment"; run_suite_enrollment ;;
    3) oe_begin_test_reports "other"; run_suite_other ;;
    *) echo "Invalid choice: $choice" >&2; return 1 ;;
  esac
}

run_interactive() {
  prompt_interactive_suite || return 1
  if ! oe_test_db_assert; then
    return 1
  fi
  run_interactive_suite "$OE_SUITE_CHOICE"
}

# shellcheck source=scripts/lib-test-db-guard.sh
source "$ROOT/scripts/lib-test-db-guard.sh" || { echo "run-tests.sh: missing scripts/lib-test-db-guard.sh" >&2; exit 1; }

# Automation only — never overrides the default wizard on plain ./run-tests.sh
if [[ -n "${RUN_TESTS:-}" && "${OE_NONINTERACTIVE:-}" == "1" ]]; then
  set -- "${RUN_TESTS}"
fi

# help only — do not require test DB
if [[ "${1:-}" == help || "${1:-}" == -h || "${1:-}" == --help ]]; then
  print_spec_menu
  echo ""
  echo "Usage: $0 [command [arg]]"
  echo "  (no args)            suite wizard (All / Enrollment / Other)"
  echo "  menu|interactive     same wizard (explicit)"
  echo "  all|full             same as wizard option 1"
  echo "  enrollment           Cypress enrollment/ only (servers auto-start)"
  echo "  other                Jest + Vitest + Cypress except enrollment/"
  echo "  backend|jest         backend npm test only"
  echo "  frontend|vitest      frontend Vitest only"
  echo "  cypress [N]          all Cypress, or enrollment index N"
  echo "  cypress-enrollment   enrollment Cypress (${#ENROLLMENT_SPECS[@]} isolated runs)"
  echo "  comprehensive|comp   logging stack (see setup-comprehensive-logging.sh)"
  echo "  start-servers        only boot test :3101/:5273"
  echo "  stop-servers         kill test :3101/:5273 (dev :3001/:5173 untouched)"
  echo "  OE_TEST_SERVERS_TERMINAL=1   optional Terminal.app windows (default: background + test-logs/)"
  echo "  OE_TEST_REUSE_SERVERS=1      skip restart if :3101/:5273 already healthy"
  echo "  OE_TEST_LEAVE_SERVERS=1      keep :3101/:5273 running after tests finish"
  echo "  OE_NONINTERACTIVE=1 RUN_TESTS=all   CI: skip wizard, run RUN_TESTS suite"
  echo "  After a run: test-reports/summary.txt (failures only — paste for debugging)"
  echo "  DB guard: DB_NAME in backend/.env must be an allowed test DB (e.g. allaboard-testing). OEO_ALLOW_NON_TEST_DB=1 to skip."
  exit 0
fi

if [[ "${1:-}" == start-servers ]]; then
  if ! oe_test_db_assert; then
    exit 1
  fi
  start_servers || exit 1
  exit 0
fi

if [[ "${1:-}" == stop-servers ]]; then
  export OE_TEST_SERVERS_STARTED=1
  oe_stop_test_servers
  exit 0
fi

# No args: always ask which suite (before DB guard). Servers start only when Cypress runs.
if [[ -z "${1:-}" ]]; then
  run_interactive || exit 1
  exit 0
fi

if ! oe_test_db_assert; then
  exit 1
fi

case "$1" in
  menu|interactive|wizard)
    prompt_interactive_suite || exit 1
    if ! oe_test_db_assert; then
      exit 1
    fi
    run_interactive_suite "$OE_SUITE_CHOICE" || exit 1
    exit 0
    ;;
  all|full)
    oe_begin_test_reports "all"
    run_suite_all || exit 1
    ;;
  enrollment|enrollment-only|cypress-enrollment|cypress-loop)
    oe_begin_test_reports "enrollment"
    run_suite_enrollment || exit 1
    ;;
  other|non-enrollment)
    oe_begin_test_reports "other"
    run_suite_other || exit 1
    ;;
  backend|jest)
    oe_begin_test_reports "backend"
    run_backend_tests || exit 1
    ;;
  frontend|vitest)
    oe_begin_test_reports "vitest"
    run_frontend_tests || exit 1
    ;;
  frontend-full|frontend-all)
    oe_begin_test_reports "frontend-full"
    run_frontend_tests || exit 1
    ensure_cypress_servers || exit 1
    run_cypress_all || exit 1
    ;;
  cypress|e2e)
    oe_begin_test_reports "cypress"
    ensure_cypress_servers || exit 1
    if [[ -n "${2:-}" ]]; then
      run_cypress_enrollment_index "$2" || exit 1
    else
      run_cypress_all || exit 1
    fi
    ;;
  comprehensive|comp)
    run_comprehensive || exit 1
    ;;
  *)
    echo "Unknown: $1 — try: $0 help" >&2
    exit 1
    ;;
esac
