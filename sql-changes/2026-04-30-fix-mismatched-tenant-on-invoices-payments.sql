-- Fix invoices + payments that were stamped with the wrong TenantId.
--
-- Background:
-- For 2 households (Rick McKinney F9FE2A1F-... and Ryan Syroid 22B14E15-...),
-- the Members row is on tenant 1CD92AF7-... (MightyWELL Healthcare) but
-- their invoices and payments were stamped with tenant AE8A82A9-...
-- (ShareWELL portal -- a separate, legacy tenant). This appears to be a
-- migration artifact: the Member.TenantId was moved to MightyWELL but the
-- billing rows were left on the old ShareWELL portal tenant.
--
-- This breaks tenant-scoped queries -- specifically the vendor-breakdown
-- "covered-unpaid" bucket logic which filters `inv.TenantId = @TenantId`
-- against the request tenant (MightyWELL). Rick's unpaid 4/1-4/24 invoice
-- is invisible to that query and he keeps showing up under "Covered, no
-- invoice" even though the invoice exists.
--
-- Fix: realign the 4 misaligned invoices and 5 misaligned payments so
-- their TenantId matches the household's primary member's TenantId.
--
-- Idempotent: re-running this is a no-op once the data is aligned.

SET XACT_ABORT ON;
BEGIN TRY
BEGIN TRAN;

-- Pre-check: show what we're about to fix.
PRINT '--- BEFORE ---';
SELECT
  'Invoices' AS Table_Name,
  inv.InvoiceId AS RowId,
  inv.InvoiceNumber AS Identifier,
  inv.HouseholdId,
  inv.TenantId  AS CurrentTenant,
  m.TenantId    AS CorrectTenant,
  u.FirstName + ' ' + u.LastName AS Name
FROM oe.Invoices inv
INNER JOIN oe.Members m
  ON m.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P'
INNER JOIN oe.Users u ON u.UserId = m.UserId
WHERE inv.HouseholdId IS NOT NULL AND inv.TenantId <> m.TenantId

UNION ALL

SELECT
  'Payments',
  p.PaymentId,
  CAST(p.Amount AS NVARCHAR(50)) + ' on ' + CONVERT(NVARCHAR(20), p.PaymentDate, 120),
  p.HouseholdId,
  p.TenantId,
  m.TenantId,
  u.FirstName + ' ' + u.LastName
FROM oe.Payments p
INNER JOIN oe.Members m
  ON m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P'
INNER JOIN oe.Users u ON u.UserId = m.UserId
WHERE p.HouseholdId IS NOT NULL AND p.TenantId <> m.TenantId
ORDER BY Name, Table_Name, Identifier;

UPDATE inv
SET inv.TenantId = m.TenantId,
    inv.ModifiedDate = SYSUTCDATETIME()
FROM oe.Invoices inv
INNER JOIN oe.Members m
  ON m.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P'
WHERE inv.HouseholdId IS NOT NULL AND inv.TenantId <> m.TenantId;

DECLARE @InvFixed INT = @@ROWCOUNT;

UPDATE p
SET p.TenantId = m.TenantId,
    p.ModifiedDate = SYSUTCDATETIME()
FROM oe.Payments p
INNER JOIN oe.Members m
  ON m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P'
WHERE p.HouseholdId IS NOT NULL AND p.TenantId <> m.TenantId;

DECLARE @PayFixed INT = @@ROWCOUNT;

PRINT 'Realigned invoices: ' + CAST(@InvFixed AS NVARCHAR(10));
PRINT 'Realigned payments: ' + CAST(@PayFixed AS NVARCHAR(10));

COMMIT TRAN;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  THROW;
END CATCH;

-- Verify: this should return zero rows.
PRINT '--- AFTER (should be empty) ---';
SELECT 'Invoices' AS T, COUNT(*) AS RemainingMisaligned
FROM oe.Invoices inv
INNER JOIN oe.Members m
  ON m.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P'
WHERE inv.HouseholdId IS NOT NULL AND inv.TenantId <> m.TenantId
UNION ALL
SELECT 'Payments', COUNT(*)
FROM oe.Payments p
INNER JOIN oe.Members m
  ON m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P'
WHERE p.HouseholdId IS NOT NULL AND p.TenantId <> m.TenantId;
