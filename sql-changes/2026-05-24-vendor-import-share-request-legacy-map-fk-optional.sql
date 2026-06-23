-- ═══════════════════════════════════════════════════════════════════════════
-- OPTIONAL — NOT REQUIRED FOR VENDOR IMPORT. Safe to skip permanently.
--
-- Adds FK ShareRequestLegacyMap.ShareRequestId → oe.ShareRequests.
-- Requires SCH-M lock on oe.ShareRequests; fails with Msg 1222 during traffic.
--
-- Prod likely already has this FK from an earlier successful batch.
-- Flip @RunDuringMaintenanceWindow to 1 only during off-peak maintenance.
-- ═══════════════════════════════════════════════════════════════════════════

DECLARE @RunDuringMaintenanceWindow BIT = 0;

IF @RunDuringMaintenanceWindow = 0
BEGIN
  PRINT 'SKIPPED — FK_ShareRequestLegacyMap_SR is optional. Vendor import works without it.';
  PRINT 'To run off-peak: set @RunDuringMaintenanceWindow = 1 at top of this script.';
  RETURN;
END

SET LOCK_TIMEOUT 600000;

IF OBJECT_ID('oe.ShareRequestLegacyMap', 'U') IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_ShareRequestLegacyMap_SR'
   )
BEGIN
  ALTER TABLE oe.ShareRequestLegacyMap
    WITH NOCHECK
    ADD CONSTRAINT FK_ShareRequestLegacyMap_SR
    FOREIGN KEY (ShareRequestId) REFERENCES oe.ShareRequests (ShareRequestId);

  ALTER TABLE oe.ShareRequestLegacyMap CHECK CONSTRAINT FK_ShareRequestLegacyMap_SR;
  PRINT 'Added FK_ShareRequestLegacyMap_SR.';
END
ELSE IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_ShareRequestLegacyMap_SR')
  PRINT 'FK_ShareRequestLegacyMap_SR already exists.';
ELSE
  PRINT 'oe.ShareRequestLegacyMap does not exist.';
GO
