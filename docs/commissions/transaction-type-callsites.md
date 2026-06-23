# `oe.Commissions.TransactionType` Filter Callsite Audit

Phase 0.5 deliverable for the Credits and Clawback Ledger plan. Every place that
filters `oe.Commissions` by `TransactionType` must be reviewed against the
expanded type set:

- `'Advance'` (existing) — paid pre-cycle advance to agent
- `'Commission'` (existing) — earned commission row, can be positive or negative (override netting)
- `'Refund'` (NEW, Phase 2) — full-refund clawback row, negative `Amount`, `Status='Pending'` for next-cycle netting
- `'Chargeback'` (NEW, Phase 2) — partial-refund clawback row, negative `Amount`, `Status='Pending'`

The new `Refund`/`Chargeback` rows are produced by `commissionService.advances.clawBackForRefund`
and must be honored by NACHA generation/marking, audit reporting, and any UI that
sums commission balances.

## Action key

- **EXTEND** — add `'Refund','Chargeback'` to the IN clause when Phase 2 ships
- **NO CHANGE** — filter is intentionally narrow (e.g. only original advance amounts)
- **REVISIT** — needs review when the upstream consumer changes

## Backend filters

| Location | Current filter | Action |
|---|---|---|
| [backend/services/NACHAService.commissions.js:94](../../backend/services/NACHAService.commissions.js) `getEligibleCommissions` | `IN ('Advance','Commission')` | **EXTEND** to `('Advance','Commission','Refund','Chargeback')`. Without this, clawback rows never get netted into NACHA cycles. (Phase 6a) |
| [backend/services/NACHAService.js:880](../../backend/services/NACHAService.js) | `IN ('Advance','Commission')` | **EXTEND**. Same NACHA path. (Phase 6a) |
| [backend/services/NACHAService.js:1365](../../backend/services/NACHAService.js) | `IN ('Advance','Commission')` | **EXTEND**. Per-payment commission sum. (Phase 6a) |
| [backend/services/NACHAService.js:1377](../../backend/services/NACHAService.js) inline subquery | `IN ('Advance','Commission')` | **EXTEND**. Per-entity payment listing. (Phase 6a) |
| [backend/services/NACHAService.js:1382](../../backend/services/NACHAService.js) inline join | `IN ('Advance','Commission')` | **EXTEND**. Same listing. (Phase 6a) |
| [backend/services/NACHAService.js:1727](../../backend/services/NACHAService.js) | `IN ('Advance','Commission')` | **EXTEND**. (Phase 6a) |
| [backend/services/NACHAService.js:4635](../../backend/services/NACHAService.js) `markCommissionsAsPaid` | `IN ('Advance','Commission')` | **EXTEND** + set `AppliedToNACHAId`. (Phase 6b) |
| [backend/services/NACHAService.js:4834](../../backend/services/NACHAService.js) `markNACHAasSent` bulk | `IN ('Advance','Commission')` | **EXTEND** + set `AppliedToNACHAId`. (Phase 6b) |
| [backend/services/NACHAService.js:4988](../../backend/services/NACHAService.js) `markNACHAasNotSent` symmetric | `IN ('Advance','Commission')` | **EXTEND** + clear `AppliedToNACHAId`. (Phase 6b) |
| [backend/services/NACHAService_check.js](../../backend/services/NACHAService_check.js) various | `IN ('Advance','Commission')` | **REVISIT** — appears to be a debugging/health-check copy. If still active in prod, mirror the NACHAService.js changes. |
| [backend/services/NACHAService_temp.js:64](../../backend/services/NACHAService_temp.js) | `IN ('Advance','Commission')` | **REVISIT** — `_temp` suggests dead code; confirm and delete during Phase 6. |
| [backend/routes/accounting/nacha.js:1980](../../backend/routes/accounting/nacha.js) | `IN (${transactionTypes})` (parameterized) | **EXTEND** caller's `transactionTypes` value. |
| [backend/routes/accounting/commission-breakdown.js:154,333,414,546](../../backend/routes/accounting/commission-breakdown.js) | `IN ('Advance','Commission')` | **EXTEND**. Frontend modal + accounting reports must include clawback rows so net commission balances are accurate. |
| [backend/routes/commissions.js:4232](../../backend/routes/commissions.js) | `= 'Commission'` | **REVISIT** — narrow filter. If this is the agent dashboard "earned" row count, leave as-is (clawbacks are debits, not earnings). Otherwise extend. |
| [backend/services/commissionService.advances.js:1440](../../backend/services/commissionService.advances.js) | `= 'Advance'` | **NO CHANGE**. Specifically queries advance rows for advance-balance reconciliation; clawbacks for advances are a different code path. |

## Negative-amount filters (related but separate)

| Location | Current filter | Action |
|---|---|---|
| [backend/routes/accounting/nacha.js](../../backend/routes/accounting/nacha.js) line-items | `npd.Amount > 0` | **CHANGE** to `npd.Amount != 0` so debit lines from clawback netting are visible. (Phase 6d) |

## Refund/Reversal payment filters (already include refunds — informational)

These already include refund-type rows; keep as-is unless their semantics shift:

- [backend/services/vendorExportService.js:5864,5885](../../backend/services/vendorExportService.js) — `IN ('Refund','Reversal')` on `oe.Payments`
- [backend/services/shareRequestService.js:1978,1984](../../backend/services/shareRequestService.js) — domain-specific (UA Payment/Reduction, Discount-*) on the share-request transactions table; unrelated.

## How to use this list during Phase 6

When Phase 6a/6b lands:
1. Walk every **EXTEND** row above and apply the filter change.
2. For each **REVISIT** row, decide keep / extend / delete and update this doc.
3. After Phase 6 ships, this file becomes the regression checklist for any future
   filter changes — never widen `TransactionType` semantics without re-auditing it.
