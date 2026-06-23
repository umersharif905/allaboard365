#!/usr/bin/env bash
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../oe_payment_manager/test_scripts" && pwd)/webhook-test.sh" "$@"
