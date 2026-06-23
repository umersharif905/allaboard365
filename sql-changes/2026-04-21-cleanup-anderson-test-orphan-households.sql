-- =============================================================================
-- Clean up two stranded "orphan" Anderson dependent households.
-- =============================================================================
-- Context:
--   While investigating the Lenar-Cummins orphan case on 2026-04-21, we scanned
--   for all Active dependent rows whose HouseholdId has NO Primary member.
--   Three total came back:
--     1. Lance/Gabriella Cummins         (HouseholdId 79EFAC6E-...)   ← handled
--        separately by 2026-04-21-adopt-lenar-cummins-orphan-dependents.sql
--     2. Rachel/Ashton Anderson dupe #1  (HouseholdId 55A7E0AB-...)   ← this file
--     3. Rachel/Ashton Anderson dupe #2  (HouseholdId 05B216EC-...)   ← this file
--
--   Both Anderson orphan households are test data from internal Gmail +tag
--   aliases (e.g. chris.anderson70+55@gmail.com). Neither has ANY rows in
--   oe.Enrollments — they're just abandoned oe.Members + oe.Users rows from
--   earlier enrollment attempts that never completed. The real Anderson
--   primary (Rachel Anderson, MemberId 9953C12F-..., HouseholdId BD21F0C6-...)
--   was created fresh on 2026-01-15 and has its own full household intact.
--
--   Strategy: hard-delete the 4 stranded dependent rows (2 per orphan household)
--   plus their paired Users + UserRoles. Safe because EnrollCount = 0.
--
--   TenantId: 1CD92AF7-B6F2-4E48-A8F3-EC6316158826 (MightyWELL Health)
-- =============================================================================

SET XACT_ABORT ON;
BEGIN TRAN;

-- Orphan household #1: 55A7E0AB-B2FD-4943-8368-25909FB010A3 (created 2025-12-25)
DECLARE @Orphan1_RachelMemberId  UNIQUEIDENTIFIER = '32BB3533-F283-4B87-A71A-370834F00DFF';
DECLARE @Orphan1_RachelUserId    UNIQUEIDENTIFIER = (SELECT UserId FROM oe.Members WHERE MemberId = @Orphan1_RachelMemberId);
DECLARE @Orphan1_AshtonMemberId  UNIQUEIDENTIFIER = 'FCECF670-1C0B-4B68-A461-DF98269611AE';
DECLARE @Orphan1_AshtonUserId    UNIQUEIDENTIFIER = (SELECT UserId FROM oe.Members WHERE MemberId = @Orphan1_AshtonMemberId);

-- Orphan household #2: 05B216EC-EA6B-4E1D-ADB6-EA30B402CF51 (created 2026-01-08)
DECLARE @Orphan2_RachelMemberId  UNIQUEIDENTIFIER = '2DADCBE9-059D-469A-96E7-374B4615028D';
DECLARE @Orphan2_RachelUserId    UNIQUEIDENTIFIER = (SELECT UserId FROM oe.Members WHERE MemberId = @Orphan2_RachelMemberId);
DECLARE @Orphan2_AshtonMemberId  UNIQUEIDENTIFIER = '6B768CCC-1FBE-4E08-9D60-949E106C0248';
DECLARE @Orphan2_AshtonUserId    UNIQUEIDENTIFIER = (SELECT UserId FROM oe.Members WHERE MemberId = @Orphan2_AshtonMemberId);

-- Guard: none of these members should have any enrollments.
IF EXISTS (
    SELECT 1 FROM oe.Enrollments
    WHERE MemberId IN (
        @Orphan1_RachelMemberId, @Orphan1_AshtonMemberId,
        @Orphan2_RachelMemberId, @Orphan2_AshtonMemberId
    )
)
BEGIN
    RAISERROR('One or more Anderson orphan members unexpectedly has enrollments. Aborting.', 16, 1);
    ROLLBACK TRAN; RETURN;
END;

-- Guard: none should be the real primary Rachel Anderson (MemberId 9953C12F-5AF1-4F29-A7B7-75B3AA962FD4).
IF EXISTS (
    SELECT 1 FROM oe.Members
    WHERE MemberId IN (
        @Orphan1_RachelMemberId, @Orphan1_AshtonMemberId,
        @Orphan2_RachelMemberId, @Orphan2_AshtonMemberId
    )
    AND RelationshipType = 'P'
)
BEGIN
    RAISERROR('Refusing to delete a Primary member via the orphan cleanup script. Aborting.', 16, 1);
    ROLLBACK TRAN; RETURN;
END;

DELETE FROM oe.UserRoles
WHERE UserId IN (
    @Orphan1_RachelUserId, @Orphan1_AshtonUserId,
    @Orphan2_RachelUserId, @Orphan2_AshtonUserId
);

DELETE FROM oe.Members
WHERE MemberId IN (
    @Orphan1_RachelMemberId, @Orphan1_AshtonMemberId,
    @Orphan2_RachelMemberId, @Orphan2_AshtonMemberId
);

DELETE FROM oe.Users
WHERE UserId IN (
    @Orphan1_RachelUserId, @Orphan1_AshtonUserId,
    @Orphan2_RachelUserId, @Orphan2_AshtonUserId
);

-- Verification — these should all return 0 rows.
PRINT '--- Remaining Member rows in Anderson orphan households (expect 0) ---';
SELECT COUNT(*) AS RemainingOrphanMembers
FROM oe.Members
WHERE HouseholdId IN (
    '55A7E0AB-B2FD-4943-8368-25909FB010A3',
    '05B216EC-EA6B-4E1D-ADB6-EA30B402CF51'
);

PRINT '--- Global orphan-household count after cleanup (expect 1: only Lance/Gabriella left) ---';
SELECT COUNT(*) AS OrphanHouseholdCount
FROM (
    SELECT m.HouseholdId
    FROM oe.Members m
    WHERE m.Status = 'Active'
      AND m.RelationshipType IN ('S','C')
    GROUP BY m.HouseholdId
    HAVING NOT EXISTS (
        SELECT 1 FROM oe.Members p
        WHERE p.HouseholdId = m.HouseholdId
          AND p.RelationshipType = 'P'
    )
) AS orphans;

COMMIT TRAN;
-- ROLLBACK TRAN;  -- uncomment COMMIT above if verification shows anything off
