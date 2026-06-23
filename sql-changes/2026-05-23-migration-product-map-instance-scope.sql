-- Scope E123 product mappings to migration instance (shared across instance tenants)

IF NOT EXISTS (
  SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MigrationProductMap') AND name = 'InstanceId'
)
BEGIN
  ALTER TABLE oe.MigrationProductMap ADD InstanceId UNIQUEIDENTIFIER NULL;
END
GO

UPDATE pm
SET pm.InstanceId = it.InstanceId
FROM oe.MigrationProductMap pm
INNER JOIN oe.MigrationInstanceTenant it ON it.TenantId = pm.TenantId
WHERE pm.InstanceId IS NULL;
GO

DELETE FROM oe.MigrationProductMap WHERE InstanceId IS NULL;
GO

;WITH ranked AS (
  SELECT ProductMapId,
    ROW_NUMBER() OVER (
      PARTITION BY InstanceId, SourceSystem, SourceProductKey, SourceBenefitKey
      ORDER BY ModifiedUtc DESC, ProductMapId
    ) AS rn
  FROM oe.MigrationProductMap
)
DELETE pm
FROM oe.MigrationProductMap pm
INNER JOIN ranked r ON r.ProductMapId = pm.ProductMapId
WHERE r.rn > 1;
GO

IF EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'IX_MigrationProductMap_TenantId'
    AND object_id = OBJECT_ID('oe.MigrationProductMap')
)
  DROP INDEX IX_MigrationProductMap_TenantId ON oe.MigrationProductMap;
GO

IF EXISTS (
  SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_MigrationProductMap_Key'
    AND parent_object_id = OBJECT_ID('oe.MigrationProductMap')
)
  ALTER TABLE oe.MigrationProductMap DROP CONSTRAINT UQ_MigrationProductMap_Key;
GO

IF EXISTS (
  SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MigrationProductMap') AND name = 'TenantId'
)
  ALTER TABLE oe.MigrationProductMap DROP COLUMN TenantId;
GO

ALTER TABLE oe.MigrationProductMap ALTER COLUMN InstanceId UNIQUEIDENTIFIER NOT NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_MigrationProductMap_Key'
    AND parent_object_id = OBJECT_ID('oe.MigrationProductMap')
)
BEGIN
  ALTER TABLE oe.MigrationProductMap
    ADD CONSTRAINT UQ_MigrationProductMap_Key UNIQUE (InstanceId, SourceSystem, SourceProductKey, SourceBenefitKey);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'IX_MigrationProductMap_InstanceId'
    AND object_id = OBJECT_ID('oe.MigrationProductMap')
)
  CREATE INDEX IX_MigrationProductMap_InstanceId ON oe.MigrationProductMap (InstanceId);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_MigrationProductMap_Instance'
)
BEGIN
  ALTER TABLE oe.MigrationProductMap
    ADD CONSTRAINT FK_MigrationProductMap_Instance FOREIGN KEY (InstanceId)
      REFERENCES oe.MigrationInstance (InstanceId) ON DELETE CASCADE;
END
GO
