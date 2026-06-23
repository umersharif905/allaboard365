-- Fix OPEN Individual invoices: BillingPeriodStart = clamped enrollment anchor DOM for the
-- calendar month of the existing BillingPeriodStart; BillingPeriodEnd = EOMONTH(same month).
-- Aligns InvoiceDate, DueDate, PaymentDueDate with new BillingPeriodStart.
--
-- Excludes INV-202604-0308 (Rick McKinney partial Apr 1–24 gap; would duplicate INV-202604-1163).
-- Does NOT reschedule DIME — follow up recurring sync separately.
--
-- Expected prod impact (when last checked): 4 rows — INV-202604-1251, 1279, 1278, INV-202605-1340.
--
-- =====================================================================
-- READY TO RUN: production UPDATE (COMMIT). Target: allaboard-prod recommended.
-- Verify database name in your session before executing.
-- =====================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

-- OUTPUT without INTO fails (Msg 334) when the target table has enabled triggers; capture then SELECT.
DECLARE @anchorFixOutput TABLE (
  InvoiceNumber NVARCHAR(64) NOT NULL,
  Old_BillingPeriodStart date NULL,
  Old_BillingPeriodEnd date NULL,
  New_BillingPeriodStart date NULL,
  New_BillingPeriodEnd date NULL
);

BEGIN TRY
  BEGIN TRANSACTION;

  ;WITH individual_households AS (
    SELECT DISTINCT e.HouseholdId
    FROM oe.Enrollments e
    WHERE e.EnrollmentType = N'Product'
      AND e.HouseholdId IS NOT NULL
      AND (e.GroupID IS NULL OR e.GroupID = N'00000000-0000-0000-0000-000000000000')
  ),
  anchor AS (
    SELECT
      e.HouseholdId,
      DAY(MIN(e.EffectiveDate)) AS AnchorDom
    FROM oe.Enrollments e
    INNER JOIN individual_households ih ON e.HouseholdId = ih.HouseholdId
    WHERE e.Status = N'Active'
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
      AND e.EnrollmentType IN (N'Product', N'Bundle')
      AND (e.GroupID IS NULL OR CAST(e.GroupID AS NVARCHAR(36)) = N'00000000-0000-0000-0000-000000000000')
    GROUP BY e.HouseholdId
  ),
  invoice_target AS (
    SELECT
      i.InvoiceId,
      CAST(
        DATEFROMPARTS(
          YEAR(i.BillingPeriodStart),
          MONTH(i.BillingPeriodStart),
          CASE
            WHEN a.AnchorDom > DAY(EOMONTH(CAST(i.BillingPeriodStart AS date)))
              THEN DAY(EOMONTH(CAST(i.BillingPeriodStart AS date)))
            ELSE a.AnchorDom
          END
        ) AS date
      ) AS NewStartDate,
      CAST(EOMONTH(CAST(i.BillingPeriodStart AS date)) AS date) AS NewEndDate
    FROM oe.Invoices i
    INNER JOIN anchor a ON a.HouseholdId = i.HouseholdId
    WHERE i.InvoiceType = N'Individual'
      AND i.Status IN (N'Unpaid', N'Partial', N'Overdue')
      AND a.AnchorDom <> 1
      AND DAY(i.BillingPeriodStart) <> a.AnchorDom
      AND ISNULL(i.InvoiceNumber, N'') <> N'INV-202604-0308'
  )
  UPDATE i
  SET
    BillingPeriodStart = CAST(t.NewStartDate AS datetime),
    BillingPeriodEnd = CAST(t.NewEndDate AS datetime),
    InvoiceDate = CAST(t.NewStartDate AS date),
    DueDate = CAST(t.NewStartDate AS date),
    PaymentDueDate = CAST(t.NewStartDate AS date),
    ModifiedDate = GETUTCDATE()
  OUTPUT
    inserted.InvoiceNumber,
    CAST(deleted.BillingPeriodStart AS date),
    CAST(deleted.BillingPeriodEnd AS date),
    CAST(inserted.BillingPeriodStart AS date),
    CAST(inserted.BillingPeriodEnd AS date)
  INTO @anchorFixOutput (
    InvoiceNumber,
    Old_BillingPeriodStart,
    Old_BillingPeriodEnd,
    New_BillingPeriodStart,
    New_BillingPeriodEnd
  )
  FROM oe.Invoices i
  INNER JOIN invoice_target t ON t.InvoiceId = i.InvoiceId;

  SELECT
    o.InvoiceNumber,
    o.Old_BillingPeriodStart,
    o.Old_BillingPeriodEnd,
    o.New_BillingPeriodStart,
    o.New_BillingPeriodEnd
  FROM @anchorFixOutput o
  ORDER BY o.New_BillingPeriodStart, o.InvoiceNumber;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;


-- =====================================================================
-- OPTIONAL: preview only (same filters, read-only — run as a separate batch; do NOT use with APPLY above)
-- =====================================================================
/*
;WITH individual_households AS (
  SELECT DISTINCT e.HouseholdId
  FROM oe.Enrollments e
  WHERE e.EnrollmentType = N'Product'
    AND e.HouseholdId IS NOT NULL
    AND (e.GroupID IS NULL OR e.GroupID = N'00000000-0000-0000-0000-000000000000')
),
anchor AS (
  SELECT
    e.HouseholdId,
    DAY(MIN(e.EffectiveDate)) AS AnchorDom
  FROM oe.Enrollments e
  INNER JOIN individual_households ih ON e.HouseholdId = ih.HouseholdId
  WHERE e.Status = N'Active'
    AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
    AND e.EnrollmentType IN (N'Product', N'Bundle')
    AND (e.GroupID IS NULL OR CAST(e.GroupID AS NVARCHAR(36)) = N'00000000-0000-0000-0000-000000000000')
  GROUP BY e.HouseholdId
),
invoice_target AS (
  SELECT
    i.InvoiceNumber,
    i.HouseholdId,
    i.Status,
    a.AnchorDom,
    i.BillingPeriodStart AS OldStart,
    i.BillingPeriodEnd AS OldEnd,
    CAST(
      DATEFROMPARTS(
        YEAR(i.BillingPeriodStart),
        MONTH(i.BillingPeriodStart),
        CASE
          WHEN a.AnchorDom > DAY(EOMONTH(CAST(i.BillingPeriodStart AS date)))
            THEN DAY(EOMONTH(CAST(i.BillingPeriodStart AS date)))
          ELSE a.AnchorDom
        END
      ) AS date
    ) AS NewStartDate,
    CAST(EOMONTH(CAST(i.BillingPeriodStart AS date)) AS date) AS NewEndDate
  FROM oe.Invoices i
  INNER JOIN anchor a ON a.HouseholdId = i.HouseholdId
  WHERE i.InvoiceType = N'Individual'
    AND i.Status IN (N'Unpaid', N'Partial', N'Overdue')
    AND a.AnchorDom <> 1
    AND DAY(i.BillingPeriodStart) <> a.AnchorDom
    AND ISNULL(i.InvoiceNumber, N'') <> N'INV-202604-0308'
)
SELECT
  it.InvoiceNumber,
  CAST(it.HouseholdId AS NVARCHAR(36)) AS HouseholdId,
  it.Status,
  it.AnchorDom,
  CONVERT(date, it.OldStart) AS OldStartDate,
  CONVERT(date, it.OldEnd) AS OldEndDate,
  it.NewStartDate,
  it.NewEndDate
FROM invoice_target it
ORDER BY it.NewStartDate, it.InvoiceNumber;
*/
