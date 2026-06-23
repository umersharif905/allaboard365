#!/usr/bin/env bash
# Run unit tests for pending manual charge / invoice settlement behavior (no test DB).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Backend (Jest) ==="
cd "$ROOT/backend"
npx jest \
  householdManualCharge.pendingInvoice \
  payment-messages \
  payment-status \
  paymentAdminPatch \
  dimeService.decline \
  me.member.invoice-pay \
  groupBilling.manualCharge \
  dimeWebhookHandler.helpers \
  dimePaymentStatusAudit.runAudit \
  --no-cache

echo ""
echo "=== Frontend (Vitest) ==="
cd "$ROOT/frontend"
npx vitest run \
  src/constants/__tests__/paymentMessages.test.ts \
  src/pages/groups/__tests__/groupBillingDisplay.test.ts

echo ""
echo "=== oe_payment_manager (Jest) ==="
cd "$ROOT/oe_payment_manager"
npx jest --no-cache

echo ""
echo "All pending-charge tests passed."
