/*
  2026-05-30-share-request-ua-snapshot.sql
  Billing rework — freeze each Share Request's Unshared Amount at creation.

  WHY: The 12-month "two unshared amounts paid in full -> fully covered" rule
  must use the UA that was in force WHEN THE INCIDENT OCCURRED. A member can
  change plans (and therefore UA tier) later; reading the current plan would
  retroactively change history. So we snapshot the member-selected UA tier onto
  the Share Request at creation time and never recompute it.

  SOURCE OF TRUTH for the member's selected UA tier:
    oe.Enrollments.EnrollmentDetails (JSON) -> $.configuration
    fallback                                -> $.configValues.configValue1
  (Same extraction the vendor export + plan-modification services already use.)
  Final fallback at write time is oe.ShareRequests.MemberStatedUA (the value the
  member typed on the public form).

  Adds:
    - oe.ShareRequests.IncidentUAAmount  DECIMAL(18,2) NULL
        Frozen UA dollar amount for this incident. Populated by application code
        at SR creation; NULL for historical rows (backfilled below, best-effort).

  SAFETY: This script is DDL + a best-effort backfill. It is written dry-run
  first. Review the SELECT preview output before setting @DryRun = 0.

  Run against: allaboard-testing first, then prod after verification.
*/

SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;   -- <<< set to 0 to actually apply

-------------------------------------------------------------------------------
-- 1. Add the column (idempotent)
-------------------------------------------------------------------------------
IF @DryRun = 0
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID('oe.ShareRequests') AND name = 'IncidentUAAmount'
    )
    BEGIN
        ALTER TABLE oe.ShareRequests ADD IncidentUAAmount DECIMAL(18,2) NULL;
        PRINT 'Added oe.ShareRequests.IncidentUAAmount';
    END
    ELSE
        PRINT 'oe.ShareRequests.IncidentUAAmount already exists — skipping ADD';
END
ELSE
    PRINT '[DryRun] Would add oe.ShareRequests.IncidentUAAmount DECIMAL(18,2) NULL (if missing)';

-------------------------------------------------------------------------------
-- 2. Best-effort backfill for existing rows.
--    Resolution order per SR:
--      a) member's active/most-relevant enrollment EnrollmentDetails.configuration
--      b) ...configValues.configValue1
--      c) the SR's own MemberStatedUA (form value)
--    Only rows where a numeric UA can be derived are updated; the rest stay NULL
--    and will read via the application fallback chain.
--    NOTE: numeric-only configs (e.g. '2500') are used; non-numeric tiers like
--    'Default' are ignored (TRY_CONVERT yields NULL).
-------------------------------------------------------------------------------
;WITH MemberUA AS (
    SELECT
        sr.ShareRequestId,
        TRY_CONVERT(DECIMAL(18,2),
            COALESCE(
                NULLIF(JSON_VALUE(e.EnrollmentDetails, '$.configuration'), 'Default'),
                JSON_VALUE(e.EnrollmentDetails, '$.configValues.configValue1'),
                sr.MemberStatedUA
            )
        ) AS ResolvedUA,
        ROW_NUMBER() OVER (
            PARTITION BY sr.ShareRequestId
            ORDER BY
                CASE WHEN e.Status NOT IN ('Terminated','Inactive') THEN 0 ELSE 1 END,
                e.EffectiveDate DESC
        ) AS rn
    FROM oe.ShareRequests sr
    LEFT JOIN oe.Enrollments e
        ON e.MemberId = sr.MemberId
       AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= COALESCE(sr.DateOfService, sr.SubmittedDate, sr.CreatedDate))
)
-- Preview is column-independent (does NOT reference IncidentUAAmount) so it runs
-- in dry-run before the column exists. The IncidentUAAmount IS NULL guard is
-- applied only in the live UPDATE below, where the column is guaranteed present.
SELECT
    sr.ShareRequestId,
    sr.RequestNumber,
    sr.MemberStatedUA,
    mua.ResolvedUA AS WouldSetIncidentUAAmount
INTO #ua_backfill_preview
FROM oe.ShareRequests sr
LEFT JOIN MemberUA mua ON mua.ShareRequestId = sr.ShareRequestId AND mua.rn = 1;

PRINT 'Backfill preview (rows that WOULD be set, non-NULL only):';
SELECT TOP 100 * FROM #ua_backfill_preview WHERE WouldSetIncidentUAAmount IS NOT NULL;

SELECT
    COUNT(*) AS total_rows,
    SUM(CASE WHEN WouldSetIncidentUAAmount IS NOT NULL THEN 1 ELSE 0 END) AS resolvable_rows
FROM #ua_backfill_preview;

IF @DryRun = 0
BEGIN
    -- Built dynamically so this whole script still parses before the column
    -- exists (a static reference to a missing column fails compile of the batch).
    EXEC sp_executesql N'
        UPDATE sr
        SET sr.IncidentUAAmount = p.WouldSetIncidentUAAmount
        FROM oe.ShareRequests sr
        INNER JOIN #ua_backfill_preview p ON p.ShareRequestId = sr.ShareRequestId
        WHERE p.WouldSetIncidentUAAmount IS NOT NULL
          AND sr.IncidentUAAmount IS NULL;
        DECLARE @n INT = @@ROWCOUNT;
        PRINT CONCAT(''Backfilled '', @n, '' Share Requests with IncidentUAAmount'');';
END
ELSE
    PRINT '[DryRun] No writes performed. Review preview above, then set @DryRun = 0.';

DROP TABLE #ua_backfill_preview;
