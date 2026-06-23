-- Decimal tier / sort order support (insert levels between e.g. Associate -1 and Agent 0)
-- Run in order. Widens SortOrder, tier levels, and rule TierLevel; recreates unique index; updates SPs.

SET NOCOUNT ON;

-- ---------------------------------------------------------------------------
-- 1) CommissionLevels: unique index is on (TenantId, SortOrder) filtered -- drop first
-- ---------------------------------------------------------------------------
IF EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'UX_CommissionLevels_Tenant_SortOrder_Active'
    AND object_id = OBJECT_ID(N'oe.CommissionLevels')
)
BEGIN
  DROP INDEX UX_CommissionLevels_Tenant_SortOrder_Active ON oe.CommissionLevels;
END
GO

IF COL_LENGTH('oe.CommissionLevels', 'SortOrder') IS NOT NULL
  ALTER TABLE oe.CommissionLevels ALTER COLUMN SortOrder DECIMAL(9,4) NOT NULL;
GO

-- LegacyTierLevel: unique filter index (see 2026-04-11-commission-levels-hybrid-phase-a) blocks ALTER; drop first.
IF EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'UX_CommissionLevels_Tenant_LegacyTier'
    AND object_id = OBJECT_ID(N'oe.CommissionLevels')
)
  DROP INDEX UX_CommissionLevels_Tenant_LegacyTier ON oe.CommissionLevels;
GO

IF COL_LENGTH('oe.CommissionLevels', 'LegacyTierLevel') IS NOT NULL
  ALTER TABLE oe.CommissionLevels ALTER COLUMN LegacyTierLevel DECIMAL(9,4) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'UX_CommissionLevels_Tenant_LegacyTier'
    AND object_id = OBJECT_ID(N'oe.CommissionLevels')
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX UX_CommissionLevels_Tenant_LegacyTier
    ON oe.CommissionLevels (TenantId, LegacyTierLevel)
    WHERE LegacyTierLevel IS NOT NULL;
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = N'UX_CommissionLevels_Tenant_SortOrder_Active'
    AND object_id = OBJECT_ID(N'oe.CommissionLevels')
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX UX_CommissionLevels_Tenant_SortOrder_Active
    ON oe.CommissionLevels (TenantId, SortOrder)
    WHERE IsActive = 1;
END
GO

-- ---------------------------------------------------------------------------
-- 2) Agents, Agencies: DEFAULT + index on CommissionTierLevel block ALTER; drop, alter, recreate.
-- ---------------------------------------------------------------------------
DECLARE @dropDc NVARCHAR(4000);

-- oe.Agents.CommissionTierLevel
SET @dropDc = NULL;
SELECT @dropDc = N'ALTER TABLE oe.Agents DROP CONSTRAINT ' + QUOTENAME(dc.name)
FROM sys.default_constraints dc
INNER JOIN sys.columns c
  ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
WHERE dc.parent_object_id = OBJECT_ID(N'oe.Agents', N'U')
  AND c.name = N'CommissionTierLevel';
IF @dropDc IS NOT NULL
  EXEC sp_executesql @dropDc;

IF EXISTS (SELECT 1 FROM sys.indexes i WHERE i.name = N'IX_Agents_CommissionTierLevel' AND i.object_id = OBJECT_ID(N'oe.Agents'))
  DROP INDEX IX_Agents_CommissionTierLevel ON oe.Agents;

IF COL_LENGTH('oe.Agents', 'CommissionTierLevel') IS NOT NULL
  ALTER TABLE oe.Agents ALTER COLUMN CommissionTierLevel DECIMAL(9,4) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.indexes i WHERE i.name = N'IX_Agents_CommissionTierLevel' AND i.object_id = OBJECT_ID(N'oe.Agents'))
  CREATE NONCLUSTERED INDEX IX_Agents_CommissionTierLevel ON oe.Agents (CommissionTierLevel);

