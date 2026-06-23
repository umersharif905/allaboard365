-- Public sharing forms: templates, versions, submissions, files, email audit
-- Run against your Open Enroll / ShareWELL database (oe schema).

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE schema_id = SCHEMA_ID('oe') AND name = 'PublicFormTemplates')
BEGIN
    CREATE TABLE [oe].[PublicFormTemplates] (
        [FormTemplateId] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        [TenantId] UNIQUEIDENTIFIER NOT NULL,
        [FormKind] NVARCHAR(50) NOT NULL,
        [Title] NVARCHAR(500) NOT NULL,
        [IsPublished] BIT NOT NULL DEFAULT 0,
        [PublishedVersion] INT NULL,
        [NotifyEmails] NVARCHAR(MAX) NULL,
        [DefaultVendorId] UNIQUEIDENTIFIER NULL,
        [AllowedFrameAncestors] NVARCHAR(MAX) NULL,
        [CreatedDate] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        [ModifiedDate] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT [FK_PublicFormTemplates_Tenant] FOREIGN KEY ([TenantId]) REFERENCES [oe].[Tenants]([TenantId]),
        CONSTRAINT [FK_PublicFormTemplates_DefaultVendor] FOREIGN KEY ([DefaultVendorId]) REFERENCES [oe].[Vendors]([VendorId]),
        CONSTRAINT [UQ_PublicFormTemplates_Tenant_Kind] UNIQUE ([TenantId], [FormKind])
    );
    CREATE INDEX [IX_PublicFormTemplates_TenantId] ON [oe].[PublicFormTemplates]([TenantId]);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE schema_id = SCHEMA_ID('oe') AND name = 'PublicFormTemplateVersions')
BEGIN
    CREATE TABLE [oe].[PublicFormTemplateVersions] (
        [VersionId] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        [FormTemplateId] UNIQUEIDENTIFIER NOT NULL,
        [VersionNumber] INT NOT NULL,
        [DefinitionJson] NVARCHAR(MAX) NOT NULL,
        [ChangeNote] NVARCHAR(500) NULL,
        [CreatedBy] UNIQUEIDENTIFIER NULL,
        [CreatedDate] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT [FK_PublicFormTemplateVersions_Template] FOREIGN KEY ([FormTemplateId]) REFERENCES [oe].[PublicFormTemplates]([FormTemplateId]) ON DELETE CASCADE,
        CONSTRAINT [FK_PublicFormTemplateVersions_CreatedBy] FOREIGN KEY ([CreatedBy]) REFERENCES [oe].[Users]([UserId]),
        CONSTRAINT [UQ_PublicFormTemplateVersions_Template_Version] UNIQUE ([FormTemplateId], [VersionNumber])
    );
    CREATE INDEX [IX_PublicFormTemplateVersions_FormTemplateId] ON [oe].[PublicFormTemplateVersions]([FormTemplateId]);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE schema_id = SCHEMA_ID('oe') AND name = 'PublicFormSubmissions')
BEGIN
    CREATE TABLE [oe].[PublicFormSubmissions] (
        [SubmissionId] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        [FormTemplateId] UNIQUEIDENTIFIER NOT NULL,
        [TenantId] UNIQUEIDENTIFIER NOT NULL,
        [FormKind] NVARCHAR(50) NOT NULL,
        [CreatedDate] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        [ClientIpHash] VARBINARY(32) NULL,
        [PayloadEncrypted] VARBINARY(MAX) NOT NULL,
        [PayloadIv] VARBINARY(16) NOT NULL,
        [PayloadAuthTag] VARBINARY(16) NOT NULL,
        [PayloadKeyId] NVARCHAR(100) NOT NULL DEFAULT N'env:v1',
        [SubmittedMemberIdText] NVARCHAR(200) NULL,
        [MemberId] UNIQUEIDENTIFIER NULL,
        [MemberMatchStatus] NVARCHAR(30) NOT NULL,
        [AmbiguousMatchCount] INT NULL,
        [ShareRequestId] UNIQUEIDENTIFIER NULL,
        [LinkedDate] DATETIME2 NULL,
        [LinkError] NVARCHAR(MAX) NULL,
        [SubmissionFingerprint] CHAR(64) NULL,
        CONSTRAINT [FK_PublicFormSubmissions_Template] FOREIGN KEY ([FormTemplateId]) REFERENCES [oe].[PublicFormTemplates]([FormTemplateId]),
        CONSTRAINT [FK_PublicFormSubmissions_Tenant] FOREIGN KEY ([TenantId]) REFERENCES [oe].[Tenants]([TenantId]),
        CONSTRAINT [FK_PublicFormSubmissions_Member] FOREIGN KEY ([MemberId]) REFERENCES [oe].[Members]([MemberId]),
        CONSTRAINT [FK_PublicFormSubmissions_ShareRequest] FOREIGN KEY ([ShareRequestId]) REFERENCES [oe].[ShareRequests]([ShareRequestId])
    );
    CREATE INDEX [IX_PublicFormSubmissions_Tenant_FormKind] ON [oe].[PublicFormSubmissions]([TenantId], [FormKind]);
    CREATE INDEX [IX_PublicFormSubmissions_MemberMatchStatus_Created] ON [oe].[PublicFormSubmissions]([MemberMatchStatus], [CreatedDate]);
    CREATE INDEX [IX_PublicFormSubmissions_ShareRequestId] ON [oe].[PublicFormSubmissions]([ShareRequestId]);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE schema_id = SCHEMA_ID('oe') AND name = 'PublicFormSubmissionFiles')
