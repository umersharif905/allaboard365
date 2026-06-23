# Billing Rework — Work Log (fix/backoffice/billing)

Branch: `fix/backoffice/billing` (off `staging` @ 275c7af3)
Started: 2026-05-30 (overnight autonomous session)

## Session note
Tool/shell output in this session has SEVERE latency (outputs arrive batched,
sometimes minutes later). Early in the session this looked like a broken
environment / empty files — that was a false alarm. Verified the tree is
intact (frontend/package.json, backend/app.js, etc. all have real content)
and git works. `.git` is a linked-worktree file, not a dir (normal).

## Plan (high level)
See BLOCKERS.md for assumptions. Tasks:
1. Remove FAP tab → Finances tab has only **Bills** + **Ledger**.
2. Add Bill: unblock button when member has no provider; provider dropdown =
   existing member providers + NPI lookup to add new.
3. Ledger transactions: add **Benji card** payment method.
4. Collapse transaction types to a single **Discount** (+ keep core types);
   add **Financial Aid** type; fold negotiation into Discount.
5. Rework the 5 top summary cards into clearer care-team metrics.
6. 12-month "two unshared-amounts-paid-in-full" check per member.
7. Make bills/ledger data query-friendly for AI + future reports.
8. Member detail page: add a Bills/Finances summary section.

## Activity
- [2026-05-30] Stashed package-lock churn, checked out staging, pulled latest.
- [2026-05-30] Created branch fix/backoffice/billing.
- [2026-05-30] Set up docs/billing-rework/{LOG,BLOCKERS}.md; began code exploration.

## Completed (2026-05-30)
All eight items implemented. Verified: frontend `tsc --noEmit` clean for every
changed file (repo has pre-existing unrelated tsc noise); backend `node --check`
clean; `buildSummary` math + category map validated via node; CreateProviderModal
is z-40 (stacks above the z-30 bill modal). No existing tests import the changed
modules, so no regression (and per workflow prefs I did not run the full suite).

### Backend
- NEW `services/financeCategory.js` — normalizes old+new transaction-type strings
  into stable categories (+ `sqlInList` for safe SQL IN-clauses).
- NEW `services/financeSummaryService.js` — `getShareRequestSummary` +
  `getMemberFinanceSummary` (computed from source tables) incl. the trailing-12mo
  "two UA paid in full → fullyCovered" analysis. `resolveIncidentUA` is the single
  knob for the UA source of truth.
- `services/shareRequestService.js` `getDashboardStats` — discounts now use the
  category IN-list (legacy + new), added `TotalFinancialAid`/`totalSaved`.
- `routes/me/vendor/share-requests.js` — `GET /:id/finance-summary`.
- `routes/me/vendor/members.js` — `GET /:id/finance-summary`.

### Frontend
- `types/shareRequest.types.ts` — TransactionType reduced to 7 (legacy kept for
  display only); PaymentType + 'Benji Card'; new FinanceSummary / MemberFinanceSummary types.
- `FinancesTab.tsx` — FAP tab removed (Bills + Ledger only); 5 reworked cards
  (Billed / Saved / Member paid / Reimbursed / Balance) from finance-summary;
  cards refresh when child tabs mutate data.
- `BillsTab.tsx` — Add Bill no longer disabled when no provider; modal provider
  field = existing-providers dropdown + inline NPI-powered "Add provider"
  (reuses CreateProviderModal → create → link → auto-select).
- `LedgerTab.tsx` — Discounts stat spans new+legacy; added Financial aid stat;
  onChanged callback.
- `members/MemberWorkspaceTabs.tsx` + `pages/vendor/VendorMembersWorkspace.tsx` —
  new gated **Finances** tab.
- NEW `members/tabs/MemberFinancesTab.tsx` — cards + UA coverage banner + two
  Bills/Ledger summary columns + per-SR table.

### NOT done / deferred (see BLOCKERS.md)
- FAP backend routes/service/table + standalone ShareRequestFAPTab.tsx left
  dormant (no destructive deletes without confirmation).
- No reporting dashboard built (out of scope); data is shaped for it.
- No live DB validation (no ai_scripts/.env).
