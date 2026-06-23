#!/usr/bin/env bash
# Same as: ./run-tests.sh comprehensive
R="$(cd "$(dirname "$0")" && pwd)"
exec "$R/run-tests.sh" comprehensive
