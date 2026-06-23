-- Migration: Sync stale RecurringScheduleId on RecurringScheduled placeholder rows
-- Date: 2026-06-01
-- Author: Jeremy Francis
--
-- Context: DIME schedule recreation (credit sync / amount change) updates
-- oe.IndividualRecurringSchedules but leaves old schedule ids on placeholder
-- oe.Payments rows (Status = RecurringScheduled). Historical Completed/Failed/
-- Pending charge rows are intentionally NOT updated — they reflect the schedule
-- active when that transaction ran.
--
-- Run preview:
--   ./ai_scripts/db-query.sh "$(cat sql-changes/2026-06-01-sync-recurring-schedule-placeholder-ids.sql)" --prod-readonly
-- Execute (requires explicit approval — set @DryRun = 0):
--   ./ai_scripts/db-query.sh "$(cat sql-changes/2026-06-01-sync-recurring-schedule-placeholder-ids.sql)"

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT N'DRY RUN — rows that would be updated' AS [Status];

        SELECT
            p.PaymentId,
            u.Email,
            p.Status,
            p.RecurringScheduleId AS old_schedule_id,
            irs.DimeScheduleId AS new_schedule_id,
            irs.NextBillingDate AS new_next_billing_date,
            p.PaymentDate
        FROM oe.Payments p
        INNER JOIN oe.IndividualRecurringSchedules irs
            ON irs.HouseholdId = p.HouseholdId AND irs.IsActive = 1
        INNER JOIN oe.Members m
            ON m.HouseholdId = p.HouseholdId AND m.RelationshipType = N'P'
        INNER JOIN oe.Users u ON u.UserId = m.UserId
        WHERE p.Status = N'RecurringScheduled'
          AND p.RecurringScheduleId IS NOT NULL
          AND LTRIM(RTRIM(CAST(p.RecurringScheduleId AS NVARCHAR(255))))
              <> LTRIM(RTRIM(CAST(irs.DimeScheduleId AS NVARCHAR(255))));

        ROLLBACK TRANSACTION;
        RETURN;
    END

    UPDATE p
    SET
        p.RecurringScheduleId = LTRIM(RTRIM(CAST(irs.DimeScheduleId AS NVARCHAR(255)))),
        p.NextBillingDate = irs.NextBillingDate,
        p.ModifiedDate = GETUTCDATE()
    FROM oe.Payments p
    INNER JOIN oe.IndividualRecurringSchedules irs
        ON irs.HouseholdId = p.HouseholdId AND irs.IsActive = 1
    WHERE p.Status = N'RecurringScheduled'
      AND p.RecurringScheduleId IS NOT NULL
      AND LTRIM(RTRIM(CAST(p.RecurringScheduleId AS NVARCHAR(255))))
          <> LTRIM(RTRIM(CAST(irs.DimeScheduleId AS NVARCHAR(255))));

    SELECT
        N'Changes applied' AS [Status],
        @@ROWCOUNT AS rows_updated;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH;
