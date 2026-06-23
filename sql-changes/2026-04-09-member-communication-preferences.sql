-- =============================================================================
-- Member communication preferences (CAN-SPAM / TCPA marketing opt-out)
-- MessageTemplates.MessageCategory: System vs Marketing (footer + List-Unsubscribe)
-- =============================================================================
SET NOCOUNT ON;

-- MessageCategory on templates (default Marketing = safer)
IF COL_LENGTH('oe.MessageTemplates', 'MessageCategory') IS NULL
BEGIN
  ALTER TABLE oe.MessageTemplates ADD MessageCategory NVARCHAR(20) NOT NULL
    CONSTRAINT DF_MessageTemplates_MessageCategory DEFAULT ('Marketing');
  PRINT 'Added oe.MessageTemplates.MessageCategory';
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_MessageTemplates_MessageCategory' AND parent_object_id = OBJECT_ID('oe.MessageTemplates')
)
BEGIN
  ALTER TABLE oe.MessageTemplates WITH NOCHECK
    ADD CONSTRAINT CK_MessageTemplates_MessageCategory
    CHECK (MessageCategory IN ('System', 'Marketing'));
  PRINT 'Added CK_MessageTemplates_MessageCategory';
END
GO

IF OBJECT_ID('oe.MemberCommunicationPreferences', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MemberCommunicationPreferences (
    PreferenceId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    MemberId UNIQUEIDENTIFIER NOT NULL,
    TenantId UNIQUEIDENTIFIER NOT NULL,
    EmailMarketingOptOut BIT NOT NULL DEFAULT 0,
    SmsMarketingOptOut BIT NOT NULL DEFAULT 0,
    OptOutDate DATETIME2 NULL,
    OptOutSource NVARCHAR(50) NULL,
    CreatedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    ModifiedDate DATETIME2 NULL,
    CONSTRAINT PK_MemberCommunicationPreferences PRIMARY KEY CLUSTERED (PreferenceId),
    CONSTRAINT FK_MemberCommunicationPreferences_Member FOREIGN KEY (MemberId) REFERENCES oe.Members(MemberId),
    CONSTRAINT FK_MemberCommunicationPreferences_Tenant FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId)
  );
  CREATE UNIQUE INDEX UQ_MemberCommunicationPreferences_MemberId
    ON oe.MemberCommunicationPreferences (MemberId);
  PRINT 'Created oe.MemberCommunicationPreferences';
END
GO

IF OBJECT_ID('oe.MemberConsentLog', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MemberConsentLog (
    LogId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    MemberId UNIQUEIDENTIFIER NOT NULL,
    TenantId UNIQUEIDENTIFIER NOT NULL,
    ConsentType NVARCHAR(50) NOT NULL,
    Action NVARCHAR(20) NOT NULL,
    Source NVARCHAR(100) NOT NULL,
    IpAddress NVARCHAR(50) NULL,
    UserAgent NVARCHAR(500) NULL,
    CreatedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_MemberConsentLog PRIMARY KEY CLUSTERED (LogId)
  );
  CREATE INDEX IX_MemberConsentLog_MemberId_CreatedDate
    ON oe.MemberConsentLog (MemberId, CreatedDate DESC);
  PRINT 'Created oe.MemberConsentLog';
END
GO

PRINT 'Done member communication preferences migration.';
