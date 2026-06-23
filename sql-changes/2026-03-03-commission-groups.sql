/*
  Commission Groups

  - Adds oe.CommissionGroups (tenant-scoped)
  - Adds oe.CommissionGroupRules (membership)
  - Adds CommissionGroupId to Agents, Agencies, OnboardingLinkCommissionCodes, AgentOnboardingSessions
  - Updates onboarding link code stored procedures to support CommissionGroupId

  Notes:
  - Per-product uniqueness within a group is enforced at the API level (ProductId lives on oe.CommissionRules).
*/

SET NOCOUNT ON;

-- ============================================================================
-- 1) Tables: oe.CommissionGroups, oe.CommissionGroupRules
-- ============================================================================

IF NOT EXISTS (
  SELECT 1
  FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = 'oe' AND t.name = 'CommissionGroups'
)
BEGIN
  CREATE TABLE oe.CommissionGroups (
    CommissionGroupId UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_CommissionGroups_CommissionGroupId DEFAULT NEWID(),
    TenantId UNIQUEIDENTIFIER NOT NULL,
    Name NVARCHAR(150) NOT NULL,
    Description NVARCHAR(1000) NULL,
    Status NVARCHAR(20) NOT NULL CONSTRAINT DF_CommissionGroups_Status DEFAULT 'Active',
    CreatedDate DATETIME2(3) NOT NULL CONSTRAINT DF_CommissionGroups_CreatedDate DEFAULT SYSUTCDATETIME(),
    ModifiedDate DATETIME2(3) NOT NULL CONSTRAINT DF_CommissionGroups_ModifiedDate DEFAULT SYSUTCDATETIME(),
    CreatedBy UNIQUEIDENTIFIER NULL,
    ModifiedBy UNIQUEIDENTIFIER NULL,
    CONSTRAINT PK_CommissionGroups PRIMARY KEY (CommissionGroupId)
  );

  CREATE INDEX IX_CommissionGroups_TenantId ON oe.CommissionGroups (TenantId);
  CREATE UNIQUE INDEX UX_CommissionGroups_TenantId_Name ON oe.CommissionGroups (TenantId, Name);
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = 'oe' AND t.name = 'CommissionGroupRules'
)
BEGIN
  CREATE TABLE oe.CommissionGroupRules (
    CommissionGroupId UNIQUEIDENTIFIER NOT NULL,
    RuleId UNIQUEIDENTIFIER NOT NULL,
    CreatedDate DATETIME2(3) NOT NULL CONSTRAINT DF_CommissionGroupRules_CreatedDate DEFAULT SYSUTCDATETIME(),
    CreatedBy UNIQUEIDENTIFIER NULL,
    CONSTRAINT PK_CommissionGroupRules PRIMARY KEY (CommissionGroupId, RuleId),
    CONSTRAINT FK_CommissionGroupRules_Group FOREIGN KEY (CommissionGroupId) REFERENCES oe.CommissionGroups(CommissionGroupId),
    CONSTRAINT FK_CommissionGroupRules_Rule FOREIGN KEY (RuleId) REFERENCES oe.CommissionRules(RuleId)
  );

  CREATE INDEX IX_CommissionGroupRules_RuleId ON oe.CommissionGroupRules (RuleId);
END;

-- ============================================================================
-- 2) Columns: CommissionGroupId on Agents / Agencies / OnboardingLinkCommissionCodes / AgentOnboardingSessions
-- ============================================================================

IF EXISTS (SELECT 1 FROM sys.tables WHERE object_id = OBJECT_ID('oe.Agents'))
AND NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Agents') AND name = 'CommissionGroupId'
)
BEGIN
  ALTER TABLE oe.Agents ADD CommissionGroupId UNIQUEIDENTIFIER NULL;
  CREATE INDEX IX_Agents_CommissionGroupId ON oe.Agents (CommissionGroupId);
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE object_id = OBJECT_ID('oe.Agencies'))
AND NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Agencies') AND name = 'CommissionGroupId'
)
BEGIN
  ALTER TABLE oe.Agencies ADD CommissionGroupId UNIQUEIDENTIFIER NULL;
  CREATE INDEX IX_Agencies_CommissionGroupId ON oe.Agencies (CommissionGroupId);
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE object_id = OBJECT_ID('oe.OnboardingLinkCommissionCodes'))
AND NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.OnboardingLinkCommissionCodes') AND name = 'CommissionGroupId'
)
BEGIN
  ALTER TABLE oe.OnboardingLinkCommissionCodes ADD CommissionGroupId UNIQUEIDENTIFIER NULL;
