# Manual Payment Backfill (Webhooks Not Fired)

When DIME webhooks were not fired for recent payments, you can either run **DimePaymentSync** (recommended first) or manually trigger one payment per transaction using the test webhook (or a small script).

**There is no UI to run the sync.** You run it via HTTP (curl, Postman, or a backend proxy). See below.

---

## Run oe_payment_manager locally

1. **Start the function app**
   ```bash
   cd oe_payment_manager
   npm install
   npm start
   ```
   Leave this running. You should see something like:
   `DimePaymentSync: [POST] http://localhost:7071/api/sync-payments`

2. **Call the sync** from another terminal (use the same `ADMIN_API_KEY` as in `local.settings.json`):
   ```bash
   # Sync last 6 days (no dry run)
   curl -X POST "http://localhost:7071/api/sync-payments?hours=144" \
     -H "x-api-key: YOUR_ADMIN_API_KEY"

   # Dry run: show what would be created/updated, no DB changes
   curl -X POST "http://localhost:7071/api/sync-payments?hours=144&dryRun=true" \
     -H "x-api-key: YOUR_ADMIN_API_KEY"

   # Create at most 1 new payment (then stop)
   curl -X POST "http://localhost:7071/api/sync-payments?hours=144&limit=1" \
     -H "x-api-key: YOUR_ADMIN_API_KEY"

   # Dry run + limit 1: show only the first payment that would be created
   curl -X POST "http://localhost:7071/api/sync-payments?hours=144&dryRun=true&limit=1" \
     -H "x-api-key: YOUR_ADMIN_API_KEY"
   ```

3. **How the sync works**
   - Loads all groups with a DIME customer ID (`ProcessorCustomerId`), grouped by tenant.
   - **Per tenant**: calls DIME once for **recent transactions** in the time window (no per-customer filter). Each transaction is expected to include `customer_uuid` (or equivalent) so we can match to our group.
   - For each transaction: resolve group by `customer_uuid`; if already in `oe.Payments`, optionally update status; if not, create a new payment row (and update invoice if applicable).
   - **dryRun=true**: same logic but no INSERTs/UPDATEs; response includes `stats.dryRunWouldCreate` and `stats.dryRunWouldUpdate`.
   - **limit=N**: stop after creating N new payments (or that many “would create” in dry run).

   If DIME uses a different endpoint or response shape for “recent payments/transactions”, you can share the expected request/response JSON and we can align the sync to it.

---

## Individual (member/household) payments