BEGIN
    CREATE TABLE [oe].[PublicFormSubmissionFiles] (
        [FileId] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        [SubmissionId] UNIQUEIDENTIFIER NOT NULL,
        [OriginalFileName] NVARCHAR(500) NOT NULL,
        [ContentType] NVARCHAR(200) NULL,
        [FileSizeBytes] BIGINT NULL,
        [BlobUrl] NVARCHAR(2000) NULL,
        [BlobPath] NVARCHAR(1000) NULL,
        [CreatedDate] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT [FK_PublicFormSubmissionFiles_Submission] FOREIGN KEY ([SubmissionId]) REFERENCES [oe].[PublicFormSubmissions]([SubmissionId]) ON DELETE CASCADE
    );
    CREATE INDEX [IX_PublicFormSubmissionFiles_SubmissionId] ON [oe].[PublicFormSubmissionFiles]([SubmissionId]);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE schema_id = SCHEMA_ID('oe') AND name = 'PublicFormEmailLog')
BEGIN
    CREATE TABLE [oe].[PublicFormEmailLog] (
        [LogId] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        [SubmissionId] UNIQUEIDENTIFIER NULL,
        [TenantId] UNIQUEIDENTIFIER NOT NULL,
        [RecipientHash] CHAR(64) NOT NULL,
        [Subject] NVARCHAR(500) NULL,
        [MessageId] NVARCHAR(200) NULL,
        [EmailType] NVARCHAR(50) NOT NULL,
        [CreatedDate] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT [FK_PublicFormEmailLog_Submission] FOREIGN KEY ([SubmissionId]) REFERENCES [oe].[PublicFormSubmissions]([SubmissionId]),
        CONSTRAINT [FK_PublicFormEmailLog_Tenant] FOREIGN KEY ([TenantId]) REFERENCES [oe].[Tenants]([TenantId])
    );
    CREATE INDEX [IX_PublicFormEmailLog_SubmissionId] ON [oe].[PublicFormEmailLog]([SubmissionId]);
END
GO

-- System user for ShareRequest / queue CreatedBy when originating from public forms (one per database)
DECLARE @PublicFormsUserId UNIQUEIDENTIFIER = 'A0000001-0000-4000-8000-000000000001';
IF NOT EXISTS (SELECT 1 FROM [oe].[Users] WHERE [UserId] = @PublicFormsUserId)
BEGIN
    DECLARE @FirstTenantId UNIQUEIDENTIFIER = (SELECT TOP 1 [TenantId] FROM [oe].[Tenants] ORDER BY [Name]);
    IF @FirstTenantId IS NOT NULL
    BEGIN
        INSERT INTO [oe].[Users] (
            [UserId], [FirstName], [LastName], [Email], [PasswordHash], [TenantId], [Status], [CreatedDate], [ModifiedDate]
        ) VALUES (
            @PublicFormsUserId,
            N'Public',
            N'Forms System',
            N'public-forms-system@internal.noreply',
            N'$2b$10$PublicFormsSystemAccountNoLoginAAAAAAAAAAAAAAAAAA',
            @FirstTenantId,
            N'Active',
            SYSUTCDATETIME(),
            SYSUTCDATETIME()
        );
        PRINT 'Inserted oe.Users row for public forms system actor.';
    END
    ELSE
        PRINT 'Skipped public forms system user: no tenants in oe.Tenants.';
END
GO
