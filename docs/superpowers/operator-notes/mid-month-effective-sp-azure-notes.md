# Mid-Month Effective Date — Operator Notes Index

This is the entry point for everything an operator (DBA, DevOps, release manager) needs to do to ship mid-month effective date support. All tasks here are OUT-OF-REPO work — they touch Azure SQL stored procedures or Azure Functions that live outside this codebase.

## Order of operations

1. **Dev deploy of backend PR** must land first (creates the `AllowMidMonthEffective` column via `sql-changes/allaboard365/2026-04-15-add-groups-allow-mid-month-effective.sql`).
2. **DBA runbook:** [mid-month-effective-dba-runbook.md](./mid-month-effective-dba-runbook.md) — update `oe.sp_CalculateGroupTotalPremium` and `oe.sp_GenerateGroupInvoices` to accept cohort context.
3. **DevOps runbook:** [mid-month-effective-devops-runbook.md](./mid-month-effective-devops-runbook.md) — deploy updated Azure Functions (`MonthlyPaymentScheduler`, `DimeRecurringPaymentScheduler`, `DimeWebhookHandler`).
4. **E2E verification:** [mid-month-effective-e2e-verification.md](./mid-month-effective-e2e-verification.md) — manual test script on dev before prod.
5. **Prod deploy** of backend PR + SP changes + function changes, in that order.

## Who does what

| Task | Role | Command-line doable? |
|---|---|---|
| Deploy SQL migration | Backend dev | Yes (via `node scripts/migrate.js`) |
| Update stored procs | DBA | Yes (Node script in DBA runbook) |
| Update Azure Functions | DevOps | Partial (CRON via Azure CLI; code deploy via `func azure functionapp publish`) |
| Flip `AllowMidMonthEffective` per group | TenantAdmin via UI | N/A (UI toggle in GroupSettingsTab) |
| E2E verification | QA / backend dev | Yes |

## Rollback

If any step fails in prod:

1. `UPDATE oe.Groups SET AllowMidMonthEffective = 0` — disables the feature immediately without code redeploy.
2. Any 15th-cohort enrollments already created stay enrolled. Their invoices will continue to generate on the 15th cycle until DBA reverts the SP changes.
3. To fully revert: restore SP bodies from `/tmp/oe.sp_*.backup.sql` (created during DBA runbook Step 0) and redeploy previous Azure Function versions.
