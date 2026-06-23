-- Purpose: per-member direct-deposit bank info captured from public sharing forms
-- (and tenant-admin manual entry). Distinct from oe.ProductOverrideACH /
-- oe.TenantPayoutACH, which represent money flowing INTO the system. This
-- table represents the member's reimbursement destination — money flowing
-- OUT to the member after an approved share request.
--
-- One row = one bank account. A member can have many history rows but only
-- one with IsActive=1 at a time (enforced by filtered unique index).
-- Encryption: AES-256-GCM via backend/services/encryptionService.js,
-- same column shape as oe.ProductOverrideACH.

IF NOT EXISTS (
    SELECT 1 FROM sys.tables
    WHERE object_id = OBJECT_ID('oe.MemberDirectDeposits')
)
BEGIN
    CREATE TABLE [oe].[MemberDirectDeposits] (
        [DirectDepositId]            UNIQUEIDENTIFIER NOT NULL CONSTRAINT [PK_MemberDirectDeposits] PRIMARY KEY DEFAULT NEWID(),
        [MemberId]                   UNIQUEIDENTIFIER NOT NULL,
        [TenantId]                   UNIQUEIDENTIFIER NOT NULL,
        [AccountHolderName]          NVARCHAR(200)    NOT NULL,
        [BankName]                   NVARCHAR(200)    NOT NULL,
        [BankAccountType]            NVARCHAR(20)     NOT NULL,
        [AccountNumberEncrypted]     NVARCHAR(500)    NOT NULL,
        [RoutingNumberEncrypted]     NVARCHAR(500)    NOT NULL,
        [AccountNumberLast4]         CHAR(4)          NOT NULL,
        [RoutingNumberLast4]         CHAR(4)          NOT NULL,
        [IsActive]                   BIT              NOT NULL CONSTRAINT [DF_MemberDirectDeposits_IsActive] DEFAULT 1,
        [Source]                     NVARCHAR(40)     NOT NULL CONSTRAINT [DF_MemberDirectDeposits_Source] DEFAULT N'PublicFormSubmission',
        [SourceSubmissionId]         UNIQUEIDENTIFIER NULL,
        [DeactivatedDate]            DATETIME2        NULL,
        [DeactivatedBy]              UNIQUEIDENTIFIER NULL,
        [CreatedDate]                DATETIME2        NOT NULL CONSTRAINT [DF_MemberDirectDeposits_CreatedDate] DEFAULT SYSUTCDATETIME(),
        [CreatedBy]                  UNIQUEIDENTIFIER NULL,
        [ModifiedDate]               DATETIME2        NULL,
        [ModifiedBy]                 UNIQUEIDENTIFIER NULL,
        CONSTRAINT [CK_MemberDirectDeposits_BankAccountType]
            CHECK ([BankAccountType] IN (N'Checking', N'Savings')),
        CONSTRAINT [FK_MemberDirectDeposits_Member]
            FOREIGN KEY ([MemberId]) REFERENCES [oe].[Members]([MemberId]),
        CONSTRAINT [FK_MemberDirectDeposits_Tenant]
            FOREIGN KEY ([TenantId]) REFERENCES [oe].[Tenants]([TenantId])
    );

    EXEC sys.sp_addextendedproperty
        @name = N'MS_Description',
        @value = N'Per-member ACH bank info used to disburse approved share request reimbursements. One Active row per member; history preserved.',
        @level0type = N'SCHEMA', @level0name = N'oe',
        @level1type = N'TABLE',  @level1name = N'MemberDirectDeposits';
END;

-- Filtered unique index: at most one Active direct deposit per member.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UQ_MemberDirectDeposits_OneActive'
      AND object_id = OBJECT_ID('oe.MemberDirectDeposits')
)
BEGIN
    CREATE UNIQUE INDEX [UQ_MemberDirectDeposits_OneActive]
        ON [oe].[MemberDirectDeposits]([MemberId])
        WHERE [IsActive] = 1;
END;

-- Lookup index for member-overview UI (tenant scope + most-recent-first).
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_MemberDirectDeposits_Member'
      AND object_id = OBJECT_ID('oe.MemberDirectDeposits')
)
BEGIN
    CREATE INDEX [IX_MemberDirectDeposits_Member]
        ON [oe].[MemberDirectDeposits]([TenantId], [MemberId], [IsActive], [CreatedDate] DESC);
END;
