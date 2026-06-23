#!/usr/bin/env bash
# Start isolated test backend (:3101) + frontend (:5273). Sourced by run-tests.sh — do not run alone.
# Test backend: plain "node app.js" (no nodemon) — won't restart when you edit code.
# Dev :3001 (npm run dev / run-dev.sh): nodemon — keeps live reload for normal work.
# Test frontend: Vite with HMR disabled (vite.config.ts when OE_TEST_SERVERS=1).

oe_test_backend_healthy() {
  # App exposes GET /health (not /api/health)
  curl -sf "http://localhost:${OE_TEST_BACKEND_PORT}/health" >/dev/null 2>&1
}

oe_test_frontend_healthy() {
  curl -sf "http://localhost:${OE_TEST_FRONTEND_PORT}/" >/dev/null 2>&1
}

oe_port_busy() {
  lsof -ti:"$1" >/dev/null 2>&1
}

oe_clear_port() {
  local port="$1"
  if oe_port_busy "$port"; then
    echo "⚠️  Clearing stale process on :${port}..."
    lsof -ti:"$port" 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

# Graceful stop, then force — only test ports (never :3001/:5173).
oe_kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  [[ -z "$pids" ]] && return 0
  echo "$pids" | xargs kill -15 2>/dev/null || true
  sleep 1
  pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  [[ -z "$pids" ]] && return 0
  echo "$pids" | xargs kill -9 2>/dev/null || true
}

# Called on run-tests.sh exit when this session started the test stack.
oe_stop_test_servers() {
  if [[ "${OE_TEST_LEAVE_SERVERS:-}" == "1" ]]; then
    return 0
  fi
  if [[ "${OE_TEST_SERVERS_STARTED:-}" != "1" ]]; then
    return 0
  fi
  echo ""
  echo "🧹 Stopping test servers (:${OE_TEST_BACKEND_PORT}/:${OE_TEST_FRONTEND_PORT}) — dev :${OE_DEV_BACKEND_PORT}/:${OE_DEV_FRONTEND_PORT} unchanged"
  oe_kill_port "$OE_TEST_BACKEND_PORT"
  oe_kill_port "$OE_TEST_FRONTEND_PORT"
  export OE_TEST_SERVERS_STARTED=0
}

oe_wait_for_backend() {
  local i
  echo "⏳ Waiting for http://localhost:${OE_TEST_BACKEND_PORT}/health (up to 120s) ..."
  for i in $(seq 1 120); do
    if oe_test_backend_healthy; then
      echo "✅ Test backend up (:${OE_TEST_BACKEND_PORT})"
      return 0
    fi
    if (( i % 15 == 0 )); then
      echo "   …still waiting (${i}s) — see test-logs/backend-test.log"
    fi
    sleep 1
  done
  echo "❌ Test backend did not become healthy on :${OE_TEST_BACKEND_PORT}" >&2
  echo "   Check test-logs/backend-test.log (tail -30) or test-logs/terminal-backend.sh" >&2
  return 1
}

oe_wait_for_frontend() {
  local i
  echo "⏳ Waiting for http://localhost:${OE_TEST_FRONTEND_PORT} ..."
  for i in $(seq 1 60); do
    if oe_test_frontend_healthy; then
      echo "✅ Test frontend up (:${OE_TEST_FRONTEND_PORT}, Cypress ${CYPRESS_BASE_URL})"
      return 0
    fi
    sleep 1
  done
  echo "❌ Test frontend did not become healthy on :${OE_TEST_FRONTEND_PORT}" >&2
  echo "   Check test-logs/terminal-frontend.sh or frontend-test.log" >&2
  return 1
}

oe_open_mac_terminal() {
  local label="$1"
  local launcher="$2"
  if ! command -v osascript >/dev/null 2>&1; then
    return 1
  fi
  # AppleScript double-quoted strings treat \U in /Users as an escape (breaks path → "a/Users/...").
  # Run via bash -l with a single-quoted POSIX path instead of do script "/path" directly.
  local launcher_sq="${launcher//\'/\'\\\'\'}"
  if ! osascript >/dev/null 2>&1 <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "bash -l '${launcher_sq}'"
end tell
APPLESCRIPT
  then
    echo "⚠️  Could not open Terminal for test ${label}" >&2
    return 1
  fi
  echo "🪟 Opened Terminal — test ${label}"
  return 0
}

oe_write_terminal_launcher() {
  local label="$1"
  local body="$2"
  local launcher="${ROOT}/test-logs/terminal-${label}.sh"
  mkdir -p "${ROOT}/test-logs"
  cat > "$launcher" <<LAUNCH
#!/usr/bin/env bash
set -e
$body
echo ""
echo "=== Test ${label} exited (code \$?) — window left open ==="
exec bash -l
LAUNCH
  chmod +x "$launcher"
  printf '%s' "$launcher"
}