END;

IF EXISTS (SELECT 1 FROM sys.tables WHERE object_id = OBJECT_ID('oe.AgentOnboardingSessions'))
AND NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.AgentOnboardingSessions') AND name = 'CommissionGroupId'
)
BEGIN
  ALTER TABLE oe.AgentOnboardingSessions ADD CommissionGroupId UNIQUEIDENTIFIER NULL;
END;

-- ============================================================================
-- 3) Stored procs: onboarding link commission codes now support CommissionGroupId
-- ============================================================================

-- NOTE: CommissionRuleId remains supported for legacy viewing; future UI will use CommissionGroupId.

GO

CREATE OR ALTER PROCEDURE [oe].[sp_AddOnboardingLinkCommissionCode]
  @LinkId UNIQUEIDENTIFIER,
  @CommissionCode NVARCHAR(50),
  @CommissionRuleId UNIQUEIDENTIFIER = NULL,
  @CommissionGroupId UNIQUEIDENTIFIER = NULL,
  @CreatedBy UNIQUEIDENTIFIER,
  @GrantTierLevel INT = NULL
AS
BEGIN
  SET NOCOUNT ON;
  BEGIN TRY
    DECLARE @TenantId UNIQUEIDENTIFIER;
    SELECT @TenantId = TenantId FROM oe.AgentOnboardingLinks WHERE LinkId = @LinkId;
    IF @TenantId IS NULL
    BEGIN
      RAISERROR('Onboarding link not found', 16, 1);
      RETURN;
    END

    IF @CommissionRuleId IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM oe.CommissionRules WHERE RuleId = @CommissionRuleId)
    BEGIN
      RAISERROR('Commission rule not found', 16, 1);
      RETURN;
    END

    IF @CommissionGroupId IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM oe.CommissionGroups WHERE CommissionGroupId = @CommissionGroupId AND TenantId = @TenantId)
    BEGIN
      RAISERROR('Commission group not found', 16, 1);
      RETURN;
    END

    IF EXISTS (
      SELECT 1
      FROM oe.OnboardingLinkCommissionCodes
      WHERE LinkId = @LinkId AND CommissionCode = UPPER(TRIM(@CommissionCode))
    )
    BEGIN
      RAISERROR('Commission code already exists for this link', 16, 1);
      RETURN;
    END

    INSERT INTO oe.OnboardingLinkCommissionCodes (
      LinkId, CommissionCode, CommissionRuleId, CommissionGroupId, CreatedBy, GrantTierLevel
    ) VALUES (
      @LinkId, UPPER(TRIM(@CommissionCode)), @CommissionRuleId, @CommissionGroupId, @CreatedBy, @GrantTierLevel
    );

    SELECT 'Success' AS Status, 'Commission code added successfully' AS Message;
  END TRY
  BEGIN CATCH
    SELECT 'Error' AS Status, ERROR_MESSAGE() AS Message;
  END CATCH
END;
GO

CREATE OR ALTER PROCEDURE [oe].[sp_GetOnboardingLinkCommissionCodes]
  @LinkId UNIQUEIDENTIFIER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT
    olcc.[CodeId],
    olcc.[CommissionCode],
    olcc.[CommissionRuleId],
    cr.[RuleName] AS [CommissionRuleName],
    cr.[CommissionType],
    cr.[CommissionRate],
    cr.[FlatAmount],
    olcc.[CommissionGroupId],
    cg.[Name] AS [CommissionGroupName],
    olcc.[IsActive],
    olcc.[GrantTierLevel],
    olcc.[CreatedDate],
    olcc.[ModifiedDate]
  FROM oe.OnboardingLinkCommissionCodes olcc
  LEFT JOIN oe.CommissionRules cr ON olcc.[CommissionRuleId] = cr.[RuleId]
  LEFT JOIN oe.CommissionGroups cg ON olcc.[CommissionGroupId] = cg.[CommissionGroupId]
  WHERE olcc.[LinkId] = @LinkId
  ORDER BY olcc.[CreatedDate] ASC;
END;
GO

SET NOCOUNT ON;

PRINT '✅ Commission Groups schema installed';

