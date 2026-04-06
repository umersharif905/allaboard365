# oe_payment_manager local test scripts

Scripts for exercising the **Dime webhook** (`DimeWebhookHandler`) against a **non-production** database (e.g. `allaboard-testing`).

| File | Purpose |
|------|--------|
| `webhook-test.sh` | `curl` mock DIME payloads to local `func start` |
| `resolve-defaults.cjs` | Loads latest test IDs + labels from `allaboard-testing` (used when you answer **y** at the prompt) |
| `defaults.env.example` | Optional manual env overrides (copy to `defaults.env` if you prefer not to query) |
| `oe-payment-manager-test-discovery.sql` | Example queries to find `DimeScheduleId`, `EnrollmentId`, etc. |
| `oe-payment-manager-delete-local-test-payments.sql` | Deletes `LOCAL_TEST_%` rows (run via `ai_scripts/db-execute.sh … --testing`) |

**Prerequisites:** `ai_scripts/db-query.sh` / `ai_scripts/db-execute.sh` (repo root), `oe_payment_manager/local.settings.json` with `DB_NAME=allaboard-testing`, and `func start` for webhook scenarios.

**Local host noise (`127.0.0.1:10000`, timer/SQL trigger errors):** see `oe_payment_manager/docs/local-functions-host.md`. For webhook-only runs, merge `local.settings.webhook-only.example.json` into `local.settings.json` or run `npx azurite --silent` in a second terminal.

**Defaults + prompts:** When IDs are missing, you only choose **group**, **individual**, or **enrollment** (one per run, matching the scenario) or **y** / **n**. Run the script again for another scenario to fetch another ID set. To load **all three** ID sets in one go (e.g. for multiple `curl` runs), run `node oe_payment_manager/test_scripts/resolve-defaults.cjs --export --mode=all` manually and `eval` the output, or use `defaults.env`.

**JSON vs audit:** Webhook inserts and payment audit both use **`shared/payment-product-snapshots`** (`buildHouseholdProductSnapshots` / `buildGroupProductSnapshotsForPeriod`). The **shape** of `ProductCommissions` / vendor / owner JSON is the same. Differences you saw were from **which** path ran (household vs whole group) and **as-of / billing period** at insert vs recompute—not a different schema.

**ACH “on a group” vs “individual” (member not on a group):** The DIME payload is always `ach_charge` + `enrollment_id`. Use **`./webhook-test.sh ach-success-group`** (picks an enrollment whose member has `GroupId` set) or **`./webhook-test.sh ach-success-individual`** (`GroupId` null). Plain **`ach-success`** picks any qualifying enrollment. Requires rows in allaboard-testing that match the filter.

**Amounts:** `WEBHOOK_TEST_INDIVIDUAL_PLAN_PREMIUM_AMOUNT` drives individual recurring mock `amount`; `WEBHOOK_TEST_ENROLLMENT_PREMIUM_AMOUNT` drives CC/ACH. Override with `INDIVIDUAL_RECURRING_AMOUNT`, `CC_CHARGE_AMOUNT`, or `ACH_CHARGE_AMOUNT` if needed.

**Modes:** `node oe_payment_manager/test_scripts/resolve-defaults.cjs --export --mode=group|individual|enrollment|all`

**Run (from repo root):**

```bash
./oe_payment_manager/test_scripts/webhook-test.sh help
```

`ai_scripts/webhook-test.sh` (and `ai_scripts/oe-payment-manager-webhook-local-test.sh`) forward to this script.

See comments at the top of the shell script for env vars and scenarios.
