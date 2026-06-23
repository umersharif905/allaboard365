'use strict';

/**
 * SQL fragments: compare invoice DueDate (calendar day) to "today" in oe.Tenants.TimeZone.
 * Uses SYSUTCDATETIME() → UTC → Windows zone (SQL Server AT TIME ZONE).
 * Unknown/empty TimeZone defaults to Eastern Standard Time.
 */

function windowsTimeZoneCaseSql(tenantAlias = 't') {
  const tz = `${tenantAlias}.TimeZone`;
  return `
  CASE LTRIM(RTRIM(ISNULL(${tz}, N'')))
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
  END`;
}

/** Today's date in tenant timezone; requires join to oe.Tenants as `tenantAlias`. */
function tenantLocalTodayDateSql(tenantAlias = 't') {
  const winTz = windowsTimeZoneCaseSql(tenantAlias);
  return `CAST((SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE (${winTz})) AS DATE)`;
}

/** i.DueDate calendar < tenant-local today. Requires JOIN oe.Tenants on TenantId (alias `t` by default). */
function invoiceDueDateBeforeTenantLocalTodayPredicate(invoiceAlias = 'i', tenantAlias = 't') {
  return `CAST(${invoiceAlias}.DueDate AS DATE) < ${tenantLocalTodayDateSql(tenantAlias)}`;
}

/** i.DueDate calendar >= tenant-local today (due today or later). Requires JOIN oe.Tenants on TenantId. */
function invoiceDueDateOnOrAfterTenantLocalTodayPredicate(invoiceAlias = 'i', tenantAlias = 't') {
  return `CAST(${invoiceAlias}.DueDate AS DATE) >= ${tenantLocalTodayDateSql(tenantAlias)}`;
}

/**
 * Open balance past due in tenant-local calendar (Unpaid, Partial, or legacy Overdue status).
 * Requires JOIN oe.Tenants AS tenantAlias on invoice.TenantId.
 */
function invoicePastDueOpenBalancePredicate(invoiceAlias = 'i', tenantAlias = 't') {
  return `(
    ${invoiceAlias}.Status IN (N'Unpaid', N'Partial', N'Overdue')
    AND ${invoiceAlias}.BalanceDue > 0.005
    AND ${invoiceDueDateBeforeTenantLocalTodayPredicate(invoiceAlias, tenantAlias)}
  )`;
}

module.exports = {
  windowsTimeZoneCaseSql,
  tenantLocalTodayDateSql,
  invoiceDueDateBeforeTenantLocalTodayPredicate,
  invoiceDueDateOnOrAfterTenantLocalTodayPredicate,
  invoicePastDueOpenBalancePredicate
};
