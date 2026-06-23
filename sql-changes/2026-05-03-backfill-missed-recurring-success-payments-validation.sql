/*
  MISSED BOOKINGS — MightyWELL individual recurring successes (producer-approved)
  -----------------------------------------------------------------------------
  WHAT THIS DOES
    • SQL here: READ ONLY (verify gaps + webhook id lookup). NEVER inserts oe.Payments.
    • WRITES happen only via backend replay hitting POST /api/internal/recurring-payment-success/apply.

  Expected gaps (OE still missing payer rows @TenantId 1CD92AF7…8826): 448.17 / 798.57 / two @ 659.12
    ProcessorTxn 371 | 355 | 356 | 313

  Resolved WebhookEventIds (2026-05-01 run — STEP 2 in this file reproduces): 489 | 472 | 473 | 429

  -------- COMPLETE “RUN FOR REAL” (after backend with that route is deployed) --------
  From repo root:

    cd backend/scripts
    cp recurring-success-replay.template recurring-success-replay.env
    # edit recurring-success-replay.env: BACKEND_INTERNAL_BASE_URL, INTERNAL_API_TOKEN

    RECURRING_REPLAY_DRY_RUN=1 ./run-recurring-success-replay.sh

    ./run-recurring-success-replay.sh

  Equivalent one-liners (same Node script):

    DRY_RUN=1 PROCESSOR_TXN_IDS=371,355,356,313 INTERNAL_API_TOKEN=… BACKEND_INTERNAL_BASE_URL=https://… \\
      node backend/scripts/replay-recurring-success-webhooks.js

    WEBHOOK_EVENT_IDS=429,472,473,489 INTERNAL_API_TOKEN=… BACKEND_INTERNAL_BASE_URL=https://… \\
      node backend/scripts/replay-recurring-success-webhooks.js

  Then rerun STEP 1 result set — PaymentId should be non-null for all four ProcessorTxn ids.

  This file does NOT insert oe.Payments. It only verifies gaps and helps find WebhookEventIds.
  Applying payments requires the replay script (see PROCESSOR_TXN_IDS above).

  If you hit "#Expected already exists", your session reused a leftover temp table — the script below
  now drops #Expected before recreating it; or run: DROP TABLE IF EXISTS #Expected; (same session).

  -----------------------------------------------------------------------------
  STEP 1 — Re-check: payments still absent for tenant + processor txn
  -----------------------------------------------------------------------------
*/
SET NOCOUNT ON;

DECLARE @TenantId UNIQUEIDENTIFIER = CAST('1CD92AF7-B6F2-4E48-A8F3-EC6316158826' AS UNIQUEIDENTIFIER);

DROP TABLE IF EXISTS #Expected;

SELECT v.ProcessorTxn, v.ExpectedAmt
INTO #Expected
FROM (VALUES
  (N'371', CAST(448.17 AS DECIMAL(18, 2))),
  (N'355', CAST(798.57 AS DECIMAL(18, 2))),
  (N'356', CAST(659.12 AS DECIMAL(18, 2))),
  (N'313', CAST(659.12 AS DECIMAL(18, 2)))
) AS v(ProcessorTxn, ExpectedAmt);

SELECT
  e.ProcessorTxn,
  e.ExpectedAmt,
  p.PaymentId,
  p.Status,
  p.Amount AS BookedAmt,
  p.HouseholdId,
  p.CreatedDate
FROM #Expected AS e
LEFT JOIN oe.Payments AS p
  ON p.TenantId = @TenantId
 AND LTRIM(RTRIM(ISNULL(p.ProcessorTransactionId, N''))) = e.ProcessorTxn
 AND (
      p.TransactionType IS NULL OR p.TransactionType = N'Payment' OR p.TransactionType = N''
 );

/*
  -----------------------------------------------------------------------------
  STEP 2 — Locate oe.PaymentWebhookEvents.WebhookEventId for replay script
       (latest row per ProcessorTxn; filter recurring success-ish EventType).

  Paste output WebhookEventId list into WEBHOOK_EVENT_IDS if you prefer that
  over PROCESSOR_TXN_IDS on the replay script.
  -----------------------------------------------------------------------------
*/
;WITH T AS (
  SELECT * FROM (VALUES (N'371'), (N'355'), (N'356'), (N'313')) AS q(ProcTxn)
)
SELECT
  t.ProcTxn,
  w.WebhookEventId,
  w.EventType,
  w.TransactionId AS WebhookStoredTransactionId,
  w.CreatedDate
FROM T AS t
OUTER APPLY (
  SELECT TOP (1)
    wh.WebhookEventId,
    wh.EventType,
    wh.TransactionId,
    wh.CreatedDate
  FROM oe.PaymentWebhookEvents AS wh
  WHERE (
      LTRIM(RTRIM(ISNULL(wh.TransactionId, N''))) = t.ProcTxn
      OR CHARINDEX(N'"transaction_number":"' + t.ProcTxn + N'"', wh.Payload) > 0
      OR CHARINDEX(N'"transaction_number": "' + t.ProcTxn + N'"', wh.Payload) > 0
    )
    AND (
      LOWER(ISNULL(wh.EventType, N'')) LIKE N'%recurring%'
      AND (
        LOWER(ISNULL(wh.EventType, N'')) LIKE N'%success%'
        OR wh.EventType LIKE N'recurring_payment.success'
      )
    )
  ORDER BY wh.CreatedDate DESC
) AS w
ORDER BY t.ProcTxn;

/*
  Rows with NULL WebhookEventId: query Payload/EventType manually or replay from IntegrationError payloads.

  JOSEPH: confirm with DIME that both 356 and 313 are real settles before replaying BOTH.

  -----------------------------------------------------------------------------
  STEP 3 — After replay succeeds, re-run STEP 1 SELECT; expect PaymentId NOT NULL.

  -----------------------------------------------------------------------------
*/

DROP TABLE IF EXISTS #Expected;

SELECT N'cleanup_ok' AS runbook_footer;
