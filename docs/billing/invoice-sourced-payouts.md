# Invoice-Sourced Payouts (Reader Cutover + Funding Gate)

This document describes the shift of OpenEnroll commission, vendor, and override
payout calculations from `oe.Payments` to `oe.Invoices`, including the funding
gate that delays payouts until the linked invoice is fully `Paid`.

## Canonical source of truth

`oe.Invoices` is the **canonical** source for payout breakdown columns:

- **Scalar columns**: `NetRate`, `OverrideRate`, `Commission`, `SystemFees`,
  `ProcessingFeeAmount`, `SetupFee`
- **JSON columns**: `ProductCommissions`, `ProductVendorAmounts`,
  `ProductOwnerAmounts`

`oe.Payments` retains these same columns for backward compatibility and as a
fallback during the transition window. Every reader that drives a payout uses
`COALESCE(inv.X, p.X)` so that:

- Linked payments (non-NULL `p.InvoiceId`) read the invoice's values.
- Unlinked legacy payments (`p.InvoiceId IS NULL`) read the payment's values.

When the dual-write and the validation harness confirm zero drift over a clean
window (~30 days), the Payments-side fallback will be removed in a follow-up.

## Funding gate

`NACHAService.getUnpaidPayments` enforces a strict funding gate on commission,
vendor, and override payouts. A payment becomes payout-eligible only when:

```sql
p.InvoiceId IS NULL                        -- grandfathered historical data
OR inv.Status = N'Paid'                    -- invoice fully funded
```

Payments linked to `Unpaid`, `Partial`, or `Overdue` invoices are **held** and
will become eligible automatically when the invoice transitions to `Paid`.

The held-payment count is emitted as a debug log in each NACHA run so operators
can monitor the gate without changing any UI.

## COALESCE fallback window

Every reader with a direct dependency on the breakdown columns has been updated
to a pattern of the form:

```sql
SELECT
    COALESCE(inv.Commission,           p.Commission)           AS Commission,
    COALESCE(inv.NetRate,              p.NetRate)              AS NetRate,
    COALESCE(inv.OverrideRate,         p.OverrideRate)         AS OverrideRate,
    COALESCE(inv.SystemFees,           p.SystemFees)           AS SystemFees,
    COALESCE(inv.ProductCommissions,   p.ProductCommissions)   AS ProductCommissions,
    COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) AS ProductVendorAmounts,
    COALESCE(inv.ProductOwnerAmounts,  p.ProductOwnerAmounts)  AS ProductOwnerAmounts
FROM oe.Payments p
LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ...
```

Readers updated:

- `backend/services/NACHAService.js` – main payout query and product assembly
- `backend/services/NACHAService.commissions.js` – eligible commissions query
- `backend/services/commissionService.advances.js` – payout chain and breakdown preview
- `backend/services/paymentAudit.service.js` – `getPaymentForTenant` returns
  COALESCE values for audit comparison
- `backend/routes/accounting/nacha.js` – dashboard preview, ASA, vendor,
  product-owner, system-fees, recipient-detail
- `backend/routes/accounting/vendor-breakdown.js` – vendor list, breakdown,
  breakdown export, payment detail
- `backend/routes/commissions.js` – missing/skipped-invoices/preview/generate queries

Readers **explicitly not changed** (by design):

- `backend/services/productOverridePayouts.service.js` – computes overrides
  fresh from `oe.ProductOverrides`; gated upstream by NACHA filter
- `backend/services/vendorExportService.js` – reads aggregated amounts via
  `NACHAPaymentDetail`; inherits correctness from `NACHAService.js`
- `backend/services/billingAuditRun/Summary/Drilldown.service.js` – these
  audit the stored payment breakdowns for data-integrity problems; they
  intentionally read raw `p.X`
- `backend/routes/me/{agent,sysadmin,tenant-admin}/billing.js`,
  `backend/routes/invoices.js` – read `p.ProcessingFeeAmount` for statement
  display only; do not drive payouts

## Fulfillment date (`PaymentReceivedDate`) and “payment received” NACHA windows

