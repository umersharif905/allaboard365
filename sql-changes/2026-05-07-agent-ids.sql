/*
  Agent IDs — tenant-scoped, seeded-sequential AgentCode.

  Adds:
    1. oe.Tenants.AgentIDPrefix NVARCHAR(10) NULL
    2. Non-unique index IX_Agents_AgentCode on oe.Agents(AgentCode)
    3. Procedure oe.GenerateAgentCode(@TenantId, @AgentCode OUTPUT)

  Format: {PREFIX}{8-digit number}, e.g. MWA12345678.
  Default when oe.Tenants.AgentIDPrefix is null/empty: no prefix at all
  (codes are pure-numeric, e.g. '15089303').

  Numbering: each prefix's first code is seeded with a random 8-digit number
  in the range 10,000,000–19,999,999 so codes don't betray order or volume
  (matches the existing Member ID convention, which seeds at ~15,990,000).
  Subsequent codes for that prefix increment by 1 from the seed.

  Idempotent. Deploy: run against the Open Enroll (oe) database.
*/

SET NOCOUNT ON;

-- 1. Add AgentIDPrefix column on oe.Tenants if missing.
IF NOT EXISTS (
  SELECT 1
  FROM sys.columns
  WHERE object_id = OBJECT_ID(N'oe.Tenants')
    AND name = N'AgentIDPrefix'
)
BEGIN
  ALTER TABLE oe.Tenants ADD AgentIDPrefix NVARCHAR(10) NULL;
END
GO

-- 2. Index on oe.Agents.AgentCode for prefix-LIKE scans during generation.
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'oe.Agents')
    AND name = N'IX_Agents_AgentCode'
)
BEGIN
  CREATE INDEX IX_Agents_AgentCode ON oe.Agents(AgentCode);
END
GO

-- 3. Procedure: oe.GenerateAgentCode
CREATE OR ALTER PROCEDURE oe.GenerateAgentCode
  @TenantId  UNIQUEIDENTIFIER,
  @AgentCode NVARCHAR(50) OUTPUT
AS
BEGIN
  SET NOCOUNT ON;

  DECLARE @Prefix     NVARCHAR(10);
  DECLARE @MaxSuffix  BIGINT;
  DECLARE @Next       BIGINT;

  SELECT @Prefix = NULLIF(LTRIM(RTRIM(AgentIDPrefix)), N'')
  FROM oe.Tenants WITH (NOLOCK)
  WHERE TenantId = @TenantId;

  -- Default: no prefix at all. The downstream MAX query naturally restricts
  -- to pure-numeric codes via TRY_CAST, so empty-prefix tenants don't
  -- collide with custom-prefix sequences.
  IF @Prefix IS NULL
    SET @Prefix = N'';

  SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
  BEGIN TRANSACTION;

    SELECT @MaxSuffix = MAX(
      TRY_CAST(SUBSTRING(a.AgentCode, LEN(@Prefix) + 1, 50) AS BIGINT)
    )
    FROM oe.Agents AS a WITH (UPDLOCK, HOLDLOCK)
    WHERE a.AgentCode IS NOT NULL
      AND LEN(a.AgentCode) > LEN(@Prefix)
      AND UPPER(LEFT(a.AgentCode, LEN(@Prefix))) = UPPER(@Prefix)
      AND TRY_CAST(SUBSTRING(a.AgentCode, LEN(@Prefix) + 1, 50) AS BIGINT) IS NOT NULL;

    -- First code for a prefix gets a random 8-digit seed (10,000,000–19,999,999),
    -- so codes don't look like a 1,2,3 counter. Subsequent codes increment.
    -- Pattern mirrors oe.Members.HouseholdMemberID, which is seeded near 15,990,000.
    IF @MaxSuffix IS NULL
      SET @Next = 10000000 + (ABS(CHECKSUM(NEWID())) % 10000000);
    ELSE
      SET @Next = @MaxSuffix + 1;

    SET @AgentCode = @Prefix + CAST(@Next AS NVARCHAR(20));

  COMMIT TRANSACTION;
END
GO
