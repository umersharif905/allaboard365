-- Clear invalid CommissionTierLevel / CommissionLevelId on primary agencies.
-- Primary agencies should use NULL (None — overflow only), SortOrder 5 (FMO), or 6 (Enterprise/Carrier).
-- MightyWELL Health LLC and any other primary agency with levels 0–4 (or other invalid) are reset to NULL.
--
-- Preview:
--   ./ai_scripts/db-query.sh "$(cat sql-changes/2026-05-18-clear-primary-agency-commission-tier-mightywell.sql | sed -n '/^SELECT @DryRun/,/^GO/p')"
-- Apply (set @DryRun = 0 at top, then run via db-execute):
--   ./ai_scripts/db-execute.sh sql-changes/2026-05-18-clear-primary-agency-commission-tier-mightywell.sql

DECLARE @DryRun BIT = 1;

-- Optional: scope to one tenant (MightyWELL Health tenant from prod reference)
DECLARE @TenantId UNIQUEIDENTIFIER = NULL; -- '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';

IF OBJECT_ID('tempdb..#PrimaryAgencyTierFix') IS NOT NULL DROP TABLE #PrimaryAgencyTierFix;

SELECT
    a.AgencyId,
    a.TenantId,
    a.AgencyName,
    a.IsPrimary,
    a.CommissionTierLevel AS CurrentTierLevel,
    a.CommissionLevelId AS CurrentLevelId,
    cl.SortOrder AS CurrentLevelSortOrder,
    cl.DisplayName AS CurrentLevelName
INTO #PrimaryAgencyTierFix
FROM oe.Agencies a
LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId
WHERE a.IsPrimary = 1
  AND a.Status = 'Active'
  AND (@TenantId IS NULL OR a.TenantId = @TenantId)
  AND (
    a.CommissionTierLevel IS NOT NULL
    OR a.CommissionLevelId IS NOT NULL
  )
  AND NOT (
    a.CommissionTierLevel IS NULL
    AND a.CommissionLevelId IS NULL
  )
  AND NOT (
    COALESCE(cl.SortOrder, a.CommissionTierLevel) IN (5, 6)
  );

PRINT '=== Primary agencies with invalid commission tier (will clear to NULL) ===';
SELECT * FROM #PrimaryAgencyTierFix ORDER BY AgencyName;

IF @DryRun = 1
BEGIN
  PRINT 'DRY RUN — set @DryRun = 0 to apply.';
END
ELSE
BEGIN
  UPDATE a
  SET
    a.CommissionTierLevel = NULL,
    a.CommissionLevelId = NULL,
    a.ModifiedDate = GETUTCDATE()
  FROM oe.Agencies a
  INNER JOIN #PrimaryAgencyTierFix f ON f.AgencyId = a.AgencyId;

  PRINT CONCAT('Updated ', @@ROWCOUNT, ' primary agency/agencies — tier cleared (overflow-only).');
END

DROP TABLE #PrimaryAgencyTierFix;
