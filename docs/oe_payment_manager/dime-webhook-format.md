# DIME Webhook Payload Format

## Actual Webhook Structure

DIME sends webhooks with the following structure. The entire request body IS the webhook data (not nested in a `data` field).

### Example: Recurring Payment Success

```json
{
  "type": "recurring_payment_success",
  "transaction_type": "Credit Card",
  "transaction_status": "",
  "transaction_status_description": "",
  "transaction_number": "FAKE-295531",
  "transaction_date": "",
  "fund_date": "",
  "settle_date": "",
  "amount": "10.00",
  "description": "Mimicked Recurring Payment",
  "status_code": "00",
  "status_text": "Approved",
  "email": "fake@example.com",
  "phone": "",
  "customer_uuid": "b2d454bd-0aba-4c2f-837c-f607cdd4ec5f",
  "multi_use_token": "",
  "pending": false,
  "transaction_info_id": "",
  "parent_transaction_info_id": "",
  "billing_address": {
    "first_name": "Fake",
    "last_name": "User",
    "addr1": "",
    "addr2": "",
    "city": "",
    "state": "",
    "zip": ""
  },
  "shippingAddress": {
    "addr1": "",
    "addr2": "",
    "city": "",
    "state": "",
    "zip": ""
  }
}
```

## Key Field Mappings

### Event Type
- **Field:** `type` (root level)
- **Examples:** 
  - `"recurring_payment_success"`
  - `"recurring_payment_failed"`
  - `"credit_card_charge"`
  - `"ach_charge"`
- **Note:** Our code normalizes these to handler format (e.g., `"recurring_payment_success"` → `"recurring_payment.success"`)

### Transaction Identification
- **Transaction ID:** `transaction_number` (not `transaction_id`)
- **Amount:** `amount` (string, needs `parseFloat()`)
- **Customer:** `customer_uuid` (at root level)

### Status Fields
- **Status Code:** `status_code` (e.g., `"00"` = Approved)
- **Status Text:** `status_text` (e.g., `"Approved"`)
- **Mapping:** 
  - `status_code === "00"` + `status_text.includes("Approved")` = `Completed`
  - Other codes = `Failed` or `Pending`

### Payment Method
- **Field:** `transaction_type` (not `payment_method`)
- **Examples:** `"Credit Card"`, `"ACH"`

### Schedule ID
- **Field:** `schedule_id` or `recurring_payment_id` (may not be present)
- **Fallback:** OpenEnroll resolves an active **`oe.IndividualRecurringSchedules.DimeScheduleId`** from **`customer_uuid`** (matched to **`oe.MemberPaymentMethods.ProcessorCustomerId`**) — see `backend/services/recurringPaymentWebhookApply.service.js`.

### `description` (recurring rows)

Production payloads often send a human-readable **`description`** (example: **`"Brian Schoening (SW15990821)"`**) that mirrors DIME recurring “Memo”. When **`schedule_id` is missing** *and* the same **`customer_uuid`** appears on **multiple** households (duplicate accounts linking the same DIME customer):

- Matching **only `customer_uuid`** is **unsafe**.
- Backend disambiguates by parsing the **member-facing id in parentheses** and matching **`oe.Members.HouseholdMemberID`** for the household’s primary member, **before** relying on **`MonthlyAmount`**. If ambiguity remains → **`MISSING_SCHEDULE`** (retryable): no payment row is silently posted to the wrong household.

Operational SQL (diagnostics): `sql-changes/2026-05-05-diagnostic-duplicated-member-recurring-webhook-resolution.sql`.

### Measuring payload shape in prod

Historical **`schedule_id`** presence is easiest from **`oe.PaymentWebhookEvents.Payload`** (no dedicated column), for example **`JSON_VALUE(Payload,'$.schedule_id')`** on recurring-success rows joined to **`oe.Payments`** via **`WebhookEventId`**.

### Env: amount-only fallback

Set **`RECURRING_WEBHOOK_DISABLE_AMOUNT_DISAMBIG=1`** (or **`true`**) if you must disable the **MonthlyAmount ± processing-fee delta** tier (description + single-schedule behaviors still apply). Default: amount tier **enabled**.

### Dates
- **Transaction Date:** `transaction_date`
- **Fund Date:** `fund_date`
- **Settle Date:** `settle_date`
- Use first available date, fallback to current date

### Related Transactions
- **Parent Transaction:** `parent_transaction_info_id` (for refunds/returns)

### Recurring payment failed (`recurring_payment_failed`)

For failures after billing, DIME sends root-level fields including:

- **`transaction_error_code`** — processor code (e.g. `23` = token lookup / TaaS failure)
- **`transaction_error`** — human-readable explanation (distinct from **`failure_reason`**, which legacy samples used)

Persist **`failure_reason`** when present (customized wording); otherwise build `FailureReason` from **`transaction_error_code`** + **`transaction_error`** (see `shared/payment-status` → `formatDimeRecurringFailureReasonForStorage`).

**Production note:** Billing webhooks often hit the deployed **`allaboard-payment-manager`** app (`DimeWebhookHandler`). That handler must apply the same mapping when you rely on prod logs/DB—not only `oe_payment_manager/WebhookProcessor/index.js` in-repo.

## Handler Updates

All webhook handlers have been updated to:
1. Parse `transaction_number` instead of `transaction_id`
2. Parse `amount` as string using `parseFloat()`
3. Map `status_code` + `status_text` to payment status
4. Use `transaction_type` for payment method
5. Look up **`schedule_id` by `customer_uuid`** only when **`schedule_id` / `recurring_payment_id`** are absent — with duplicate-safe **`description`** / **`MonthlyAmount`** disambiguation in the recurring success apply path
6. Emit structured **`[recurring-apply]`** schedule-resolution logs (`payloadHadScheduleId`, `candidateCount`, `disambiguation`, resolved `scheduleId`)

## Correcting payments booked to wrong household

If attribution was wrong (duplicate **`customer_uuid`** linkage + ambiguous schedules):

- Use **`sql-changes/2026-05-05-template-reassign-payment-wrong-household.sql`** as a **manual** blueprint after finance review (typically update **`HouseholdId` / `InvoiceId`** via controlled SQL or admin tooling).

## Transaction API Response

The `/api/transactions` endpoint returns the same structure as webhooks, so the payment sync function uses the same field mappings.

