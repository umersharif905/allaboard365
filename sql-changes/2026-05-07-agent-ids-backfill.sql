/*
  One-shot backfill: assign AgentCode to every oe.Agents row that currently
  has NULL/empty or DUP-prefixed AgentCode. Iterates in CreatedDate order so
  earlier agents get earlier sequence numbers.

  Logs old -> new mapping into a temp table (or @AuditTable, declared inline).

  SAFETY:
    Wraps everything in a transaction. ROLLBACK on @Execute = 0 (dry run),
    COMMIT on @Execute = 1. The dry-run preview reflects the real outcome
    because the procedure sees in-progress state during the run.

  Idempotent: rows with a non-DUP, non-empty AgentCode are skipped.
*/

SET NOCOUNT ON;

DECLARE @Execute BIT = 0; -- flip to 1 to perform the backfill

DECLARE @ToFill TABLE (
  AgentId UNIQUEIDENTIFIER PRIMARY KEY,
  TenantId UNIQUEIDENTIFIER NOT NULL,
  OldAgentCode NVARCHAR(100) NULL,
  NewAgentCode NVARCHAR(50) NULL,
  CreatedDate DATETIME2 NOT NULL
);

INSERT INTO @ToFill (AgentId, TenantId, OldAgentCode, CreatedDate)
SELECT a.AgentId, a.TenantId, a.AgentCode, a.CreatedDate
FROM oe.Agents a
WHERE (a.AgentCode IS NULL OR a.AgentCode = N'' OR a.AgentCode LIKE N'DUP%')
ORDER BY a.CreatedDate ASC;

DECLARE @AgentId UNIQUEIDENTIFIER, @TenantId UNIQUEIDENTIFIER, @NewCode NVARCHAR(50);

BEGIN TRANSACTION;

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
  SELECT AgentId, TenantId FROM @ToFill ORDER BY CreatedDate ASC;
OPEN cur;
FETCH NEXT FROM cur INTO @AgentId, @TenantId;

WHILE @@FETCH_STATUS = 0
BEGIN
  EXEC oe.GenerateAgentCode @TenantId = @TenantId, @AgentCode = @NewCode OUTPUT;

  UPDATE @ToFill
  SET NewAgentCode = @NewCode
  WHERE AgentId = @AgentId;

  UPDATE oe.Agents
  SET AgentCode = @NewCode,
      ModifiedDate = GETUTCDATE()
  WHERE AgentId = @AgentId;

  FETCH NEXT FROM cur INTO @AgentId, @TenantId;
END

CLOSE cur;
DEALLOCATE cur;

IF @Execute = 1
BEGIN
  COMMIT TRANSACTION;
END
ELSE
BEGIN
  ROLLBACK TRANSACTION;
END

SELECT
  CASE WHEN @Execute = 1 THEN N'EXECUTED' ELSE N'DRY RUN — no changes' END AS Mode,
  COUNT(*) AS RowsTouched
FROM @ToFill;

SELECT
  f.AgentId,
  f.TenantId,
  f.OldAgentCode,
  f.NewAgentCode,
  a.FirstName,
  a.LastName,
  a.Email
FROM @ToFill f
JOIN oe.Agents a ON a.AgentId = f.AgentId
ORDER BY f.CreatedDate ASC;
