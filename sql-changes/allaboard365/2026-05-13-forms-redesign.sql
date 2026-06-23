-- Forms redesign: delivery-mode flags on templates, optional Case/auth/invitation
-- linkage on submissions, plain-text identity fields for cheap diff display,
-- and the new PublicFormInvitations table for "send to member" flows.
--
-- Spec: docs/superpowers/specs/2026-05-13-forms-redesign/design.md
-- Run against your Open Enroll / ShareWELL database (oe schema). Idempotent.

-- 1. PublicFormTemplates: delivery-mode flags + auto-SR flag --------------------

IF COL_LENGTH('oe.PublicFormTemplates', 'AllowAnonymous') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormTemplates]
    ADD [AllowAnonymous] BIT NOT NULL
        CONSTRAINT [DF_PublicFormTemplates_AllowAnonymous] DEFAULT 1;
END
GO

IF COL_LENGTH('oe.PublicFormTemplates', 'AllowTargeted') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormTemplates]
    ADD [AllowTargeted] BIT NOT NULL
        CONSTRAINT [DF_PublicFormTemplates_AllowTargeted] DEFAULT 0;
END
GO

IF COL_LENGTH('oe.PublicFormTemplates', 'AllowAuthenticated') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormTemplates]
    ADD [AllowAuthenticated] BIT NOT NULL
        CONSTRAINT [DF_PublicFormTemplates_AllowAuthenticated] DEFAULT 0;
END
GO

IF COL_LENGTH('oe.PublicFormTemplates', 'CreatesShareRequestOnSubmit') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormTemplates]
    ADD [CreatesShareRequestOnSubmit] BIT NOT NULL
        CONSTRAINT [DF_PublicFormTemplates_CreatesShareRequestOnSubmit] DEFAULT 0;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE name = 'CK_PublicFormTemplates_AtLeastOneMode'
      AND parent_object_id = OBJECT_ID('oe.PublicFormTemplates')
)
BEGIN
    ALTER TABLE [oe].[PublicFormTemplates]
    ADD CONSTRAINT [CK_PublicFormTemplates_AtLeastOneMode]
        CHECK ([AllowAnonymous] = 1 OR [AllowTargeted] = 1 OR [AllowAuthenticated] = 1);
END
GO

-- Backfill: the two existing SR-intake templates keep their auto-create behavior.
-- Custom-kind templates and AdditionalDocuments remain at the default (0).
UPDATE [oe].[PublicFormTemplates]
SET [CreatesShareRequestOnSubmit] = 1
WHERE [FormKind] IN ('UnsharedAmount', 'PreventiveCare')
  AND [CreatesShareRequestOnSubmit] = 0;
GO

-- 2. PublicFormSubmissions: Case + AuthMode + Invitation + plaintext diff fields

IF COL_LENGTH('oe.PublicFormSubmissions', 'CaseId') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions]
    ADD [CaseId] UNIQUEIDENTIFIER NULL;
END
GO

IF COL_LENGTH('oe.PublicFormSubmissions', 'AuthMode') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions]
    ADD [AuthMode] NVARCHAR(20) NULL;
END
GO

IF COL_LENGTH('oe.PublicFormSubmissions', 'InvitationId') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions]
    ADD [InvitationId] UNIQUEIDENTIFIER NULL;
END
GO

IF COL_LENGTH('oe.PublicFormSubmissions', 'PayloadEmail') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions]
    ADD [PayloadEmail] NVARCHAR(254) NULL;
END
GO

IF COL_LENGTH('oe.PublicFormSubmissions', 'PayloadPhone') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions]
    ADD [PayloadPhone] NVARCHAR(50) NULL;
END
GO

