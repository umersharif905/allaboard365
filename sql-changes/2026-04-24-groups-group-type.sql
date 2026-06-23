-- 2026-04-24-groups-group-type.sql
--
-- Adds the GroupType column + CHECK constraint to oe.Groups.
--
-- Implementation note: the column is referenced inside the constraint, so the
-- two ALTERs must be deferred-compiled (EXEC) — otherwise SQL Server tries to
-- bind the constraint at parse time, before the column has been added, and
-- fails with "Invalid column name 'GroupType'".

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = 'GroupType' AND Object_ID = Object_ID('oe.Groups')
)
BEGIN
  EXEC('ALTER TABLE oe.Groups ADD GroupType NVARCHAR(20) NOT NULL CONSTRAINT DF_oe_Groups_GroupType DEFAULT (''Standard'')');
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_oe_Groups_GroupType'
    AND parent_object_id = OBJECT_ID('oe.Groups')
)
BEGIN
  EXEC('ALTER TABLE oe.Groups ADD CONSTRAINT CK_oe_Groups_GroupType CHECK (GroupType IN (''Standard'', ''ListBill''))');
END
GO
