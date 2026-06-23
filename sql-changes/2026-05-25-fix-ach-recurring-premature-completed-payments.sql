-- =============================================================================
-- DO NOT RUN THIS SCRIPT AS WRITTEN (2026-05-25)
-- =============================================================================
-- This script was based on a bad assumption: that recurring_payment_success webhooks
-- with empty transaction_status mean the payment was incorrectly stored as Completed.
--
-- That pattern is NORMAL for DIME ACH recurring. DIME sends status_code 00 + empty
-- transaction_status at ACH *initiation*. Most of these payments later settle
-- successfully at DIME even when we never receive a follow-up webhook. In prod,
-- ~120 payments match this webhook shape and ~113 linked invoices are correctly Paid.
-- Running the UPDATEs below would wrongly flip those invoices to Overdue.
--
-- Example: Leslie Alexander (txn 299, INV-202604-1262) — one webhook, empty
-- transaction_status, payment succeeded at DIME, invoice correctly Paid.
--
-- CORRECT approach for fixing *actual* mismatches:
--   1. Deploy payment-status fix for ACH_PAYMENT_CREDIT_REJECTED → Failed (audit path).
--   2. Run DIME payment-status audit with dryRun=true first:
--        POST /api/me/sysadmin/billing/dime-payment-status-audit
--        { "tenantId": "...", "dryRun": true, "hoursBack": 720, "limit": 500 }
--      Only rows where DB status != DIME live status are candidates (e.g. Willey txn
--      485 Completed in DB but ACH_PAYMENT_CREDIT_REJECTED at DIME).
--   3. Review dry-run output; apply with dryRun=false only for confirmed mismatches.
--
-- Do NOT bulk-unfulfill by webhook payload pattern.
-- =============================================================================

SET NOCOUNT ON;

-- ---------------------------------------------------------------------------
-- READ-ONLY PREVIEW: invoice status changes THIS SCRIPT WOULD HAVE MADE (wrong)
-- Run this block alone to see why the UPDATEs must not run.
-- ---------------------------------------------------------------------------
/*
WITH AffectedPayments AS (
  SELECT
    p.PaymentId,
    p.InvoiceId,
    CAST(p.Amount AS DECIMAL(18, 2)) AS Amount,
    p.ProcessorTransactionId
  FROM oe.Payments p
  INNER JOIN oe.PaymentWebhookEvents w ON w.WebhookEventId = p.WebhookEventId
  WHERE p.Processor = N'DIME'
    AND p.ProcessorTransactionId IS NOT NULL
    AND LOWER(LTRIM(RTRIM(ISNULL(p.Status, N'')))) IN (
      N'completed', N'approval', N'success', N'succeeded', N'approved', N'paid'
    )
    AND w.EventType = N'recurring_payment_success'
    AND w.Payload LIKE N'%"transaction_type":"ACH"%'
    AND (
      w.Payload LIKE N'%"transaction_status":""%'
      OR w.Payload LIKE N'%"transaction_status": ""%'
    )
),
InvoiceAdjustments AS (
  SELECT
    i.InvoiceId,
    i.InvoiceNumber,
    i.InvoiceType,
    i.HouseholdId,
    i.Status AS CurrentStatus,
    CASE
      WHEN ISNULL(i.PaidAmount, 0) >= a.PaySum THEN ISNULL(i.PaidAmount, 0) - a.PaySum
      ELSE 0
    END AS NewPaidAmount,
    ISNULL(i.CreditAmount, 0) AS CreditAmount,
    ISNULL(i.TotalAmount, 0) AS TotalAmount,
    i.DueDate,
    g.Name AS GroupName
  FROM oe.Invoices i
  INNER JOIN (
    SELECT InvoiceId, SUM(Amount) AS PaySum
    FROM AffectedPayments
    WHERE InvoiceId IS NOT NULL
    GROUP BY InvoiceId
  ) a ON a.InvoiceId = i.InvoiceId
  LEFT JOIN oe.Groups g ON i.GroupId = g.GroupId
),
WithNewStatus AS (
  SELECT
    *,
    CASE
      WHEN CurrentStatus = N'Cancelled' THEN N'Cancelled'
      WHEN (NewPaidAmount + CreditAmount) >= TotalAmount - 0.01 THEN N'Paid'
      WHEN (NewPaidAmount + CreditAmount) > 0.01 THEN N'Partial'
      WHEN DueDate IS NOT NULL AND DueDate < CAST(GETUTCDATE() AS DATE) THEN N'Overdue'
      ELSE N'Unpaid'
    END AS NewStatus
  FROM InvoiceAdjustments
)
SELECT
  w.InvoiceNumber,
  w.InvoiceType,
  COALESCE(w.GroupName, LTRIM(RTRIM(CONCAT(u.FirstName, N' ', u.LastName)))) AS Payer,
  u.Email,
  w.CurrentStatus,
  w.NewStatus
FROM WithNewStatus w
LEFT JOIN oe.Members m ON w.HouseholdId = m.HouseholdId AND m.RelationshipType = N'P'
LEFT JOIN oe.Users u ON m.UserId = u.UserId
WHERE w.CurrentStatus <> w.NewStatus
ORDER BY w.InvoiceType, w.NewStatus, Payer, w.InvoiceNumber;

SELECT
  COUNT(*) AS PaymentsMatchingWebhookPattern,
  SUM(CASE WHEN InvoiceId IS NULL THEN 1 ELSE 0 END) AS PaymentsNoInvoice
FROM AffectedPayments;
*/

-- ---------------------------------------------------------------------------
-- DESTRUCTIVE UPDATES DISABLED — see header comment
-- ---------------------------------------------------------------------------
/*
BEGIN TRANSACTION;
-- (original Part 2–4 UPDATEs removed — do not re-enable without DIME cross-check)
COMMIT TRANSACTION;
*/
