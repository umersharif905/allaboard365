/*
  Remove the three auto-seeded public form templates from ONE tenant (by name),
  when SubmissionCount = 0 for each.

  Edit @TenantName if needed. MightyWELL-only seeding: set in backend .env:
    PUBLIC_FORMS_DEFAULT_SEED_TENANT_IDS=<mightywell-guid>
  and restart, or other tenants will get the three forms again on next Forms page load.
*/

SET NOCOUNT ON;

DECLARE @TenantName NVARCHAR(200) = N'ShareWELL Health';
DECLARE @TenantId UNIQUEIDENTIFIER =
    (SELECT TOP 1 TenantId FROM oe.Tenants WHERE Name = @TenantName);

IF @TenantId IS NULL
BEGIN
    RAISERROR ('Tenant not found. Check Name in oe.Tenants.', 16, 1);
    RETURN;
END

PRINT CONCAT(N'Target: ', @TenantName, N' (', CAST(@TenantId AS NVARCHAR(36)), N')');

BEGIN TRY
    BEGIN TRAN;

    IF EXISTS (
        SELECT 1
        FROM oe.PublicFormTemplates AS t
        INNER JOIN oe.PublicFormSubmissions AS s ON s.FormTemplateId = t.FormTemplateId
        WHERE t.TenantId = @TenantId
          AND t.FormKind IN (N'UnsharedAmount', N'AdditionalDocuments', N'PreventiveCare')
    )
    BEGIN
        RAISERROR ('Abort: at least one default template has submissions.', 16, 1);
        ROLLBACK TRAN;
        RETURN;
    END

    DELETE t
    FROM oe.PublicFormTemplates AS t
    WHERE t.TenantId = @TenantId
      AND t.FormKind IN (N'UnsharedAmount', N'AdditionalDocuments', N'PreventiveCare');

    PRINT CONCAT(N'Deleted: ', @@ROWCOUNT, N' row(s).');
    COMMIT TRAN;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRAN;
    THROW;
END CATCH;
