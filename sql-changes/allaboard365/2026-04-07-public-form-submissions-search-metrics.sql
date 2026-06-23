-- Public form submissions: search denorm columns, anonymous link first view, email open time, indexes.
-- Run against ShareWELL / Open Enroll database (oe schema).

IF COL_LENGTH('oe.PublicFormSubmissions', 'AnonymousLinkFirstViewedAt') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions] ADD [AnonymousLinkFirstViewedAt] DATETIME2 NULL;
END
GO

IF COL_LENGTH('oe.PublicFormSubmissions', 'RoutingEmailFirstOpenedAt') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions] ADD [RoutingEmailFirstOpenedAt] DATETIME2 NULL;
END
GO

IF COL_LENGTH('oe.PublicFormSubmissions', 'PayloadFirstName') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions] ADD [PayloadFirstName] NVARCHAR(200) NULL;
END
GO

IF COL_LENGTH('oe.PublicFormSubmissions', 'PayloadLastName') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions] ADD [PayloadLastName] NVARCHAR(200) NULL;
END
GO

IF COL_LENGTH('oe.PublicFormSubmissions', 'SearchableText') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions] ADD [SearchableText] NVARCHAR(MAX) NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PublicFormSubmissions_Tenant_CreatedDate' AND object_id = OBJECT_ID('oe.PublicFormSubmissions'))
BEGIN
    CREATE NONCLUSTERED INDEX [IX_PublicFormSubmissions_Tenant_CreatedDate]
    ON [oe].[PublicFormSubmissions]([TenantId], [CreatedDate] DESC);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PublicFormSubmissions_Tenant_Template_Created' AND object_id = OBJECT_ID('oe.PublicFormSubmissions'))
BEGIN
    CREATE NONCLUSTERED INDEX [IX_PublicFormSubmissions_Tenant_Template_Created]
    ON [oe].[PublicFormSubmissions]([TenantId], [FormTemplateId], [CreatedDate] DESC);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PublicFormSubmissions_Tenant_FirstName_LastName' AND object_id = OBJECT_ID('oe.PublicFormSubmissions'))
BEGIN
    CREATE NONCLUSTERED INDEX [IX_PublicFormSubmissions_Tenant_FirstName_LastName]
    ON [oe].[PublicFormSubmissions]([TenantId], [PayloadFirstName], [PayloadLastName])
    INCLUDE ([CreatedDate], [SubmissionId]);
END
GO
