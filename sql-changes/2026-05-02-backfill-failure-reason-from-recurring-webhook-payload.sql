/*
  Backfill oe.Payments.FailureReason from oe.PaymentWebhookEvents.Payload
  for recurring_payment_failed rows where we stored Unknown but DIME sent
  transaction_error / transaction_error_code or failure_reason.

  Safe to run more than once: only updates Failed payments still showing Unknown.

  Preview candidates:
*/

/*
SELECT p.PaymentId, p.FailureReason, wh.EventType,
  LEFT(wh.Payload, 280) AS PayloadSample
FROM oe.Payments AS p
INNER JOIN oe.PaymentWebhookEvents AS wh ON wh.WebhookEventId = p.WebhookEventId
WHERE p.Status = N'Failed'
  AND ISNULL(NULLIF(LTRIM(RTRIM(p.FailureReason)), N''), N'Unknown') = N'Unknown'
  AND wh.EventType IN (N'recurring_payment_failed', N'recurring_payment.failed');
*/

UPDATE p
SET
  FailureReason =
    CASE
      WHEN NULLIF(LTRIM(RTRIM(JSON_VALUE(wh.Payload, '$.failure_reason'))), N'') IS NOT NULL
        THEN LTRIM(RTRIM(JSON_VALUE(wh.Payload, '$.failure_reason')))
      WHEN NULLIF(LTRIM(RTRIM(JSON_VALUE(wh.Payload, '$.transaction_error'))), N'') IS NOT NULL THEN
        CASE
          WHEN NULLIF(LTRIM(RTRIM(JSON_VALUE(wh.Payload, '$.transaction_error_code'))), N'') IS NOT NULL
            THEN CONCAT(N'[', JSON_VALUE(wh.Payload, '$.transaction_error_code'), N'] ', JSON_VALUE(wh.Payload, '$.transaction_error'))
          ELSE LTRIM(RTRIM(JSON_VALUE(wh.Payload, '$.transaction_error')))
        END
      WHEN NULLIF(LTRIM(RTRIM(JSON_VALUE(wh.Payload, '$.error_message'))), N'') IS NOT NULL THEN
        CASE
          WHEN NULLIF(LTRIM(RTRIM(JSON_VALUE(wh.Payload, '$.transaction_error_code'))), N'') IS NOT NULL
            THEN CONCAT(N'[', JSON_VALUE(wh.Payload, '$.transaction_error_code'), N'] ', JSON_VALUE(wh.Payload, '$.error_message'))
          ELSE LTRIM(RTRIM(JSON_VALUE(wh.Payload, '$.error_message')))
        END
      WHEN NULLIF(LTRIM(RTRIM(JSON_VALUE(wh.Payload, '$.transaction_error_code'))), N'') IS NOT NULL THEN
        CONCAT(N'[', JSON_VALUE(wh.Payload, '$.transaction_error_code'), N'] ', N'(no message from processor)')
      ELSE p.FailureReason
    END,
  ModifiedDate = GETUTCDATE()
FROM oe.Payments AS p
INNER JOIN oe.PaymentWebhookEvents AS wh ON wh.WebhookEventId = p.WebhookEventId
WHERE p.Status = N'Failed'
  AND p.TransactionType = N'Payment'
  AND ISNULL(NULLIF(LTRIM(RTRIM(p.FailureReason)), N''), N'Unknown') = N'Unknown'
  AND wh.EventType IN (N'recurring_payment_failed', N'recurring_payment.failed');
