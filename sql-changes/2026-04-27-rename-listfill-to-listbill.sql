-- 2026-04-27-rename-listfill-to-listbill.sql
--
-- Renames the GroupType enum value from 'ListFill' to 'ListBill' for any
-- environment that previously ran the 2026-04-24-* migrations (where the
-- value was 'ListFill'). Safe to run on environments that already use the
-- new value or have never seen the old one.

SET XACT_ABORT ON;
GO

------------------------------------------------------------------------------
-- 1. oe.Groups.GroupType
------------------------------------------------------------------------------
IF EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_oe_Groups_GroupType'
    AND parent_object_id = OBJECT_ID('oe.Groups')
)
BEGIN
  ALTER TABLE oe.Groups DROP CONSTRAINT CK_oe_Groups_GroupType;
END
GO

UPDATE oe.Groups SET GroupType = 'ListBill' WHERE GroupType = 'ListFill';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_oe_Groups_GroupType'
    AND parent_object_id = OBJECT_ID('oe.Groups')
)
BEGIN
  ALTER TABLE oe.Groups
    ADD CONSTRAINT CK_oe_Groups_GroupType
      CHECK (GroupType IN ('Standard', 'ListBill'));
END
GO

------------------------------------------------------------------------------
-- 2. oe.GroupTypeChangeRequests.{CurrentType, RequestedType}
------------------------------------------------------------------------------
IF EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_GroupTypeChangeRequests_Types'
    AND parent_object_id = OBJECT_ID('oe.GroupTypeChangeRequests')
)
BEGIN
  ALTER TABLE oe.GroupTypeChangeRequests
    DROP CONSTRAINT CK_GroupTypeChangeRequests_Types;
END
GO

UPDATE oe.GroupTypeChangeRequests SET CurrentType   = 'ListBill' WHERE CurrentType   = 'ListFill';
UPDATE oe.GroupTypeChangeRequests SET RequestedType = 'ListBill' WHERE RequestedType = 'ListFill';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_GroupTypeChangeRequests_Types'
    AND parent_object_id = OBJECT_ID('oe.GroupTypeChangeRequests')
)
BEGIN
  ALTER TABLE oe.GroupTypeChangeRequests
    ADD CONSTRAINT CK_GroupTypeChangeRequests_Types
      CHECK (CurrentType IN ('Standard','ListBill')
         AND RequestedType IN ('Standard','ListBill')
         AND CurrentType <> RequestedType);
END
GO