For tenant settings **Pay when payment is received** (`paymentReceived`), NACHA eligibility for **linked**
invoices is bucketed by a **fulfillment anchor**, not raw processor `PaymentDate` alone:

1. `oe.Invoices.PaymentReceivedDate` when set (canonical “invoice fully funded” for `Status = Paid`).
2. Else `MAX(oe.Payments.PaymentDate)` over paid-success statuses for that `InvoiceId`.
3. Else `CAST(oe.Invoices.ModifiedDate AS DATE)` as a weak last resort (e.g. credit-only settlement).

**Unlinked** payments still use `p.PaymentDate`.

Credit-funded **Paid** invoices (no successful `oe.Payments` row) use `COALESCE(PaymentReceivedDate, ModifiedDate)`
for the same basis.

### Agent commission NACHA (separate rule)

Agent commission files use the invoice **`DueDate`** (with fallbacks) for the selected date range, and require
the linked invoice to be **`Paid`** for payment-backed rows—so commission timing is **not** the same
month bucket as vendor “payment received” unless ops align ranges accordingly.


`backend/services/invoiceService.js` now matches prepayments to their target
invoices when:

- Payment date is within `PREPAY_WINDOW_DAYS = 45` days **before**
  `BillingPeriodStart`
- Same `HouseholdId`
- Invoice `Status IN ('Unpaid', 'Partial', 'Overdue')`
- Payment `InvoiceId IS NULL`
- `ABS(p.Amount - (inv.TotalAmount - inv.PaidAmount)) <= PREPAY_AMOUNT_TOLERANCE`
  (`0.50`)
- Exactly one candidate invoice matches (unambiguous)

This branch is guarded by `SELF_HEAL_PREPAY_ENABLED=true`; flipping the flag
off is a safe rollback.

`tryLinkPaymentToInvoice` now prefers a prepay-matched invoice over creating a
new invoice for the payment date, avoiding spurious same-month invoices when
prepayments land before the billing period starts.

## Validation harness

`GET /api/admin/payout-source-comparison?days=30` (SysAdmin only) returns:

- **Coverage summary**: total payments, linked vs unlinked, invoice status
  breakdown for the window.
- **Per-payment deltas**: every scalar or JSON column where
  `oe.Payments.X <> oe.Invoices.X` (scalars outside a $0.01 tolerance; JSON
  compared as string after `ISNULL`).

The admin UI lives at `/admin/payout-source-comparison` ("Payout source audit"
in the admin sidebar). Zero deltas is the green-light signal for the next
phase (dropping the Payments-side fallback).

## One-time SQL scripts

- `sql-changes/2026-04-16-backfill-inv-202604-1163.sql` – fills breakdown
  columns on the single straggler invoice from the precondition sweep.
- `sql-changes/2026-04-16-link-prepay-orphans.sql` – idempotent script that
  links orphan prepayments to their correct invoices and refreshes invoice
  `PaidAmount` / `Status`.
- `sql-changes/2026-05-08-backfill-invoice-payment-received-date.sql` – idempotent
  backfill for `oe.Invoices.PaymentReceivedDate` on `Paid` rows where it was never set.

Both scripts include preview blocks and no-op safely on re-run.

## Rollback strategy

- **Funding gate**: revert the single WHERE-clause change in
  `NACHAService.getUnpaidPayments`. No data state to undo.
- **Reader switch**: `COALESCE(inv.X, p.X)` is semantically equivalent to
  `p.X` whenever `inv.X IS NULL` or `inv.X = p.X`. Because dual-write to
  `oe.Payments` is preserved, reverting the reader cutover is a pure code
  revert – no data migration.
- **Self-heal widening**: set `SELF_HEAL_PREPAY_ENABLED=false`. New
  prepayments will again fall through to the previous (narrower) behavior.
  Existing links remain, which is intended.

## Out of scope (future work)

- Removing the `COALESCE(inv.X, p.X)` fallback once the harness shows a
  clean window.
- Stopping writes to `oe.Payments` breakdown columns.
- `oe.AccountCredits` / Overpaid / chargeback / clawback logic.
- Switching dashboard/statement UI reads (`routes/me/*/billing.js`) to
  invoice-sourced values – optional polish, not a payout-correctness concern.
