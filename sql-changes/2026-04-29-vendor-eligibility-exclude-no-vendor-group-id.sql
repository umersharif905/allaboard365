-- ============================================================================
-- Per-job opt-in: exclude households whose group has no master vendor group ID
-- assigned for this vendor.
--
-- Surfaced on:
--   - Generate Eligibility modal (per-run override, not persisted on the vendor)
--   - Eligibility export scheduled jobs (this column = persistent default)
--
-- Individuals (members with no group) are unaffected — the filter only drops
-- households whose primary IS in a group, when that group has no master
-- vendor group ID for the vendor yet.
-- ============================================================================

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.VendorScheduledJobs')
      AND name = 'ExcludeGroupsMissingVendorGroupId'
)
BEGIN
    ALTER TABLE oe.VendorScheduledJobs
        ADD ExcludeGroupsMissingVendorGroupId BIT NULL;
END;
GO

-- Default existing rows to OFF so behavior is unchanged for vendors not opting in.
UPDATE oe.VendorScheduledJobs
SET ExcludeGroupsMissingVendorGroupId = 0
WHERE ExcludeGroupsMissingVendorGroupId IS NULL;
GO
