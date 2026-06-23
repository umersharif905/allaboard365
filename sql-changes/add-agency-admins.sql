-- Many-to-many agency admins (replaces single oe.Agencies.OwnerAgentId).
-- Run against the application database after backup.

IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = 'oe' AND t.name = 'AgencyAdmins'
)
BEGIN
  CREATE TABLE oe.AgencyAdmins (
    AgencyId UNIQUEIDENTIFIER NOT NULL,
    AgentId UNIQUEIDENTIFIER NOT NULL,
    Status NVARCHAR(20) NOT NULL CONSTRAINT DF_AgencyAdmins_Status DEFAULT ('Active'),
    CreatedDate DATETIME2 NOT NULL CONSTRAINT DF_AgencyAdmins_Created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_AgencyAdmins PRIMARY KEY (AgencyId, AgentId),
    CONSTRAINT FK_AgencyAdmins_Agency FOREIGN KEY (AgencyId) REFERENCES oe.Agencies(AgencyId),
    CONSTRAINT FK_AgencyAdmins_Agent FOREIGN KEY (AgentId) REFERENCES oe.Agents(AgentId)
  );
  CREATE INDEX IX_AgencyAdmins_AgentId ON oe.AgencyAdmins(AgentId) INCLUDE (AgencyId, Status);
END
GO

-- Backfill from legacy column when present
IF COL_LENGTH('oe.Agencies', 'OwnerAgentId') IS NOT NULL
BEGIN
  INSERT INTO oe.AgencyAdmins (AgencyId, AgentId, Status)
  SELECT a.AgencyId, a.OwnerAgentId, 'Active'
  FROM oe.Agencies a
  WHERE a.OwnerAgentId IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM oe.AgencyAdmins x
      WHERE x.AgencyId = a.AgencyId AND x.AgentId = a.OwnerAgentId
    );
END
GO

-- Drop legacy column
IF COL_LENGTH('oe.Agencies', 'OwnerAgentId') IS NOT NULL
BEGIN
  DECLARE @fk sysname;
  DECLARE @dropFkSql NVARCHAR(512);

  SELECT @fk = fk.name
  FROM sys.foreign_keys fk
  INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
  INNER JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
  WHERE SCHEMA_NAME(fk.schema_id) = 'oe'
    AND OBJECT_NAME(fk.parent_object_id) = 'Agencies'
    AND c.name = 'OwnerAgentId';

  IF @fk IS NOT NULL
  BEGIN
    SET @dropFkSql = N'ALTER TABLE oe.Agencies DROP CONSTRAINT ' + QUOTENAME(@fk);
    EXEC sys.sp_executesql @dropFkSql;
  END;

  -- Indexes (and unique constraints implemented as constraints) block DROP COLUMN
  DECLARE @idx sysname;
  DECLARE @isUqConstraint bit;
  DECLARE @dropObjSql NVARCHAR(512);
  DECLARE idx_cur CURSOR LOCAL FAST_FORWARD FOR
  SELECT DISTINCT i.name, i.is_unique_constraint
  FROM sys.indexes i
  INNER JOIN sys.tables t ON i.object_id = t.object_id
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
  INNER JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
  WHERE s.name = N'oe'
    AND t.name = N'Agencies'
    AND col.name = N'OwnerAgentId'
    AND i.is_hypothetical = 0
    AND i.index_id > 0
    AND i.is_primary_key = 0;

  OPEN idx_cur;
  FETCH NEXT FROM idx_cur INTO @idx, @isUqConstraint;
  WHILE @@FETCH_STATUS = 0
  BEGIN
    IF @isUqConstraint = 1
      SET @dropObjSql = N'ALTER TABLE oe.Agencies DROP CONSTRAINT ' + QUOTENAME(@idx);
    ELSE
      SET @dropObjSql = N'DROP INDEX ' + QUOTENAME(@idx) + N' ON oe.Agencies;';
    EXEC sys.sp_executesql @dropObjSql;
    FETCH NEXT FROM idx_cur INTO @idx, @isUqConstraint;
  END;
  CLOSE idx_cur;
  DEALLOCATE idx_cur;

  ALTER TABLE oe.Agencies DROP COLUMN OwnerAgentId;
END
GO
