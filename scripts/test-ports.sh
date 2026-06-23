# Shared dev vs test ports — source from run-tests.sh (do not kill dev ports).
# Dev (vibe coding):  backend :3001  frontend :5173
# Test (run-tests):  backend :3101  frontend :5273

export OE_DEV_BACKEND_PORT="${OE_DEV_BACKEND_PORT:-3001}"
export OE_DEV_FRONTEND_PORT="${OE_DEV_FRONTEND_PORT:-5173}"
export OE_TEST_BACKEND_PORT="${OE_TEST_BACKEND_PORT:-3101}"
export OE_TEST_FRONTEND_PORT="${OE_TEST_FRONTEND_PORT:-5273}"

export_cypress_test_env() {
  export CYPRESS_BASE_URL="http://localhost:${OE_TEST_FRONTEND_PORT}"
  export CYPRESS_API_BASE="http://localhost:${OE_TEST_BACKEND_PORT}"
  export OE_TEST_SERVERS=1
}

# Run Cypress with test ports forced (CLI + env — do not rely on dev :5173/:3001).
oe_run_cypress() {
  export_cypress_test_env
  echo "🎯 Cypress → ${CYPRESS_BASE_URL} (API ${CYPRESS_API_BASE}) — not dev :${OE_DEV_FRONTEND_PORT}/:${OE_DEV_BACKEND_PORT}"
  (
    cd "${ROOT}/frontend" || exit 1
    env \
      CYPRESS_BASE_URL="$CYPRESS_BASE_URL" \
      CYPRESS_API_BASE="$CYPRESS_API_BASE" \
      OE_TEST_SERVERS=1 \
      npx cypress run "$@" \
        --browser chrome \
        --config "baseUrl=${CYPRESS_BASE_URL}" \
        --env "API_BASE=${CYPRESS_API_BASE},FRONTEND_BASE=${CYPRESS_BASE_URL}"
  )
}
