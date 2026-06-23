-- ═══════════════════════════════════════════════════════════════════════════
-- OPTIONAL — NOT REQUIRED FOR VENDOR IMPORT. Safe to skip permanently.
--
-- Adds FK MemberSourceKeys.MemberId → oe.Members. Requires SCH-M lock on
-- oe.Members; will fail with Msg 1222 during normal prod traffic (~5 sec timeout).
--
-- Only run during a maintenance window with app traffic paused or minimal.
-- Flip @RunDuringMaintenanceWindow to 1 when intentionally running off-peak.
-- ═══════════════════════════════════════════════════════════════════════════

DECLARE @RunDuringMaintenanceWindow BIT = 0;

IF @RunDuringMaintenanceWindow = 0
BEGIN
  PRINT 'SKIPPED — FK_MemberSourceKeys_Member is optional. Vendor import works without it.';
  PRINT 'To run off-peak: set @RunDuringMaintenanceWindow = 1 at top of this script.';
  RETURN;
END

SET LOCK_TIMEOUT 600000; -- 10 min — only during maintenance window

IF OBJECT_ID('oe.MemberSourceKeys', 'U') IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_MemberSourceKeys_Member'
   )
BEGIN
  ALTER TABLE oe.MemberSourceKeys
    WITH NOCHECK
    ADD CONSTRAINT FK_MemberSourceKeys_Member
    FOREIGN KEY (MemberId) REFERENCES oe.Members (MemberId);

  ALTER TABLE oe.MemberSourceKeys CHECK CONSTRAINT FK_MemberSourceKeys_Member;
  PRINT 'Added FK_MemberSourceKeys_Member.';
END
ELSE IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_MemberSourceKeys_Member')
  PRINT 'FK_MemberSourceKeys_Member already exists.';
ELSE
  PRINT 'oe.MemberSourceKeys does not exist — run vendor-import-schema.sql first.';
GO
