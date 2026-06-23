-- Hybrid custom commission levels (Phase A)
-- 1) Add tenant-scoped catalog table oe.CommissionLevels
-- 2) Add nullable CommissionLevelId references to oe.Agents and oe.Agencies
-- 3) Seed legacy-compatible levels (-1..6) for each tenant
-- 4) Add tenant-level cutover flag columns (default hybrid mode ON, custom-only OFF)

IF OBJECT_ID('oe.CommissionLevels', 'U') IS NULL
BEGIN
    CREATE TABLE oe.CommissionLevels (
        CommissionLevelId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        TenantId UNIQUEIDENTIFIER NOT NULL,
        Code NVARCHAR(100) NOT NULL,
        DisplayName NVARCHAR(200) NOT NULL,
        SortOrder INT NOT NULL,
        LegacyTierLevel INT NULL,
        IsSystemSeeded BIT NOT NULL CONSTRAINT DF_CommissionLevels_IsSystemSeeded DEFAULT 0,
        IsActive BIT NOT NULL CONSTRAINT DF_CommissionLevels_IsActive DEFAULT 1,
        CreatedDate DATETIME2 NOT NULL CONSTRAINT DF_CommissionLevels_CreatedDate DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2 NOT NULL CONSTRAINT DF_CommissionLevels_ModifiedDate DEFAULT GETUTCDATE(),
        CONSTRAINT PK_CommissionLevels PRIMARY KEY (CommissionLevelId),
        CONSTRAINT FK_CommissionLevels_Tenant FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId)
    );

    CREATE UNIQUE NONCLUSTERED INDEX UX_CommissionLevels_Tenant_Code
        ON oe.CommissionLevels (TenantId, Code);

    CREATE UNIQUE NONCLUSTERED INDEX UX_CommissionLevels_Tenant_SortOrder
        ON oe.CommissionLevels (TenantId, SortOrder);

    CREATE UNIQUE NONCLUSTERED INDEX UX_CommissionLevels_Tenant_LegacyTier
        ON oe.CommissionLevels (TenantId, LegacyTierLevel)
        WHERE LegacyTierLevel IS NOT NULL;
END;

IF COL_LENGTH('oe.Agents', 'CommissionLevelId') IS NULL
BEGIN
    ALTER TABLE oe.Agents
        ADD CommissionLevelId UNIQUEIDENTIFIER NULL;
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.foreign_keys
    WHERE name = 'FK_Agents_CommissionLevels'
      AND parent_object_id = OBJECT_ID('oe.Agents')
)
BEGIN
    ALTER TABLE oe.Agents
        ADD CONSTRAINT FK_Agents_CommissionLevels
        FOREIGN KEY (CommissionLevelId) REFERENCES oe.CommissionLevels(CommissionLevelId);
END;

IF COL_LENGTH('oe.Agencies', 'CommissionLevelId') IS NULL
BEGIN
    ALTER TABLE oe.Agencies
        ADD CommissionLevelId UNIQUEIDENTIFIER NULL;
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.foreign_keys
    WHERE name = 'FK_Agencies_CommissionLevels'
      AND parent_object_id = OBJECT_ID('oe.Agencies')
)
BEGIN
    ALTER TABLE oe.Agencies
        ADD CONSTRAINT FK_Agencies_CommissionLevels
        FOREIGN KEY (CommissionLevelId) REFERENCES oe.CommissionLevels(CommissionLevelId);
END;

IF COL_LENGTH('oe.Tenants', 'CommissionLevelsHybridEnabled') IS NULL
BEGIN
    ALTER TABLE oe.Tenants
        ADD CommissionLevelsHybridEnabled BIT NOT NULL CONSTRAINT DF_Tenants_CommissionLevelsHybridEnabled DEFAULT 1;
END;

IF COL_LENGTH('oe.Tenants', 'UseCustomCommissionLevelsOnly') IS NULL
BEGIN
    ALTER TABLE oe.Tenants
        ADD UseCustomCommissionLevelsOnly BIT NOT NULL CONSTRAINT DF_Tenants_UseCustomCommissionLevelsOnly DEFAULT 0;
END;

;WITH LegacySeed AS (
    SELECT * FROM (VALUES
        (N'associate', N'Associate', -1, -1),
        (N'agent', N'Agent', 0, 0),
        (N'agency', N'Agency', 1, 1),
        (N'ga', N'GA', 2, 2),
        (N'mga', N'MGA', 3, 3),
        (N'imo', N'IMO', 4, 4),
        (N'fmo', N'FMO', 5, 5),
        (N'enterprise_carrier', N'Enterprise/Carrier', 6, 6)
    ) s(Code, DisplayName, SortOrder, LegacyTierLevel)
)
INSERT INTO oe.CommissionLevels (
    CommissionLevelId,
    TenantId,
    Code,
    DisplayName,
    SortOrder,
    LegacyTierLevel,
    IsSystemSeeded,
    IsActive,
    CreatedDate,
    ModifiedDate
)
SELECT
    NEWID(),
    t.TenantId,
    s.Code,
    s.DisplayName,
    s.SortOrder,
    s.LegacyTierLevel,
    1,
    1,
    GETUTCDATE(),
    GETUTCDATE()
FROM oe.Tenants t
CROSS JOIN LegacySeed s
WHERE NOT EXISTS (
    SELECT 1
    FROM oe.CommissionLevels cl
    WHERE cl.TenantId = t.TenantId
      AND (
          cl.Code = s.Code
          OR (cl.LegacyTierLevel IS NOT NULL AND cl.LegacyTierLevel = s.LegacyTierLevel)
      )
);
