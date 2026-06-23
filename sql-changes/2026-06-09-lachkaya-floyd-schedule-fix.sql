-- Migration: Correct two remaining IndividualRecurringSchedules amount mismatches
-- Date: 2026-06-09
-- Author: Jeremy Francis
--
-- Anna Lachkaya: schedule $945.37 vs correct PremiumSum $940.40 (+$4.97 fee-bump residue).
--   June invoice billed/paid at $940.40 — schedule-only fix, no credit.
-- Rhonda Floyd: schedule $851.99 vs current PremiumSum $844.39 (admin enrollment edit 6/8).
--   June paid at $851.99 before edit — align schedule going forward, no credit.
--
-- IMPORTANT: Local DB change only. Backend DIME heal must propagate before 7/1 billing.

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @Now DATETIME2 = GETUTCDATE();

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID('tempdb..#Targets') IS NOT NULL DROP TABLE #Targets;

    ------------------------------------------------------------------
    -- Build target list: schedule id, household, current amount, target
    ------------------------------------------------------------------
    SELECT
        irs.ScheduleId,
        irs.HouseholdId,
        LTRIM(RTRIM(CONCAT(COALESCE(NULLIF(u.FirstName, N''), N''), N' ', COALESCE(NULLIF(u.LastName, N''), N'')))) AS MemberLabel,
        irs.DimeScheduleId,
        irs.MonthlyAmount AS CurrentAmount,
        CAST(ps.PremiumSum AS DECIMAL(18,2)) AS TargetAmount
    INTO #Targets
    FROM oe.IndividualRecurringSchedules irs
    INNER JOIN oe.Members m ON m.HouseholdId = irs.HouseholdId AND m.RelationshipType = N'P'
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    CROSS APPLY (
        SELECT CAST(SUM(e.PremiumAmount) AS DECIMAL(18,2)) AS PremiumSum
        FROM oe.Enrollments e
        WHERE e.HouseholdId = irs.HouseholdId
          AND e.Status NOT IN (N'Cancelled', N'Declined')
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
    ) ps
    WHERE irs.IsActive = 1
      AND irs.ScheduleId IN (
          N'CC81E705-BE13-4828-805B-9549B0EAE829',  -- Anna Lachkaya
          N'8EF47874-13D1-4331-B7A2-15078633DD09'   -- Rhonda Floyd
      )
      AND ABS(irs.MonthlyAmount - ps.PremiumSum) > 0.005;

    ------------------------------------------------------------------
    -- Preview
    ------------------------------------------------------------------
    SELECT
        MemberLabel,
        HouseholdId,
        ScheduleId,
        DimeScheduleId,
        CurrentAmount,
        TargetAmount,
        CAST(CurrentAmount - TargetAmount AS DECIMAL(18,2)) AS Delta
    FROM #Targets
    ORDER BY MemberLabel;

    IF @DryRun = 1
    BEGIN
        PRINT 'DRY RUN — no schedule rows updated. Set @DryRun = 0 to apply.';
        ROLLBACK TRANSACTION;
        RETURN;
    END

    ------------------------------------------------------------------
    -- Apply: guarded by exact current amount (no-op if data shifted)
    ------------------------------------------------------------------
    UPDATE irs
    SET irs.MonthlyAmount = t.TargetAmount,
        irs.ModifiedDate = @Now
    FROM oe.IndividualRecurringSchedules irs
    INNER JOIN #Targets t ON t.ScheduleId = irs.ScheduleId
    WHERE irs.IsActive = 1
      AND ABS(irs.MonthlyAmount - t.CurrentAmount) <= 0.005;

    PRINT CONCAT('Schedules updated: ', @@ROWCOUNT);

    COMMIT TRANSACTION;
    PRINT 'Committed. Verify DIME heal sync before July 1 billing.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
