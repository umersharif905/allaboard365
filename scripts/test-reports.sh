#!/usr/bin/env bash
# Shared test report paths for run-tests.sh and Cypress after:run hook.
OE_TEST_REPORT_DIR="${OE_TEST_REPORT_DIR:-$ROOT/test-reports}"

oe_begin_test_reports() {
  local suite="${1:-run}"
  export OE_TEST_SUITE="$suite"
  export OE_TEST_REPORT_DIR="${OE_TEST_REPORT_DIR:-$ROOT/test-reports}"
  export OE_TEST_REPORTS_ACTIVE=1
  mkdir -p "$OE_TEST_REPORT_DIR"
  trap oe_finish_test_reports EXIT
  : > "$OE_TEST_REPORT_DIR/cypress-runs.jsonl"
  rm -f "$OE_TEST_REPORT_DIR/jest.json" "$OE_TEST_REPORT_DIR/vitest.json" \
    "$OE_TEST_REPORT_DIR/summary.txt" "$OE_TEST_REPORT_DIR/summary.md"
  printf '%s\n' "{\"suite\":\"$suite\",\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$OE_TEST_REPORT_DIR/run-meta.json"
}

oe_finish_test_reports() {
  if [[ "${OE_TEST_REPORTS_ACTIVE:-}" != "1" ]]; then
    return 0
  fi
  export OE_TEST_REPORTS_ACTIVE=0
  trap - EXIT
  if command -v node >/dev/null 2>&1; then
    node "$ROOT/scripts/summarize-test-reports.mjs" 2>/dev/null || true
  fi
  if [[ -f "$OE_TEST_REPORT_DIR/summary.txt" ]]; then
    echo ""
    echo "────────────────────────────────────────────────────────"
    echo "📋 Test report (paste this instead of full logs):"
    echo "   $OE_TEST_REPORT_DIR/summary.txt"
    echo "────────────────────────────────────────────────────────"
    cat "$OE_TEST_REPORT_DIR/summary.txt"
    echo "────────────────────────────────────────────────────────"
  fi
  if declare -f oe_stop_test_servers >/dev/null 2>&1; then
    oe_stop_test_servers
  fi
}
