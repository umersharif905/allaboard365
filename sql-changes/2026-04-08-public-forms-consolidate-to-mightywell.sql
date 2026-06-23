/*
  Consolidate public form templates so the default sharing forms (and custom K_* forms)
  exist only under MightyWELL Health (or a tenant you set below).

  Why not one UPDATE?
  - UQ_PublicFormTemplates: UNIQUE (TenantId, FormKind)
  - The three built-in kinds (UnsharedAmount, AdditionalDocuments, PreventiveCare) exist once
    per tenant; you cannot set every row’s TenantId to MightyWELL without removing duplicates first.

  Safe deletes only remove templates with zero rows in oe.PublicFormSubmissions.
  If a duplicate template has submissions, the script skips deleting it and prints a note — fix manually.

  PREVIEW in a transaction: run with BEGIN TRAN / ROLLBACK first if unsure.
*/

SET NOCOUNT ON;

DECLARE @MightyTenantId UNIQUEIDENTIFIER =
    (SELECT TOP 1 TenantId FROM oe.Tenants WHERE Name = N'MightyWELL Health');

IF @MightyTenantId IS NULL
BEGIN
    RAISERROR ('Tenant MightyWELL Health not found in oe.Tenants. Set @MightyTenantId manually.', 16, 1);
    RETURN;
END

PRINT CONCAT('Target tenant: MightyWELL Health (', CAST(@MightyTenantId AS NVARCHAR(36)), N')');

DECLARE @FixedKinds TABLE (FormKind NVARCHAR(50) NOT NULL PRIMARY KEY);
INSERT INTO @FixedKinds (FormKind) VALUES
    (N'UnsharedAmount'),
    (N'AdditionalDocuments'),
    (N'PreventiveCare');

BEGIN TRY
    BEGIN TRAN;

    /* ---- 1) Fixed kinds: remove duplicates where MightyWELL already has that FormKind ---- */
    DELETE t
    FROM oe.PublicFormTemplates AS t
    INNER JOIN oe.PublicFormTemplates AS m
        ON m.TenantId = @MightyTenantId
       AND m.FormKind = t.FormKind
    INNER JOIN @FixedKinds AS fk ON fk.FormKind = t.FormKind
    WHERE t.TenantId <> @MightyTenantId
      AND NOT EXISTS (
          SELECT 1 FROM oe.PublicFormSubmissions AS s WHERE s.FormTemplateId = t.FormTemplateId
      );

    DECLARE @DelFixed INT = @@ROWCOUNT;
    PRINT CONCAT('Deleted ', @DelFixed, N' duplicate fixed-kind templates (MightyWELL already had that kind; no submissions).');

    /* ---- 2) Fixed kinds: if MightyWELL missing a kind, move one surviving row from another tenant ---- */
    DECLARE @Kind NVARCHAR(50);
    DECLARE kind_cur CURSOR LOCAL FAST_FORWARD FOR
        SELECT fk.FormKind FROM @FixedKinds AS fk
        WHERE NOT EXISTS (
            SELECT 1 FROM oe.PublicFormTemplates AS m
            WHERE m.TenantId = @MightyTenantId AND m.FormKind = fk.FormKind
        );
    OPEN kind_cur;
    FETCH NEXT FROM kind_cur INTO @Kind;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        DECLARE @Pick UNIQUEIDENTIFIER = (
            SELECT TOP 1 x.FormTemplateId
            FROM oe.PublicFormTemplates AS x
            WHERE x.FormKind = @Kind
              AND x.TenantId <> @MightyTenantId
            ORDER BY x.CreatedDate ASC
        );
        IF @Pick IS NOT NULL
        BEGIN
            UPDATE oe.PublicFormTemplates
            SET TenantId = @MightyTenantId, ModifiedDate = SYSUTCDATETIME()
            WHERE FormTemplateId = @Pick;
            PRINT CONCAT(N'Reassigned template ', CAST(@Pick AS NVARCHAR(36)), N' (', @Kind, N') to MightyWELL.');
        END
        FETCH NEXT FROM kind_cur INTO @Kind;
    END
    CLOSE kind_cur;
    DEALLOCATE kind_cur;

    /* ---- 3) Fixed kinds: delete any remaining non-MightyWELL rows (no submissions) ---- */
    DELETE t
    FROM oe.PublicFormTemplates AS t
    INNER JOIN @FixedKinds AS fk ON fk.FormKind = t.FormKind
    WHERE t.TenantId <> @MightyTenantId
      AND NOT EXISTS (
          SELECT 1 FROM oe.PublicFormSubmissions AS s WHERE s.FormTemplateId = t.FormTemplateId
      );

    SET @DelFixed = @@ROWCOUNT;
    PRINT CONCAT('Deleted ', @DelFixed, N' remaining fixed-kind templates on other tenants (no submissions).');

    /* ---- 4) Custom forms (FormKind like K_%): move all to MightyWELL (unique per row; no FormKind collision) ---- */
    UPDATE pft
    SET TenantId = @MightyTenantId, ModifiedDate = SYSUTCDATETIME()
    FROM oe.PublicFormTemplates AS pft
    WHERE pft.TenantId <> @MightyTenantId
      AND pft.FormKind NOT IN (SELECT FormKind FROM @FixedKinds);

    PRINT CONCAT(N'Updated custom templates (non-fixed kinds) to MightyWELL: ', @@ROWCOUNT, N' row(s).');

    /* ---- 5) Align submission tenant with template tenant ---- */
    UPDATE s
    SET TenantId = pft.TenantId
    FROM oe.PublicFormSubmissions AS s
    INNER JOIN oe.PublicFormTemplates AS pft ON pft.FormTemplateId = s.FormTemplateId
    WHERE s.TenantId <> pft.TenantId;

    PRINT CONCAT(N'Aligned PublicFormSubmissions.TenantId to template tenant: ', @@ROWCOUNT, N' row(s).');

    /* ---- 6) Warnings: fixed-kind templates still on other tenants (usually has submissions) ---- */
    IF EXISTS (
        SELECT 1
        FROM oe.PublicFormTemplates AS t
        INNER JOIN @FixedKinds AS fk ON fk.FormKind = t.FormKind
        WHERE t.TenantId <> @MightyTenantId
    )
    BEGIN
        PRINT N'WARNING: Some fixed-kind templates remain on non-MightyWELL tenants (often due to submissions). Review:';
        SELECT t.TenantId,
               tn.Name AS TenantName,
               t.FormTemplateId,
               t.FormKind,
               t.Title,
               (SELECT COUNT(*) FROM oe.PublicFormSubmissions AS s WHERE s.FormTemplateId = t.FormTemplateId) AS SubmissionCount
        FROM oe.PublicFormTemplates AS t
        INNER JOIN oe.Tenants AS tn ON tn.TenantId = t.TenantId
        INNER JOIN @FixedKinds AS fk ON fk.FormKind = t.FormKind
        WHERE t.TenantId <> @MightyTenantId;
    END

    COMMIT TRAN;
    PRINT N'Done. Committed.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRAN;
    THROW;
END CATCH;
