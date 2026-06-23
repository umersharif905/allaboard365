/*
  Remove the three auto-seeded public form templates from Pinnacle Life Group only
  (UnsharedAmount, AdditionalDocuments, PreventiveCare) when they have no submissions.

  Tenant: Pinnacle Life Group — 55EB7262-4DB6-4614-82A8-23FC2E91203B
  Versions delete via FK cascade. Submissions must be zero or this will skip/delete nothing.
*/

SET NOCOUNT ON;

DECLARE @PinnacleTenantId UNIQUEIDENTIFIER = '55EB7262-4DB6-4614-82A8-23FC2E91203B';

BEGIN TRY
    BEGIN TRAN;

    IF EXISTS (
        SELECT 1
        FROM oe.PublicFormTemplates AS t
        INNER JOIN oe.PublicFormSubmissions AS s ON s.FormTemplateId = t.FormTemplateId
        WHERE t.TenantId = @PinnacleTenantId
          AND t.FormKind IN (N'UnsharedAmount', N'AdditionalDocuments', N'PreventiveCare')
    )
    BEGIN
        RAISERROR ('Abort: at least one Pinnacle default template has submissions. Remove or migrate them first.', 16, 1);
        ROLLBACK TRAN;
        RETURN;
    END

    DELETE t
    FROM oe.PublicFormTemplates AS t
    WHERE t.TenantId = @PinnacleTenantId
      AND t.FormKind IN (N'UnsharedAmount', N'AdditionalDocuments', N'PreventiveCare');

    PRINT CONCAT(N'Deleted Pinnacle default templates: ', @@ROWCOUNT, N' row(s).');
    COMMIT TRAN;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRAN;
    THROW;
END CATCH;
