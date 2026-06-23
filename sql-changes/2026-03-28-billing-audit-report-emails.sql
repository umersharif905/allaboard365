-- Per-tenant comma-separated recipients for the nightly billing audit email (Tenant Billing → Audit → settings).
IF COL_LENGTH('oe.Tenants', 'BillingAuditReportEmails') IS NULL
BEGIN
  ALTER TABLE oe.Tenants ADD BillingAuditReportEmails NVARCHAR(MAX) NULL;
END
GO