**Currently the sync only creates oe.Payments for group recurring payments.** It matches DIME transactions to groups via `oe.Groups.ProcessorCustomerId` = transaction `customer_uuid`. Payments for **individual members** (member-level or household-level recurring, not tied to a group's DIME customer) are **not** created by the sync today.

- **Why:** We only build a lookup from `customer_uuid` to group (from `oe.Groups`). Individual recurring in DIME may use a different customer UUID (e.g. stored on Member or payment method), and we don't load those into the map.
- **To support individual:** We'd need a table or column that stores a DIME customer UUID per member or household (e.g. `oe.Members.ProcessorCustomerId` or a payment-method table). Then the sync would add those to the lookup; when a transaction's `customer_uuid` matches a member/household (and not a group), we'd run the same create logic with `HouseholdId` and that member's `GroupId`/`TenantId`. If you have that source of truth, we can extend the sync to include it.

---

## Sync vs webhook: same oe.Payments shape?

**The sync now produces the same set of columns and JSON structures as the webhook** for the payment row:

- **Scalar fields:** Amount, Status, Processor, ProcessorTransactionId, PaymentMethod, RecurringScheduleId, PaymentDate, NetRate, Commission, OverrideRate, SystemFees, ProcessingFeeAmount, EnrollmentId, AgentId, HouseholdId, GroupId, TenantId, LocationId, InvoiceId — all derived the same way (from enrollments and matchTransactionToGroup).
- **JSON columns:** ProductCommissions, **ProductVendorAmounts**, **ProductOwnerAmounts** — the sync now builds all three with the same logic as `DimeWebhookHandler` (enrolledHouseholdsCount, vendorAmount, overrideAmount, commissionAmount; excludes bundle product IDs).

So **yes**: the sync uses the same backend shape as the webhook (same columns and same JSON structures). It is a **separate code path** (DimePaymentSync vs DimeWebhookHandler), but the resulting oe.Payments row is aligned.

**Differences:** The webhook also sets WebhookEventId and NextBillingDate; the sync does not write WebhookEventId (no webhook event) and does not set NextBillingDate. Those are optional for reporting/billing; the commission and NACHA logic use the same JSON and scalars.

---

## "No group for customer_uuid (missing)" in logs

If you see many lines like `Skipping transaction 12345: no group for customer_uuid (missing)`:

- **Missing** means DIME did not include `customer_uuid` (or it was null/empty) on that transaction. The sync can't match it to a group or individual without it.
- Those transactions may be: individual member payments (DIME might not always send customer_uuid in list), test data, or another flow. Once we support individual payments and have a customer_uuid source for members/households, we can also try to match by other fields if DIME provides them.

---

## Option 1: Run DimePaymentSync (recommended first)

Sync pulls transactions from the DIME API for all groups that have `ProcessorCustomerId` and creates/updates `oe.Payments` for any transaction not already present. No per-payment data needed from you.

**How to run:**
- **Production (Azure):** POST to your Function App URL with header `x-api-key: <ADMIN_API_KEY>` (from Azure Application Settings).
- **Local:** From `oe_payment_manager` run `npm start`, then POST to `http://localhost:7071/api/sync-payments` with the same header; use `ADMIN_API_KEY` from `local.settings.json`.

**Example (Azure):**
```bash
# Sync 5–6 days back (recommended for missed webhooks)
curl -X POST "https://<your-function-app>.azurewebsites.net/api/sync-payments?hours=144" \
  -H "x-api-key: YOUR_ADMIN_API_KEY"
# hours=144 = 6 days; use hours=120 for 5 days

# Or use an explicit date range
curl -X POST "https://<your-function-app>.azurewebsites.net/api/sync-payments?startDate=2026-02-04T00:00:00&endDate=2026-02-10T23:59:59" \
  -H "x-api-key: YOUR_ADMIN_API_KEY"

# Last 24 hours (default if no query params)
curl -X POST "https://<your-function-app>.azurewebsites.net/api/sync-payments" \
  -H "x-api-key: YOUR_ADMIN_API_KEY"
```

If all missed payments are in a known time window and the groups have `ProcessorCustomerId` set, this may create all missing `oe.Payments` without providing transaction IDs.

---

## Option 2: Per-payment data (for manual webhook or script)

If sync doesn’t cover some payments (e.g. wrong date range or you want to target specific transactions), use one row per payment with the fields below. The handler will resolve group, pricing, ProductCommissions, invoice, etc. from the database.

### Required per payment

| Field | Description | Example |
|-------|-------------|--------|
| **transaction_number** | DIME transaction ID (or `transaction_id`) | `"12345678"` or `"TXN-abc-123"` |
| **amount** | Payment amount (string or number) | `"1234.56"` |
| **customer_uuid** | DIME customer UUID = `oe.Groups.ProcessorCustomerId` for the group that was charged | `"b2d454bd-0aba-4c2f-837c-f607cdd4ec5f"` |

### Optional (helpful if you have them)

| Field | Description | Example |
|-------|-------------|--------|
| **schedule_id** | DIME recurring schedule ID (`oe.GroupRecurringPaymentPlans.DimeScheduleId`) | `"22"` |
| **payment_date** | Date/time of the payment (ISO or `YYYY-MM-DD HH:mm:ss`) | `"2026-02-05T14:00:00"` |
| **status_code** | DIME status (default `"00"` for success) | `"00"` |
| **status_text** | DIME status text (default `"Approved"`) | `"Approved"` |
| **transaction_type** | Payment method label | `"Credit Card"` or `"ACH"` |

### If you don’t have customer_uuid

You can use **group_id** (our `oe.Groups.GroupId`) instead and look up `ProcessorCustomerId` in the DB, then pass that as `customer_uuid` when calling the webhook. Example lookup:

```sql
SELECT GroupId, Name, ProcessorCustomerId
FROM oe.Groups
WHERE GroupId = 'YOUR-GROUP-GUID'
  AND ProcessorCustomerId IS NOT NULL;
```

Use the `ProcessorCustomerId` value as `customer_uuid` in the payload.

---

## Example: one payment (test webhook)

Body for a single backfill (e.g. POST to your test-webhook or a small script that forwards to the same handler):

```json
{
  "type": "recurring_payment_success",
  "transaction_number": "12345678",
  "amount": "1234.56",
  "status_code": "00",
  "status_text": "Approved",
  "transaction_type": "Credit Card",
  "customer_uuid": "b2d454bd-0aba-4c2f-837c-f607cdd4ec5f",
  "schedule_id": "22"
}
```

Optional: add `transaction_date` or `payment_date` in ISO format if you want a specific payment date.

---

## Example: CSV for multiple payments

If you’re generating a list for a script, one row per payment with at least:

```text
transaction_number,amount,customer_uuid,schedule_id,payment_date
12345678,1234.56,b2d454bd-0aba-4c2f-837c-f607cdd4ec5f,22,2026-02-05 14:00:00
87654321,567.89,b2d454bd-0aba-4c2f-837c-f607cdd4ec5f,22,2026-02-06 09:00:00
```

`schedule_id` and `payment_date` can be empty; the handler will infer schedule from `customer_uuid` and use a default date if needed.

---

## What gets created

For each successful run (sync or simulated webhook), the handler will:

- Insert a row into `oe.Payments` with: Amount, Status, ProcessorTransactionId, PaymentMethod, GroupId, TenantId, LocationId, InvoiceId, RecurringScheduleId, NetRate, Commission, OverrideRate, SystemFees, ProcessingFeeAmount, ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts, PaymentDate, etc.
- If the payment is tied to a group invoice: update `oe.Invoices` (Status = Paid, PaidAmount, PaymentReceivedDate).
- If applicable: mark SetupFee enrollments as Paid.

So you only need to supply the per-payment fields above; the rest is derived from the DB.
