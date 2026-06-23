/*
  Invoice-first payout timing — backfill oe.Invoices.PaymentReceivedDate

  Idempotent: only updates rows where Status = N'Paid' AND PaymentReceivedDate IS NULL.

  Stamping rule:
    1) MAX(p.PaymentDate) over oe.Payments for this invoice with Status IN
       ('Completed','APPROVAL','succeeded','Success')  — keep in sync with backend/constants/paymentStatuses.js
    2) Else COALESCE(ModifiedDate, CreatedDate) on the invoice

  PREVIEW (no writes) — run this SELECT instead of the UPDATE:

  ;WITH PaidStatuses AS (
    SELECT v.Status FROM (VALUES (N'Completed'),(N'APPROVAL'),(N'succeeded'),(N'Success')) AS v(Status)
  ), Anchor AS (
    SELECT i.InvoiceId,
           COALESCE(MAX(p.PaymentDate), i.ModifiedDate, i.CreatedDate) AS AnchorUtc
    FROM oe.Invoices i
    LEFT JOIN oe.Payments p ON p.InvoiceId = i.InvoiceId AND p.Status IN (SELECT Status FROM PaidStatuses)
    WHERE i.Status = N'Paid' AND i.PaymentReceivedDate IS NULL
    GROUP BY i.InvoiceId, i.ModifiedDate, i.CreatedDate
  )
  SELECT i.InvoiceId, i.TenantId, i.Status, i.PaymentReceivedDate, a.AnchorUtc
  FROM oe.Invoices i INNER JOIN Anchor a ON a.InvoiceId = i.InvoiceId
  ORDER BY i.ModifiedDate DESC;
*/

SET NOCOUNT ON;

;WITH PaidStatuses AS (
  SELECT v.Status
  FROM (VALUES
    (N'Completed'),
    (N'APPROVAL'),
    (N'succeeded'),
    (N'Success')
  ) AS v(Status)
), Anchor AS (
  SELECT
    i.InvoiceId,
    COALESCE(MAX(p.PaymentDate), i.ModifiedDate, i.CreatedDate) AS AnchorUtc
  FROM oe.Invoices i
  LEFT JOIN oe.Payments p
    ON p.InvoiceId = i.InvoiceId
   AND p.Status IN (SELECT Status FROM PaidStatuses)
  WHERE i.Status = N'Paid'
    AND i.PaymentReceivedDate IS NULL
  GROUP BY i.InvoiceId, i.ModifiedDate, i.CreatedDate
)
UPDATE i
SET i.PaymentReceivedDate = a.AnchorUtc
FROM oe.Invoices i
INNER JOIN Anchor a ON a.InvoiceId = i.InvoiceId
WHERE i.Status = N'Paid'
  AND i.PaymentReceivedDate IS NULL;
