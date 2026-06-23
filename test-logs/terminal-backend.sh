#!/usr/bin/env bash
set -e
cd "/Users/jeremyfrancis/Desktop/FalconEye/OpenEnroll/backend"
export OE_TEST_BACKEND_PORT="3101"
export PORT="3101"
echo "=== OpenEnroll TEST backend :3101 (dev :3001 untouched) ==="
echo "Listen env: PORT=$PORT OE_TEST_BACKEND_PORT=$OE_TEST_BACKEND_PORT"
exec node app.js
echo ""
echo "=== Test backend exited (code $?) — window left open ==="
exec bash -l
