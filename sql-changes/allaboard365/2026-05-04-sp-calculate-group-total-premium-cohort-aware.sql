-- sql-changes/allaboard365/2026-05-04-sp-calculate-group-total-premium-cohort-aware.sql
/*
  Make oe.sp_CalculateGroupTotalPremium cohort-aware.

  New optional @Cohort parameter:
    NULL          → no filter (legacy callers; full group total)
    'FIRST'       → only enrollments whose EffectiveDate day is NOT 15
                    (covers day=1 plus any grandfathered non-cohort dates)
    'FIFTEENTH'   → only enrollments whose EffectiveDate day is 15

  Mixed-cohort groups (1st-of-month + 15th-of-month households in the same
  group) call this SP twice per scheduler run — once per cohort — so each
  cohort's DIME schedule charges only its own subset of households. Without
  the filter, a mid-month group would have a single $X total that gets
  charged on both cycles, double-billing the company.

  Idempotent: ALTER replaces the body in place. Existing call sites that
  pass only @GroupId + @BillingDate keep working unchanged.
*/

ALTER PROCEDURE [oe].[sp_CalculateGroupTotalPremium]
    @GroupId UNIQUEIDENTIFIER,
    @BillingDate DATETIME2 = NULL,
    @Cohort NVARCHAR(20) = NULL
AS
BEGIN
    IF @BillingDate IS NULL
        SET @BillingDate = DATEADD(day, 5 - DAY(GETUTCDATE()), DATEADD(month, 1, GETUTCDATE()));

    DECLARE @LastDayOfMonth DATETIME2 = EOMONTH(@BillingDate);

    SELECT
        @GroupId   AS GroupId,
        @BillingDate AS BillingDate,
        @Cohort    AS Cohort,
        ISNULL(SUM(e.PremiumAmount), 0) AS TotalPremium,
        COUNT(e.EnrollmentId)           AS ActiveEnrollmentCount
    FROM oe.Enrollments e
    JOIN oe.Members m ON e.MemberId = m.MemberId
    WHERE m.GroupId = @GroupId
      AND m.RelationshipType = 'P'
      AND e.Status = 'Active'
      AND e.EffectiveDate <= @LastDayOfMonth
      AND (e.TerminationDate IS NULL OR e.TerminationDate > @LastDayOfMonth)
      AND (
        @Cohort IS NULL
        OR (@Cohort = 'FIFTEENTH' AND DAY(e.EffectiveDate) = 15)
        OR (@Cohort = 'FIRST'     AND DAY(e.EffectiveDate) <> 15)
      );
END
