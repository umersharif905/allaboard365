# Case Finances + SR UA banner — design

Date: 2026-06-01
Branch: `fix/backoffice/billing`

## Goal

1. Give **Cases** their own editable **Finances** tab (Bills + Ledger), mirroring
   the Share Request Finances tab but with a Case-specific (non-UA) ledger.
2. Surface the member-level **"2 unshared amounts paid in full / 12 months"**
   coverage banner on the **Share Request** Finances tab (it already exists on
   the Member Finances tab).

The **Member** Finances tab (`MemberFinancesTab`) is already built and wired —
no work there.

## Decisions (from brainstorming)

- **Duplicate, don't share.** New Case-specific frontend components copied from
  the SR versions. Reason: the SR finance code just shipped under an open PR
  (touching it = regression risk), and the two ledgers genuinely diverge.
- **Case ledger transaction types** = SR set **minus UA**:
  `Payment to Provider`, `Member Payment`, `Reimbursement`, `Discount`,
  `Financial Aid`. No `UA Payment` / `UA Reduction`. No UA-coverage banner on
  Cases.
- **Cards** (Case Finances): `Billed · Saved · Member paid · Reimbursed · Balance`
  — identical to SR, computed by reusing the existing `buildSummary()` (the UA
  buckets just compute to zero).

## Data model — new migration `sql-changes/2026-06-01-case-finances.sql`

DDL only; written, **not** run. Apply manually.

### `oe.CaseBills`
Keyed by `CaseId` + `VendorId`. FK → `oe.Cases`, `oe.Providers`.
Columns: `BillId` (PK), `CaseId`, `VendorId`, `ProviderId`, `BillNumber`,
`BillType` (`Bill`/`Estimate`), `BillDate`, `DateOfService`, `Description`,
`BilledAmount`, `AllowedAmount`, `PaidAmount`, `Balance`, `Notes`, `IsActive`,
`CreatedDate`, `CreatedBy`, `ModifiedDate`, `ModifiedBy`.
*(Drops SR-only `UAAmount`/`ShareAmount`/`CPTCodes`/`DiagnosisCodes`.)*

### `oe.CaseTransactions`
Keyed by `CaseId` + `VendorId`. FK → `oe.CaseBills`, `oe.Providers`.
Columns: `TransactionId` (PK), `CaseId`, `VendorId`, `BillId`, `ProviderId`,
`TransactionType`, `PaymentType`, `TransactionStatus` (`Pending`/`Cleared`/`Cancelled`),
`Amount`, `TransactionDate`, `ReferenceNumber`, `Description`, `Notes`,
`CreatedDate`, `CreatedBy`, `ModifiedDate`, `ModifiedBy`.

## Backend

- **`services/caseFinanceService.js`** (new) — `getBills/createBill/updateBill/
  deleteBill` + `getTransactions/createTransaction/updateTransaction/
  deleteTransaction`, all `CaseId`-keyed and vendor-scoped (ownership via
  `caseService.getCaseById`). Each mutation logs a diffed audit entry to
  `oe.CaseNotes` (noteType `finance`) so it appears in the Case History tab.
- **`services/financeSummaryService.js`** — add `getCaseSummary(caseId, vendorId)`
  that fetches CaseBills/CaseTransactions and reuses `buildSummary`. Extend
  `getShareRequestSummary` to also attach the owning member's `uaAnalysis`
  (reusing `getMemberFinanceSummary`'s trailing-12-month logic) so the SR tab
  can render the coverage banner.
- **`services/historyTimelineService.js`** — add `finance: 'system'` to
  `CASE_NOTE_CATEGORY`.
- **`routes/me/vendor/cases.js`** — new routes:
  `GET /:id/finance-summary`, `GET|POST /:id/bills`,
  `PUT|DELETE /:id/bills/:billId`, `GET|POST /:id/transactions`,
  `PUT|DELETE /:id/transactions/:transactionId`.

## Frontend

New (copied from SR, pointed at case endpoints; no SR files touched):
- `components/vendor/cases/tabs/CaseFinancesTab.tsx` — 5 cards + Bills/Ledger
  sub-tabs. **No UA banner.**
- `components/vendor/cases/tabs/CaseBillsTab.tsx`
- `components/vendor/cases/tabs/CaseLedgerTab.tsx` — 5 ledger types only;
  keeps "discount by new total"; drops UA-reduction stat.
- `components/vendor/cases/CaseProviderPicker.tsx` — links via `/cases/:id/providers`.
- `types/case.types.ts` — add `CaseBill`, `CaseTransaction`, finance types +
  `CASE_TRANSACTION_TYPES` constant.
- `components/vendor/cases/CaseWorkspaceTabs.tsx` — add `finances` tab (Wallet
  icon) after Providers.

Shared banner extraction (SR + Member):
- `components/vendor/shared/UaCoverageBanner.tsx` (new) — lifted from
  `MemberFinancesTab`; rendered in `MemberFinancesTab` and the SR `FinancesTab`
  (between the 5 cards and the sub-tabs). SR `FinancesTab` reads `uaAnalysis`
  from the extended finance-summary response.

## Out of scope / non-actions

- No DB writes run by the assistant; migration file only.
- No push; commits only when asked.