IF NOT EXISTS (
  SELECT 1
  FROM sys.default_constraints dc
  INNER JOIN sys.columns c
    ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
  WHERE dc.parent_object_id = OBJECT_ID(N'oe.Agents', N'U') AND c.name = N'CommissionTierLevel'
)
  ALTER TABLE oe.Agents ADD CONSTRAINT DF_Agents_CommissionTierLevel DEFAULT 0 FOR CommissionTierLevel;
GO

-- oe.Agencies.CommissionTierLevel (separate batch: fresh DECLARE)
DECLARE @dropAgencyDc NVARCHAR(4000);
SET @dropAgencyDc = NULL;
SELECT @dropAgencyDc = N'ALTER TABLE oe.Agencies DROP CONSTRAINT ' + QUOTENAME(dc.name)
FROM sys.default_constraints dc
INNER JOIN sys.columns c
  ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
WHERE dc.parent_object_id = OBJECT_ID(N'oe.Agencies', N'U')
  AND c.name = N'CommissionTierLevel';
IF @dropAgencyDc IS NOT NULL
  EXEC sp_executesql @dropAgencyDc;

IF EXISTS (SELECT 1 FROM sys.indexes i WHERE i.name = N'IX_Agencies_CommissionTierLevel' AND i.object_id = OBJECT_ID(N'oe.Agencies'))
  DROP INDEX IX_Agencies_CommissionTierLevel ON oe.Agencies;

IF COL_LENGTH('oe.Agencies', 'CommissionTierLevel') IS NOT NULL
  ALTER TABLE oe.Agencies ALTER COLUMN CommissionTierLevel DECIMAL(9,4) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.indexes i WHERE i.name = N'IX_Agencies_CommissionTierLevel' AND i.object_id = OBJECT_ID(N'oe.Agencies'))
  CREATE NONCLUSTERED INDEX IX_Agencies_CommissionTierLevel ON oe.Agencies (CommissionTierLevel);

IF NOT EXISTS (
  SELECT 1
  FROM sys.default_constraints dc
  INNER JOIN sys.columns c
    ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
  WHERE dc.parent_object_id = OBJECT_ID(N'oe.Agencies', N'U') AND c.name = N'CommissionTierLevel'
)
  ALTER TABLE oe.Agencies ADD CONSTRAINT DF_Agencies_CommissionTierLevel DEFAULT 0 FOR CommissionTierLevel;
GO

IF COL_LENGTH('oe.OnboardingLinkCommissionCodes', 'GrantTierLevel') IS NOT NULL
  ALTER TABLE oe.OnboardingLinkCommissionCodes ALTER COLUMN GrantTierLevel DECIMAL(9,4) NULL;
GO

IF COL_LENGTH('oe.CommissionRules', 'TierLevel') IS NOT NULL
  ALTER TABLE oe.CommissionRules ALTER COLUMN TierLevel DECIMAL(9,4) NULL;
GO

IF COL_LENGTH('oe.NACHAPaymentDetails', 'TierLevel') IS NOT NULL
  ALTER TABLE oe.NACHAPaymentDetails ALTER COLUMN TierLevel DECIMAL(9,4) NULL;
GO

-- ---------------------------------------------------------------------------
-- 3) Stored procedures: @GrantTierLevel DECIMAL(9,4)
-- ---------------------------------------------------------------------------
CREATE OR ALTER PROCEDURE [oe].[sp_AddOnboardingLinkCommissionCode]
  @LinkId UNIQUEIDENTIFIER,
  @CommissionCode NVARCHAR(50),
  @CommissionRuleId UNIQUEIDENTIFIER = NULL,
  @CommissionGroupId UNIQUEIDENTIFIER = NULL,
  @CreatedBy UNIQUEIDENTIFIER,
  @GrantTierLevel DECIMAL(9,4) = NULL
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

PRINT 'OK: 2026-04-23 tier levels decimal';
