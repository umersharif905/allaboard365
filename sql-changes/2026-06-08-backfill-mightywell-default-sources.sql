/* 2026-06-08-backfill-mightywell-default-sources.sql
   One-off backfill: give every ACTIVE agent in the MightyWELL tenant a default
   ProspectSources row for each configured 'website' destination (Home + Quote).
   Idempotent (NOT EXISTS guard). DRY-RUN by default: set @DryRun = 0 to apply. */
SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;   -- <<< set to 0 to actually apply
DECLARE @TenantId UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826'; -- MightyWELL Health

IF OBJECT_ID('tempdb..#webdests') IS NOT NULL DROP TABLE #webdests;
IF OBJECT_ID('tempdb..#candidates') IS NOT NULL DROP TABLE #candidates;

SELECT JSON_VALUE(d.value, '$.label') AS Label,
       JSON_VALUE(d.value, '$.url')   AS Url
INTO #webdests
FROM oe.Tenants t
CROSS APPLY OPENJSON(JSON_QUERY(t.AdvancedSettings, '$.marketingLink.destinations')) d
WHERE t.TenantId = @TenantId
  AND JSON_VALUE(d.value, '$.type') = 'website'
  AND JSON_VALUE(d.value, '$.url') IS NOT NULL;

SELECT a.AgentId, w.Label, w.Url
INTO #candidates
FROM oe.Agents a
CROSS JOIN #webdests w
WHERE a.TenantId = @TenantId AND a.Status = 'Active'
  AND NOT EXISTS (
    SELECT 1 FROM oe.ProspectSources ps
    WHERE ps.TenantId = @TenantId AND ps.AgentId = a.AgentId
      AND ps.IsDefault = 1 AND ps.DestinationUrl = w.Url
  );

IF @DryRun = 1
BEGIN
  PRINT 'DRY RUN. Rows that WOULD be inserted (agent x website-destination):';
  SELECT (SELECT COUNT(*) FROM #candidates) AS RowsToInsert,
         (SELECT COUNT(*) FROM #webdests)   AS WebsiteDestinations,
         (SELECT COUNT(*) FROM oe.Agents WHERE TenantId = @TenantId AND Status = 'Active') AS ActiveAgents;
  DROP TABLE #webdests; DROP TABLE #candidates;
  RETURN;
END

INSERT INTO oe.ProspectSources
  (SourceId, TenantId, AgentId, Name, Type, DestinationUrl, LinkCode, IsDefault, Status, CreatedDate, ModifiedDate)
SELECT NEWID(), @TenantId, c.AgentId, COALESCE(c.Label, 'MightyWELL Website'), 'website', c.Url, NULL, 1, 'active', GETUTCDATE(), GETUTCDATE()
FROM #candidates c;

DECLARE @inserted INT = @@ROWCOUNT;
DROP TABLE #webdests; DROP TABLE #candidates;
PRINT CONCAT('Applied. Inserted ', @inserted, ' default source rows.');
