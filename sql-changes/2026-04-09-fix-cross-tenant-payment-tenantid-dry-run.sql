/*
  Fix Payment TenantId mismatch for two known payments.

  Scenario
  - Members + recipient agents/agencies belong to MightyWELL Health.
  - These two oe.Payments rows currently have ShareWELL TenantId.

  Usage
  1) Dry run (default): keep @ApplyChanges = 0
  2) Apply: set @ApplyChanges = 1 and run again

  Safety
  - Verifies the two PaymentIds exist.
  - Verifies current TenantId is either expected current or already target.
  - Runs UPDATE inside a transaction when applying.
*/

SET NOCOUNT ON;

DECLARE @ApplyChanges BIT = 0;
DECLARE @ExpectedCurrentTenantId UNIQUEIDENTIFIER = 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6'; -- ShareWELL Health
DECLARE @TargetTenantId UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826'; -- MightyWELL Health

DECLARE @Targets TABLE (PaymentId UNIQUEIDENTIFIER PRIMARY KEY);
INSERT INTO @Targets (PaymentId)
VALUES
  ('712CB88D-1FCA-4D25-96A7-E54E885A158D'),
  ('5FF62512-7262-452A-9A18-B90DB1521C25');

/* ------------------------------------------------------------------ */
/* 1) DRY RUN - current state                                          */
/* ------------------------------------------------------------------ */
SELECT
  p.PaymentId,
  p.PaymentDate,
  p.Status,
  p.Amount AS PaymentAmount,
  p.TenantId AS PaymentTenantId,
  pt.Name AS PaymentTenantName,
  p.HouseholdId,
  hp.MemberId AS PrimaryMemberId,
  hu.FirstName + ' ' + hu.LastName AS PrimaryMemberName,
  hp.TenantId AS PrimaryMemberTenantId,
  mt.Name AS PrimaryMemberTenantName,
  p.AgentId AS PaymentAgentId,
  au.FirstName + ' ' + au.LastName AS PaymentAgentName,
  pa.TenantId AS PaymentAgentTenantId,
  at.Name AS PaymentAgentTenantName
FROM @Targets t
LEFT JOIN oe.Payments p ON p.PaymentId = t.PaymentId
LEFT JOIN oe.Tenants pt ON pt.TenantId = p.TenantId
LEFT JOIN oe.Members hp ON hp.HouseholdId = p.HouseholdId AND hp.RelationshipType = 'P'
LEFT JOIN oe.Users hu ON hu.UserId = hp.UserId
LEFT JOIN oe.Tenants mt ON mt.TenantId = hp.TenantId
LEFT JOIN oe.Agents pa ON pa.AgentId = p.AgentId
LEFT JOIN oe.Users au ON au.UserId = pa.UserId
LEFT JOIN oe.Tenants at ON at.TenantId = pa.TenantId
ORDER BY p.PaymentDate;

/* Validation summary */
SELECT
  TargetRows = (SELECT COUNT(*) FROM @Targets),
  FoundRows = (SELECT COUNT(*) FROM oe.Payments p INNER JOIN @Targets t ON t.PaymentId = p.PaymentId),
  AlreadyAtTargetTenant = (
    SELECT COUNT(*)
    FROM oe.Payments p
    INNER JOIN @Targets t ON t.PaymentId = p.PaymentId
    WHERE p.TenantId = @TargetTenantId
  ),
  AtExpectedCurrentTenant = (
    SELECT COUNT(*)
    FROM oe.Payments p
    INNER JOIN @Targets t ON t.PaymentId = p.PaymentId
    WHERE p.TenantId = @ExpectedCurrentTenantId
  ),
  OtherTenantValue = (
    SELECT COUNT(*)
    FROM oe.Payments p
    INNER JOIN @Targets t ON t.PaymentId = p.PaymentId
    WHERE p.TenantId NOT IN (@ExpectedCurrentTenantId, @TargetTenantId)
  );

/* ------------------------------------------------------------------ */
/* 2) APPLY (OFF BY DEFAULT)                                           */
/* ------------------------------------------------------------------ */
IF (@ApplyChanges = 1)
BEGIN
  IF ((SELECT COUNT(*) FROM oe.Payments p INNER JOIN @Targets t ON t.PaymentId = p.PaymentId) <> (SELECT COUNT(*) FROM @Targets))
  BEGIN
    THROW 51000, 'One or more target PaymentIds not found. Aborting.', 1;
  END;

  IF EXISTS (
    SELECT 1
    FROM oe.Payments p
    INNER JOIN @Targets t ON t.PaymentId = p.PaymentId
    WHERE p.TenantId NOT IN (@ExpectedCurrentTenantId, @TargetTenantId)
  )
  BEGIN
    THROW 51001, 'At least one target payment has unexpected TenantId (not expected-current and not target). Aborting.', 1;
  END;

  BEGIN TRANSACTION;
  BEGIN TRY
    UPDATE p
      SET p.TenantId = @TargetTenantId,
          p.ModifiedDate = GETUTCDATE()
    FROM oe.Payments p
    INNER JOIN @Targets t ON t.PaymentId = p.PaymentId
    WHERE p.TenantId <> @TargetTenantId;

    DECLARE @UpdatedRows INT = @@ROWCOUNT;

    SELECT
      Message = 'Update applied',
      UpdatedRows = @UpdatedRows,
      TargetTenantId = @TargetTenantId;

    SELECT
      p.PaymentId,
      p.PaymentDate,
      p.TenantId AS PaymentTenantId,
      pt.Name AS PaymentTenantName,
      p.ModifiedDate
    FROM oe.Payments p
    INNER JOIN @Targets t ON t.PaymentId = p.PaymentId
    LEFT JOIN oe.Tenants pt ON pt.TenantId = p.TenantId
    ORDER BY p.PaymentDate;

    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH
END
ELSE
BEGIN
  SELECT Message = 'Dry run only. No updates applied. Set @ApplyChanges = 1 to update.';
END;
