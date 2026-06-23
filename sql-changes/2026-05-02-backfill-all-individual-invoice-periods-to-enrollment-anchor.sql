-- Backfill ALL Individual invoices (Paid, Unpaid, Partial, Overdue — not Voided/Cancelled):
-- BillingPeriodStart = enrollment anchor DOM (clamped) for MONTH(BillingPeriodStart);
-- BillingPeriodEnd = EOMONTH(that month).
-- Matches open-invoice anchor script; aligns InvoiceDate, DueDate, PaymentDueDate like that script.
--
-- Non-overlap safety (prevents double-booking same calendar window):
--  1) Skip if ANY other sibling Individual invoice would overlap the NEW window (current persisted ranges).
--  2) Skip if TWO+ candidate rows share the SAME (HouseholdId, NewStartDate, NewEndDate) ("dup target").
--
-- Keeps INV-202604-0308 (Rick partial gap) untouched when it would overlap INV-202604-1163.
--
-- OUTPUT uses INTO — required when oe.Invoices has triggers (Msg 334).
-- Does NOT reschedule DIME — follow up recurring separately.
--
-- =====================================================================
-- HOW TO RUN
-- Prerequisites: Confirm session database (e.g. allaboard-prod). Prefer RW login (Invoices triggers OK with OUTPUT INTO).
--
-- LIVE (committed UPDATE): Default below is @DryRun = 0 — executes once; COMMIT returns COMMITTED_OUTPUT grid.
--
-- Preview only (no writes): Comment out LIVE line, uncomment -- DECLARE @DryRun BIT = 1;
-- =====================================================================
--
-- WHO IT APPLIES TO (#ab_target rows when committing — aligned with nightly anchor logic):
--  - Household is on an individual-only anchor (Product enrollment; active Product/Bundle enrollment gives DOM).
--  - InvoiceType Individual; Status NOT Voided/Cancelled; BillingPeriodStart set.
--  - Anchor day-of-month <> 1 and invoice period START day <> anchor (misaligned).
--

SET NOCOUNT ON;
SET XACT_ABORT ON;

-- DECLARE @DryRun BIT = 1; -- uncomment for preview-only (no commits)
DECLARE @DryRun BIT = 0;
-- =====================================================================

IF OBJECT_ID('tempdb..#ab_cand') IS NOT NULL DROP TABLE #ab_cand;
IF OBJECT_ID('tempdb..#ab_dup') IS NOT NULL DROP TABLE #ab_dup;
IF OBJECT_ID('tempdb..#ab_target') IS NOT NULL DROP TABLE #ab_target;

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
candidates AS (
  SELECT
    i.InvoiceId,
    i.InvoiceNumber,
    i.Status,
    i.HouseholdId,
    a.AnchorDom,
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
    CAST(EOMONTH(CAST(i.BillingPeriodStart AS date)) AS date) AS NewEndDate,
    CAST(i.BillingPeriodStart AS date) AS OldStartDate,
    CAST(i.BillingPeriodEnd AS date) AS OldEndDate
  FROM oe.Invoices i
  INNER JOIN anchor a ON a.HouseholdId = i.HouseholdId
  WHERE i.InvoiceType = N'Individual'
    AND i.Status NOT IN (N'Voided', N'Cancelled')
    AND i.BillingPeriodStart IS NOT NULL
    AND a.AnchorDom <> 1
    AND DAY(i.BillingPeriodStart) <> a.AnchorDom
)
SELECT
  InvoiceId,
  InvoiceNumber,
  Status,
  HouseholdId,
  AnchorDom,
  NewStartDate,
  NewEndDate,
  OldStartDate,
  OldEndDate
INTO #ab_cand
FROM candidates;

SELECT
  HouseholdId,
  NewStartDate,
  NewEndDate,
  COUNT_BIG(*) AS Cnt
INTO #ab_dup
FROM #ab_cand
GROUP BY HouseholdId, NewStartDate, NewEndDate
HAVING COUNT_BIG(*) > 1;

SELECT
  c.InvoiceId,
  c.NewStartDate,
  c.NewEndDate
INTO #ab_target
FROM #ab_cand c
WHERE NOT EXISTS (
  SELECT 1
  FROM #ab_dup d
  WHERE d.HouseholdId = c.HouseholdId
    AND d.NewStartDate = c.NewStartDate
    AND d.NewEndDate = c.NewEndDate
)
AND NOT EXISTS (
  SELECT 1
  FROM oe.Invoices j
  WHERE j.HouseholdId = c.HouseholdId
    AND j.InvoiceId <> c.InvoiceId
    AND j.InvoiceType = N'Individual'
    AND j.Status NOT IN (N'Voided', N'Cancelled')
    AND j.BillingPeriodStart IS NOT NULL
    AND j.BillingPeriodEnd IS NOT NULL
    AND CAST(j.BillingPeriodStart AS date) <= c.NewEndDate
    AND CAST(j.BillingPeriodEnd AS date) >= c.NewStartDate
);

IF (@DryRun = 1)
BEGIN
  DECLARE @u BIGINT = (SELECT COUNT(*) FROM #ab_target);
  DECLARE @sk BIGINT = (SELECT COUNT(*) FROM #ab_cand c WHERE NOT EXISTS (
    SELECT 1 FROM #ab_target t WHERE t.InvoiceId = c.InvoiceId
  ));

  SELECT
    N'ROWS_THAT_WOULD_BE_UPDATED' AS ResultSet,
    c.InvoiceNumber,
    CAST(c.HouseholdId AS NVARCHAR(36)) AS HouseholdId,
    pm.PrimaryMemberName,
    c.Status AS InvoiceStatus,
    c.AnchorDom,
    c.OldStartDate,
    c.OldEndDate,
    c.NewStartDate,
    c.NewEndDate
  FROM #ab_target t
  INNER JOIN #ab_cand c ON c.InvoiceId = t.InvoiceId
  OUTER APPLY (
    SELECT TOP 1
      NULLIF(LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))), N'') AS PrimaryMemberName
    FROM oe.Members m
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.HouseholdId = c.HouseholdId
      AND m.RelationshipType = N'P'
    ORDER BY m.CreatedDate ASC, m.MemberId ASC
  ) pm
  ORDER BY c.NewStartDate, c.InvoiceNumber;

  SELECT
    N'ROWS_SKIPPED' AS ResultSet,
    c.InvoiceNumber,
    CAST(c.HouseholdId AS NVARCHAR(36)) AS HouseholdId,
    sm.PrimaryMemberName,
    c.Status AS InvoiceStatus,
    c.AnchorDom,
    c.OldStartDate,
    c.OldEndDate,
    c.NewStartDate,
    c.NewEndDate,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM #ab_dup d
        WHERE d.HouseholdId = c.HouseholdId
          AND d.NewStartDate = c.NewStartDate
          AND d.NewEndDate = c.NewEndDate
      )
        THEN N'DUP_TARGET_SAME_MONTH'
      WHEN EXISTS (
        SELECT 1
        FROM oe.Invoices j
        WHERE j.HouseholdId = c.HouseholdId
          AND j.InvoiceId <> c.InvoiceId
          AND j.InvoiceType = N'Individual'
          AND j.Status NOT IN (N'Voided', N'Cancelled')
          AND j.BillingPeriodStart IS NOT NULL
          AND j.BillingPeriodEnd IS NOT NULL
          AND CAST(j.BillingPeriodStart AS date) <= c.NewEndDate
          AND CAST(j.BillingPeriodEnd AS date) >= c.NewStartDate
      )
        THEN N'SIBLING_PERIOD_OVERLAP'
      ELSE N'UNKNOWN_SKIP'
    END AS SkipReason
  FROM #ab_cand c
  OUTER APPLY (
    SELECT TOP 1
      NULLIF(LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))), N'') AS PrimaryMemberName
    FROM oe.Members m
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.HouseholdId = c.HouseholdId
      AND m.RelationshipType = N'P'
    ORDER BY m.CreatedDate ASC, m.MemberId ASC
  ) sm
  WHERE NOT EXISTS (SELECT 1 FROM #ab_target t WHERE t.InvoiceId = c.InvoiceId)
  ORDER BY c.NewStartDate, c.InvoiceNumber;

  SELECT
    N'DRY_RUN_SUMMARY' AS ResultSet,
    (SELECT COUNT(*) FROM #ab_cand) AS DayMismatch_Candidate_Count,
    @u AS Would_Update_Count,
    @sk AS Skipped_Count;

  DROP TABLE #ab_target;
  DROP TABLE #ab_dup;
  DROP TABLE #ab_cand;
END
ELSE
BEGIN
  DECLARE @anchorBackfill TABLE (
    InvoiceNumber NVARCHAR(64) NOT NULL,
    Old_BillingPeriodStart date NULL,
    Old_BillingPeriodEnd date NULL,
    New_BillingPeriodStart date NULL,
    New_BillingPeriodEnd date NULL,
    InvoiceStatus NVARCHAR(32) NULL
  );

  BEGIN TRY
    BEGIN TRANSACTION;

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
      CAST(inserted.BillingPeriodEnd AS date),
      inserted.Status
    INTO @anchorBackfill (
      InvoiceNumber,
      Old_BillingPeriodStart,
      Old_BillingPeriodEnd,
      New_BillingPeriodStart,
      New_BillingPeriodEnd,
      InvoiceStatus
    )
    FROM oe.Invoices i
    INNER JOIN #ab_target t ON t.InvoiceId = i.InvoiceId;

    SELECT
      N'COMMITTED_OUTPUT' AS ResultSet,
      o.InvoiceNumber,
      o.InvoiceStatus,
      o.Old_BillingPeriodStart,
      o.Old_BillingPeriodEnd,
      o.New_BillingPeriodStart,
      o.New_BillingPeriodEnd
    FROM @anchorBackfill o
    ORDER BY o.New_BillingPeriodStart, o.InvoiceNumber;

    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH;

  DROP TABLE #ab_target;
  DROP TABLE #ab_dup;
  DROP TABLE #ab_cand;
END;

/*
-- Post-run: any Individual (non-void/cancel) pairs in same household with overlapping periods?
SELECT
  CAST(i1.HouseholdId AS NVARCHAR(36)) AS HouseholdId,
  i1.InvoiceNumber AS Inv1,
  CONVERT(date, i1.BillingPeriodStart) AS S1,
  CONVERT(date, i1.BillingPeriodEnd) AS E1,
  i2.InvoiceNumber AS Inv2,
  CONVERT(date, i2.BillingPeriodStart) AS S2,
  CONVERT(date, i2.BillingPeriodEnd) AS E2
FROM oe.Invoices i1
INNER JOIN oe.Invoices i2
  ON i2.HouseholdId = i1.HouseholdId
  AND i2.InvoiceId > i1.InvoiceId
  AND i2.InvoiceType = N'Individual'
WHERE i1.InvoiceType = N'Individual'
  AND i1.Status NOT IN (N'Voided', N'Cancelled')
  AND i2.Status NOT IN (N'Voided', N'Cancelled')
  AND i1.BillingPeriodStart IS NOT NULL
  AND i1.BillingPeriodEnd IS NOT NULL
  AND i2.BillingPeriodStart IS NOT NULL
  AND i2.BillingPeriodEnd IS NOT NULL
  AND CAST(i1.BillingPeriodStart AS date) <= CAST(i2.BillingPeriodEnd AS date)
  AND CAST(i1.BillingPeriodEnd AS date) >= CAST(i2.BillingPeriodStart AS date)
ORDER BY i1.HouseholdId, i1.InvoiceNumber;
*/
