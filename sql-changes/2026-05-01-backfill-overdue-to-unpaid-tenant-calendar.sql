/*
  One-time backfill after tenant-timezone overdue semantics (DueDate vs tenant-local "today").

  Resets invoices from Overdue → Unpaid when the due date (calendar) is still on or after
  the tenant's local date (oe.Tenants.TimeZone → SQL AT TIME ZONE; unknown → Eastern).

  Run during a maintenance window; review row counts in a transaction first if desired.
*/

UPDATE i
SET
  i.Status = N'Unpaid',
  i.ModifiedDate = SYSUTCDATETIME()
FROM oe.Invoices i
INNER JOIN oe.Tenants t ON t.TenantId = i.TenantId
WHERE i.Status = N'Overdue'
  AND CAST(i.DueDate AS DATE) >= CAST((
        SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE (
          CASE LTRIM(RTRIM(ISNULL(t.TimeZone, N'')))
            WHEN N'' THEN N'Eastern Standard Time'
            WHEN N'America/New_York' THEN N'Eastern Standard Time'
            WHEN N'America/Detroit' THEN N'Eastern Standard Time'
            WHEN N'America/Kentucky/Louisville' THEN N'Eastern Standard Time'
            WHEN N'America/Indiana/Indianapolis' THEN N'Eastern Standard Time'
            WHEN N'America/Chicago' THEN N'Central Standard Time'
            WHEN N'America/Denver' THEN N'Mountain Standard Time'
            WHEN N'America/Los_Angeles' THEN N'Pacific Standard Time'
            WHEN N'America/Phoenix' THEN N'US Mountain Standard Time'
            WHEN N'America/Anchorage' THEN N'Alaskan Standard Time'
            WHEN N'Pacific/Honolulu' THEN N'Hawaiian Standard Time'
            ELSE N'Eastern Standard Time'
          END
        )
      ) AS DATE);
