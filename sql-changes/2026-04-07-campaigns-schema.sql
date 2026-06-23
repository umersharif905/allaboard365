-- =============================================
-- Messaging Campaigns Schema
-- =============================================

-- 1. Campaigns table
CREATE TABLE oe.Campaigns (
  CampaignId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
  TenantId UNIQUEIDENTIFIER NOT NULL,
  CampaignName NVARCHAR(200) NOT NULL,
  TriggerType NVARCHAR(50) NOT NULL,
  IsActive BIT NOT NULL DEFAULT 0,
  CreatedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CreatedBy UNIQUEIDENTIFIER NULL,
  ModifiedDate DATETIME2 NULL,
  ModifiedBy UNIQUEIDENTIFIER NULL,
  CONSTRAINT PK_Campaigns PRIMARY KEY CLUSTERED (CampaignId),
  CONSTRAINT CK_Campaigns_TriggerType CHECK (TriggerType IN ('EnrollmentCompletion', 'FirstDayOfCoverage', 'DependentAdded'))
);

CREATE INDEX IX_Campaigns_TenantId_IsActive ON oe.Campaigns (TenantId, IsActive);
CREATE INDEX IX_Campaigns_TriggerType ON oe.Campaigns (TriggerType);

-- 2. CampaignSteps table
CREATE TABLE oe.CampaignSteps (
  StepId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
  CampaignId UNIQUEIDENTIFIER NOT NULL,
  StepOrder INT NOT NULL,
  DelayDays INT NOT NULL DEFAULT 0,
  EmailTemplateId UNIQUEIDENTIFIER NULL,
  SmsTemplateId UNIQUEIDENTIFIER NULL,
  IsActive BIT NOT NULL DEFAULT 1,
  CreatedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  ModifiedDate DATETIME2 NULL,
  CONSTRAINT PK_CampaignSteps PRIMARY KEY CLUSTERED (StepId),
  CONSTRAINT FK_CampaignSteps_Campaign FOREIGN KEY (CampaignId) REFERENCES oe.Campaigns(CampaignId) ON DELETE CASCADE,
  CONSTRAINT FK_CampaignSteps_EmailTemplate FOREIGN KEY (EmailTemplateId) REFERENCES oe.MessageTemplates(TemplateId),
  CONSTRAINT FK_CampaignSteps_SmsTemplate FOREIGN KEY (SmsTemplateId) REFERENCES oe.MessageTemplates(TemplateId)
);

CREATE INDEX IX_CampaignSteps_CampaignId_StepOrder ON oe.CampaignSteps (CampaignId, StepOrder);

-- 3. CampaignEnrollments table
CREATE TABLE oe.CampaignEnrollments (
  CampaignEnrollmentId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
  CampaignId UNIQUEIDENTIFIER NOT NULL,
  MemberId UNIQUEIDENTIFIER NOT NULL,
  TenantId UNIQUEIDENTIFIER NOT NULL,
  TriggerDate DATE NOT NULL,
  CurrentStepOrder INT NOT NULL DEFAULT 0,
  Status NVARCHAR(20) NOT NULL DEFAULT 'Active',
  CreatedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CompletedDate DATETIME2 NULL,
  CONSTRAINT PK_CampaignEnrollments PRIMARY KEY CLUSTERED (CampaignEnrollmentId),
  CONSTRAINT FK_CampaignEnrollments_Campaign FOREIGN KEY (CampaignId) REFERENCES oe.Campaigns(CampaignId),
  CONSTRAINT CK_CampaignEnrollments_Status CHECK (Status IN ('Active', 'Completed', 'Cancelled'))
);

CREATE INDEX IX_CampaignEnrollments_Status_TriggerDate ON oe.CampaignEnrollments (Status, TriggerDate);
CREATE INDEX IX_CampaignEnrollments_MemberId ON oe.CampaignEnrollments (MemberId);
CREATE INDEX IX_CampaignEnrollments_CampaignId ON oe.CampaignEnrollments (CampaignId);

-- 4. CampaignMessageLog table
CREATE TABLE oe.CampaignMessageLog (
  LogId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
  CampaignEnrollmentId UNIQUEIDENTIFIER NOT NULL,
  StepId UNIQUEIDENTIFIER NOT NULL,
  MessageType NVARCHAR(50) NOT NULL,
  MessageId UNIQUEIDENTIFIER NULL,
  SentDate DATETIME2 NULL,
  Status NVARCHAR(20) NOT NULL DEFAULT 'Pending',
  CONSTRAINT PK_CampaignMessageLog PRIMARY KEY CLUSTERED (LogId),
  CONSTRAINT FK_CampaignMessageLog_Enrollment FOREIGN KEY (CampaignEnrollmentId) REFERENCES oe.CampaignEnrollments(CampaignEnrollmentId),
  CONSTRAINT CK_CampaignMessageLog_Status CHECK (Status IN ('Pending', 'Sent', 'Skipped'))
);

CREATE INDEX IX_CampaignMessageLog_CampaignEnrollmentId ON oe.CampaignMessageLog (CampaignEnrollmentId);

-- 5. Add CampaignId to MessageTemplates for optional tagging
ALTER TABLE oe.MessageTemplates ADD CampaignId UNIQUEIDENTIFIER NULL;
CREATE INDEX IX_MessageTemplates_CampaignId ON oe.MessageTemplates (CampaignId);
