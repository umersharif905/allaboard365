-- 2026-05-29 Public form drafts — signed-in member draft autosave + staged files.
--
-- oe.PublicFormDrafts      : one in-progress submission per (owner, form, for-member),
--                            payload encrypted with the same scheme as
--                            oe.PublicFormSubmissions (publicFormCrypto).
-- oe.PublicFormDraftFiles  : files staged to Azure blob while a draft is open;
--                            promoted into the submission on final submit, or
--                            purged when the draft is deleted.
--
-- Idempotent (IF NOT EXISTS). Additive only — no existing table is touched.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE schema_id = SCHEMA_ID('oe') AND name = 'PublicFormDrafts')
BEGIN
    CREATE TABLE [oe].[PublicFormDrafts] (
        [DraftId] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        [TenantId] UNIQUEIDENTIFIER NOT NULL,
        [FormTemplateId] UNIQUEIDENTIFIER NOT NULL,
        [OwnerUserId] UNIQUEIDENTIFIER NOT NULL,
        [ForMemberId] UNIQUEIDENTIFIER NULL,
        [HouseholdId] UNIQUEIDENTIFIER NULL,
        [PayloadEncrypted] VARBINARY(MAX) NULL,
        [PayloadIv] VARBINARY(16) NULL,
        [PayloadAuthTag] VARBINARY(16) NULL,
        [PayloadKeyId] NVARCHAR(100) NULL,
        [CreatedDate] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        [UpdatedDate] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT [FK_PublicFormDrafts_Template] FOREIGN KEY ([FormTemplateId]) REFERENCES [oe].[PublicFormTemplates]([FormTemplateId]),
        CONSTRAINT [FK_PublicFormDrafts_Tenant] FOREIGN KEY ([TenantId]) REFERENCES [oe].[Tenants]([TenantId])
    );
    -- One active draft per owner + form + subject member. (NULLs compare equal in
    -- a unique index, so a single draft is allowed when ForMemberId is NULL.)
    CREATE UNIQUE INDEX [UQ_PublicFormDrafts_Owner_Template_Member]
        ON [oe].[PublicFormDrafts]([OwnerUserId], [FormTemplateId], [ForMemberId]);
    CREATE INDEX [IX_PublicFormDrafts_Household] ON [oe].[PublicFormDrafts]([HouseholdId]);
    CREATE INDEX [IX_PublicFormDrafts_Tenant_Updated] ON [oe].[PublicFormDrafts]([TenantId], [UpdatedDate]);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE schema_id = SCHEMA_ID('oe') AND name = 'PublicFormDraftFiles')
BEGIN
    CREATE TABLE [oe].[PublicFormDraftFiles] (
        [DraftFileId] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        [DraftId] UNIQUEIDENTIFIER NOT NULL,
        [FieldName] NVARCHAR(200) NOT NULL,
        [OriginalFileName] NVARCHAR(500) NOT NULL,
        [ContentType] NVARCHAR(200) NULL,
        [FileSizeBytes] BIGINT NULL,
        [BlobUrl] NVARCHAR(2000) NULL,
        [BlobPath] NVARCHAR(1000) NULL,
        [CreatedDate] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT [FK_PublicFormDraftFiles_Draft] FOREIGN KEY ([DraftId]) REFERENCES [oe].[PublicFormDrafts]([DraftId]) ON DELETE CASCADE
    );
    CREATE INDEX [IX_PublicFormDraftFiles_DraftId] ON [oe].[PublicFormDraftFiles]([DraftId]);
END
GO