oe_start_backend_inline() {
  oe_clear_port "$OE_TEST_BACKEND_PORT"
  echo "🔄 Starting test backend in background (:${OE_TEST_BACKEND_PORT})..."
  (
    cd "${ROOT}/backend" || exit 1
    OE_TEST_BACKEND_PORT="$OE_TEST_BACKEND_PORT" PORT="$OE_TEST_BACKEND_PORT" \
      nohup node app.js >> "${ROOT}/test-logs/backend-test.log" 2>&1 &
    echo "   log: ${ROOT}/test-logs/backend-test.log"
  )
  oe_wait_for_backend
}

oe_start_frontend_inline() {
  oe_clear_port "$OE_TEST_FRONTEND_PORT"
  echo "🔄 Starting test frontend in background (:${OE_TEST_FRONTEND_PORT})..."
  (
    cd "${ROOT}/frontend" &&
      OE_TEST_SERVERS=1 \
      OE_TEST_BACKEND_PORT="$OE_TEST_BACKEND_PORT" \
      OE_TEST_FRONTEND_PORT="$OE_TEST_FRONTEND_PORT" \
      nohup npm run dev:test >> "${ROOT}/test-logs/frontend-test.log" 2>&1 &
  )
  oe_wait_for_frontend
}

oe_start_backend_terminal() {
  oe_clear_port "$OE_TEST_BACKEND_PORT"
  local launcher
  launcher="$(oe_write_terminal_launcher backend "cd \"${ROOT}/backend\"
export OE_TEST_BACKEND_PORT=\"${OE_TEST_BACKEND_PORT}\"
export PORT=\"${OE_TEST_BACKEND_PORT}\"
echo \"=== OpenEnroll TEST backend :${OE_TEST_BACKEND_PORT} (dev :${OE_DEV_BACKEND_PORT} untouched) ===\"
echo \"Listen env: PORT=\$PORT OE_TEST_BACKEND_PORT=\$OE_TEST_BACKEND_PORT (no nodemon)\"
exec npm run start:test")"
  oe_open_mac_terminal backend "$launcher" || return 1
  oe_wait_for_backend
}

oe_start_frontend_terminal() {
  oe_clear_port "$OE_TEST_FRONTEND_PORT"
  local launcher
  launcher="$(oe_write_terminal_launcher frontend "cd \"${ROOT}/frontend\"
export OE_TEST_SERVERS=1
export OE_TEST_BACKEND_PORT=\"${OE_TEST_BACKEND_PORT}\"
export OE_TEST_FRONTEND_PORT=\"${OE_TEST_FRONTEND_PORT}\"
echo \"=== OpenEnroll TEST frontend :${OE_TEST_FRONTEND_PORT} → API :${OE_TEST_BACKEND_PORT} ===\"
exec npm run dev:test")"
  oe_open_mac_terminal frontend "$launcher" || return 1
  oe_wait_for_frontend
}

# Main entry when sourced: start_servers
start_servers() {
  mkdir -p "${ROOT}/test-logs"
  export_cypress_test_env

  echo "🔄 Test stack (dev :${OE_DEV_BACKEND_PORT}/:${OE_DEV_FRONTEND_PORT} left alone):"
  echo "   backend :${OE_TEST_BACKEND_PORT}  frontend :${OE_TEST_FRONTEND_PORT}"

  # Default: background servers + logs in test-logs/ (reliable). Set OE_TEST_SERVERS_TERMINAL=1 for Terminal.app windows.
  local use_terminal=0
  if [[ "${OE_TEST_SERVERS_TERMINAL:-}" == "1" ]] && [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
    use_terminal=1
  fi

  # Fresh test stack by default (stale Vite on :5273 may still proxy to dev :3001).
  local reuse=0
  if [[ "${OE_TEST_REUSE_SERVERS:-}" == "1" ]] && oe_test_backend_healthy && oe_test_frontend_healthy; then
    reuse=1
    echo "✅ Reusing test servers (:${OE_TEST_BACKEND_PORT}/:${OE_TEST_FRONTEND_PORT}) — OE_TEST_REUSE_SERVERS=1"
  fi

  if (( ! reuse )); then
    if (( use_terminal )); then
      oe_start_backend_terminal || {
        echo "⚠️  Terminal launch failed — starting test backend in background instead..." >&2
        oe_start_backend_inline || return 1
      }
      oe_start_frontend_terminal || {
        echo "⚠️  Terminal launch failed — starting test frontend in background instead..." >&2
        oe_start_frontend_inline || return 1
      }
    else
      oe_start_backend_inline || return 1
      oe_start_frontend_inline || return 1
    fi
    export OE_TEST_SERVERS_STARTED=1
  elif [[ "${OE_TEST_REUSE_SERVERS:-}" == "1" ]]; then
    export OE_TEST_SERVERS_STARTED=0
  fi

  export_cypress_test_env
  echo "   Cypress will use ${CYPRESS_BASE_URL} → API ${CYPRESS_API_BASE}"
  return 0
}
