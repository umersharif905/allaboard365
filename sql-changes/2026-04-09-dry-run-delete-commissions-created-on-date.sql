/*
  Review / optional delete: oe.Commissions rows created on a single calendar day (by CreatedDate).

  Context: batch commission generation interrupted; rows created that day may be incomplete or wrong.

  IMPORTANT
  - Run sections 1–3 first (dry run only). Review counts, sample rows, and PaymentId list.
  - CreatedDate is set with GETDATE() at insert time (server clock). Filter uses calendar date in the
    database server’s timezone — confirm with SELECT SYSDATETIMEOFFSET() / your Azure region if needed.
  - Foreign keys:
      * oe.CommissionLogs.CommissionId -> oe.Commissions
      * oe.Commissions.OriginalCommissionId -> oe.Commissions (self-reference: delete “child” rows first)

  DO NOT run the DELETE block until you are satisfied with the dry-run output.
*/

SET NOCOUNT ON;

DECLARE @TargetDate date = '2026-04-09';

/* ------------------------------------------------------------------ */
/* 1) DRY RUN — counts                                                  */
/* ------------------------------------------------------------------ */
SELECT
  COUNT(*) AS CommissionRowCount,
  SUM(CAST(c.Amount AS decimal(18, 2))) AS TotalAmount
FROM oe.Commissions c
WHERE CAST(c.CreatedDate AS date) = @TargetDate;

SELECT
  c.Status,
  c.TransactionType,
  COUNT(*) AS Cnt,
  SUM(CAST(c.Amount AS decimal(18, 2))) AS TotalAmount
FROM oe.Commissions c
WHERE CAST(c.CreatedDate AS date) = @TargetDate
GROUP BY c.Status, c.TransactionType
ORDER BY c.Status, c.TransactionType;

/* Rows that reference another commission (delete these before parents, if you run DELETE) */
SELECT COUNT(*) AS RowsWithOriginalCommissionId
FROM oe.Commissions c
WHERE CAST(c.CreatedDate AS date) = @TargetDate
  AND c.OriginalCommissionId IS NOT NULL;

/* ------------------------------------------------------------------ */
/* 2) DRY RUN — sample rows (adjust TOP)                                */
/* ------------------------------------------------------------------ */
SELECT TOP 100
  c.CommissionId,
  c.PaymentId,
  c.AgentId,
  c.AgencyId,
  c.HouseholdId,
  c.GroupId,
  c.TransactionType,
  c.Status,
  c.Amount,
  c.AdvanceBalance,
  c.OriginalCommissionId,
  c.CreatedDate
FROM oe.Commissions c
WHERE CAST(c.CreatedDate AS date) = @TargetDate
ORDER BY c.CreatedDate DESC, c.CommissionId;

/* ------------------------------------------------------------------ */
/* 3) DRY RUN — join payments (sanity check)                            */
/* ------------------------------------------------------------------ */
SELECT TOP 200
  c.CommissionId,
  c.PaymentId,
  p.PaymentDate,
  p.Status AS PaymentStatus,
  p.Amount AS PaymentAmount,
  c.TransactionType,
  c.Amount AS CommissionAmount,
  c.CreatedDate
FROM oe.Commissions c
LEFT JOIN oe.Payments p ON p.PaymentId = c.PaymentId
WHERE CAST(c.CreatedDate AS date) = @TargetDate
ORDER BY c.CreatedDate DESC;

/* ------------------------------------------------------------------ */
/* 4) DRY RUN — CommissionLogs rows that would need deleting first     */
/*    (only if you delete the matching commissions)                     */
/* ------------------------------------------------------------------ */
SELECT COUNT(*) AS CommissionLogsRowCount
FROM oe.CommissionLogs cl
WHERE EXISTS (
  SELECT 1
  FROM oe.Commissions c
  WHERE c.CommissionId = cl.CommissionId
    AND CAST(c.CreatedDate AS date) = @TargetDate
);

SELECT TOP 50
  cl.LogId,
  cl.CommissionId,
  cl.PaymentId
FROM oe.CommissionLogs cl
WHERE EXISTS (
  SELECT 1
  FROM oe.Commissions c
  WHERE c.CommissionId = cl.CommissionId
    AND CAST(c.CreatedDate AS date) = @TargetDate
);

GO

/*
  ========================================================================
  5) DELETE — NOT RUN BY DEFAULT — READ CAREFULLY
  ========================================================================
  - Uncomment and run ONLY after reviewing sections 1–4.
  - Prefer a maintenance window; consider disabling downstream jobs that create commissions.
  - Suggested: run in SSMS with implicit transaction review, or wrap in BEGIN TRAN / ROLLBACK first.

  Order:
    1) Delete CommissionLogs for CommissionIds in the target set.
    2) Delete commission rows created that day that reference another commission (OriginalCommissionId IS NOT NULL).
    3) Delete remaining commission rows created that day (Advance rows, standalone, etc.).

  If DELETE fails with FK on OriginalCommissionId, run step 2 again (rare chains), then step 3.

DECLARE @TargetDate date = '2026-04-09';

BEGIN TRANSACTION;

  DELETE cl
  FROM oe.CommissionLogs AS cl
  WHERE EXISTS (
    SELECT 1
    FROM oe.Commissions AS c
    WHERE c.CommissionId = cl.CommissionId
      AND CAST(c.CreatedDate AS date) = @TargetDate
  );

  DELETE c
  FROM oe.Commissions AS c
  WHERE CAST(c.CreatedDate AS date) = @TargetDate
    AND c.OriginalCommissionId IS NOT NULL;

  DELETE c
  FROM oe.Commissions AS c
  WHERE CAST(c.CreatedDate AS date) = @TargetDate;

  -- Review row counts (should be 0 for target date):
  -- SELECT COUNT(*) FROM oe.Commissions WHERE CAST(CreatedDate AS date) = @TargetDate;

-- COMMIT TRANSACTION;
-- ROLLBACK TRANSACTION;

*/