-- 3. PublicFormInvitations: new table -----------------------------------------

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE schema_id = SCHEMA_ID('oe') AND name = 'PublicFormInvitations')
BEGIN
    CREATE TABLE [oe].[PublicFormInvitations] (
        [InvitationId] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        [TenantId] UNIQUEIDENTIFIER NOT NULL,
        [FormTemplateId] UNIQUEIDENTIFIER NOT NULL,
        [MemberId] UNIQUEIDENTIFIER NOT NULL,
        [Mode] NVARCHAR(20) NOT NULL,
        [LinkedShareRequestId] UNIQUEIDENTIFIER NULL,
        [LinkedCaseId] UNIQUEIDENTIFIER NULL,
        [TokenHash] CHAR(64) NOT NULL,
        [ExpiresAt] DATETIME2 NOT NULL,
        [FirstUsedAt] DATETIME2 NULL,
        [DeliveryMethod] NVARCHAR(20) NOT NULL,
        [RevokedAt] DATETIME2 NULL,
        [SentByUserId] UNIQUEIDENTIFIER NOT NULL,
        [SentToEmail] NVARCHAR(254) NOT NULL,
        [CreatedDate] DATETIME2 NOT NULL CONSTRAINT [DF_PublicFormInvitations_CreatedDate] DEFAULT SYSUTCDATETIME(),
        CONSTRAINT [FK_PublicFormInvitations_Tenant]
            FOREIGN KEY ([TenantId]) REFERENCES [oe].[Tenants]([TenantId]),
        CONSTRAINT [FK_PublicFormInvitations_Template]
            FOREIGN KEY ([FormTemplateId]) REFERENCES [oe].[PublicFormTemplates]([FormTemplateId]),
        CONSTRAINT [FK_PublicFormInvitations_Member]
            FOREIGN KEY ([MemberId]) REFERENCES [oe].[Members]([MemberId]),
        CONSTRAINT [FK_PublicFormInvitations_ShareRequest]
            FOREIGN KEY ([LinkedShareRequestId]) REFERENCES [oe].[ShareRequests]([ShareRequestId]),
        CONSTRAINT [FK_PublicFormInvitations_SentBy]
            FOREIGN KEY ([SentByUserId]) REFERENCES [oe].[Users]([UserId]),
        CONSTRAINT [CK_PublicFormInvitations_Mode]
            CHECK ([Mode] IN ('targeted', 'authenticated')),
        CONSTRAINT [CK_PublicFormInvitations_DeliveryMethod]
            CHECK ([DeliveryMethod] IN ('email', 'copy', 'both'))
    );
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('oe.PublicFormInvitations')
      AND name = 'UQ_PublicFormInvitations_TokenHash'
)
BEGIN
    CREATE UNIQUE INDEX [UQ_PublicFormInvitations_TokenHash]
    ON [oe].[PublicFormInvitations]([TokenHash]);
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('oe.PublicFormInvitations')
      AND name = 'IX_PublicFormInvitations_TenantMember'
)
BEGIN
    CREATE INDEX [IX_PublicFormInvitations_TenantMember]
    ON [oe].[PublicFormInvitations]([TenantId], [MemberId]);
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('oe.PublicFormInvitations')
      AND name = 'IX_PublicFormInvitations_LinkedSR'
)
BEGIN
    CREATE INDEX [IX_PublicFormInvitations_LinkedSR]
    ON [oe].[PublicFormInvitations]([LinkedShareRequestId])
    WHERE [LinkedShareRequestId] IS NOT NULL;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('oe.PublicFormInvitations')
      AND name = 'IX_PublicFormInvitations_FormTemplate'
)
BEGIN
    CREATE INDEX [IX_PublicFormInvitations_FormTemplate]
    ON [oe].[PublicFormInvitations]([FormTemplateId], [CreatedDate] DESC);
END
GO

-- 4. FK back from PublicFormSubmissions.InvitationId ---------------------------

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_PublicFormSubmissions_Invitation'
)
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions]
    ADD CONSTRAINT [FK_PublicFormSubmissions_Invitation]
    FOREIGN KEY ([InvitationId]) REFERENCES [oe].[PublicFormInvitations]([InvitationId]);
END
GO

-- 5. Indexes supporting new lookups on submissions ----------------------------

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('oe.PublicFormSubmissions')
      AND name = 'IX_PublicFormSubmissions_InvitationId'
)
BEGIN
    CREATE INDEX [IX_PublicFormSubmissions_InvitationId]
    ON [oe].[PublicFormSubmissions]([InvitationId])
    WHERE [InvitationId] IS NOT NULL;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('oe.PublicFormSubmissions')
      AND name = 'IX_PublicFormSubmissions_MemberId_Created'
)
BEGIN
    CREATE INDEX [IX_PublicFormSubmissions_MemberId_Created]
    ON [oe].[PublicFormSubmissions]([MemberId], [CreatedDate] DESC)
    WHERE [MemberId] IS NOT NULL;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('oe.PublicFormSubmissions')
      AND name = 'IX_PublicFormSubmissions_CaseId'
)
BEGIN
    CREATE INDEX [IX_PublicFormSubmissions_CaseId]
    ON [oe].[PublicFormSubmissions]([CaseId])
    WHERE [CaseId] IS NOT NULL;
END
GO
