-- =============================================================================
-- Re-link the REAL orphaned Lance + Gabriella Cummins records to Danielle's
-- household and undo the placeholder backfill from the earlier SQL.
-- =============================================================================
-- Background:
--   Earlier today (2026-04-21) we thought the dependent data had been silently
--   dropped server-side. It wasn't — it was ORPHANED. The enrollment-link flow
--   pre-creates dependents + their oe.Enrollments rows with a temporary
--   HouseholdId BEFORE complete-enrollment runs. complete-enrollment was then
--   supposed to re-parent them to the Primary's HouseholdId, but the frontend
--   posted householdMembers:[] (same race condition we fixed in
--   EnrollmentWizard.tsx + enrollment-links.js), so the pre-created dependent
--   rows were stranded.
--
--   As a result:
--     • The REAL Lance/Gabriella rows exist with full DOB + encrypted SSN,
--       attached to HouseholdId 79EFAC6E-027A-4165-934D-85683DC4B56A (no primary).
--     • Each has 3 oe.Enrollments rows — currently Active, $0 premium, effective
--       2026-05-01, but still pinned to HouseholdId 79EFAC6E-... (orphan).
--       (They started as PaymentHold and were flipped to Active when Danielle's
--       payment succeeded, but the HouseholdId was never re-pointed.)
--     • The earlier backfill script
--       (sql-changes/2026-04-21-backfill-lenar-cummins-dependents.sql) inserted
--       two placeholder dependent rows with NULL DOB/SSN under Danielle's real
--       HouseholdId. Those are duplicates and need to go — that's why Danielle
--       sees two blank kids in her member portal but not the real ones.
--
-- Danielle (Primary):
--   MemberId/HouseholdId = EF35C902-215D-4207-A5B9-5D2E01AC7EF1
--   UserId               = A0863694-CA12-4EDA-8694-F630C4B38201
--   TenantId             = 1CD92AF7-B6F2-4E48-A8F3-EC6316158826  (MightyWELL Health)
--   AgentId              = 614F0332-3D78-4FA1-87CC-69C6D3F1D143
--   Tier EC, Active, 5 Active enrollments at real prices
--
-- Real orphan kids (keep these, re-point them):
--   Lance      MemberId = A15B1325-40BB-4D3E-8AE6-AC2B72A85927  DOB 2020-01-01  Male
--   Gabriella  MemberId = 27F0189C-D37D-4D8D-B807-5BB7E31618ED  DOB 2021-05-11  Female
--   Orphan HouseholdId  = 79EFAC6E-027A-4165-934D-85683DC4B56A
--   Orphan AgentId      = 5B77C0F5-5BC7-409A-B55E-3CFEFEC33A67
--
-- Placeholder dupes created by earlier SQL (delete these):
--   Lance dupe     MemberId = 603936D2-1628-4F3F-9B64-A9DA1B5322A0
--                  UserId   = 68EA4093-01AB-4A25-B059-BA634EE3205B
--   Gabriella dupe MemberId = 3563CD6A-FE7E-40E1-81B1-339453678803
--                  UserId   = 889E1AAC-52AE-4A27-AA9B-44C5688A3573
--   (Neither dupe has any oe.Enrollments rows.)
-- =============================================================================

SET XACT_ABORT ON;
BEGIN TRAN;

DECLARE @PrimaryMemberId UNIQUEIDENTIFIER = 'EF35C902-215D-4207-A5B9-5D2E01AC7EF1';
DECLARE @PrimaryUserId   UNIQUEIDENTIFIER = 'A0863694-CA12-4EDA-8694-F630C4B38201';
DECLARE @TenantId        UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
DECLARE @TargetAgentId   UNIQUEIDENTIFIER = '614F0332-3D78-4FA1-87CC-69C6D3F1D143';

DECLARE @OrphanHouseholdId UNIQUEIDENTIFIER = '79EFAC6E-027A-4165-934D-85683DC4B56A';

DECLARE @LanceMemberId     UNIQUEIDENTIFIER = 'A15B1325-40BB-4D3E-8AE6-AC2B72A85927';
DECLARE @GabriellaMemberId UNIQUEIDENTIFIER = '27F0189C-D37D-4D8D-B807-5BB7E31618ED';

DECLARE @LanceDupeMemberId     UNIQUEIDENTIFIER = '603936D2-1628-4F3F-9B64-A9DA1B5322A0';
DECLARE @LanceDupeUserId       UNIQUEIDENTIFIER = '68EA4093-01AB-4A25-B059-BA634EE3205B';
DECLARE @GabriellaDupeMemberId UNIQUEIDENTIFIER = '3563CD6A-FE7E-40E1-81B1-339453678803';
DECLARE @GabriellaDupeUserId   UNIQUEIDENTIFIER = '889E1AAC-52AE-4A27-AA9B-44C5688A3573';

-- ---------- Guards ----------
IF NOT EXISTS (
    SELECT 1 FROM oe.Members
    WHERE MemberId = @PrimaryMemberId
      AND UserId   = @PrimaryUserId
      AND TenantId = @TenantId
      AND RelationshipType = 'P'
      AND Status = 'Active'
)
BEGIN
    RAISERROR('Primary member (Danielle Lenar-Cummins) not found with expected IDs. Aborting.', 16, 1);
    ROLLBACK TRAN; RETURN;
END;

IF NOT EXISTS (
    SELECT 1 FROM oe.Members
    WHERE MemberId = @LanceMemberId
      AND HouseholdId = @OrphanHouseholdId
      AND RelationshipType = 'C'
) OR NOT EXISTS (
    SELECT 1 FROM oe.Members
    WHERE MemberId = @GabriellaMemberId
      AND HouseholdId = @OrphanHouseholdId
      AND RelationshipType = 'C'
)
BEGIN
    RAISERROR('Expected real orphan kids not found in orphan household. Aborting.', 16, 1);
    ROLLBACK TRAN; RETURN;
END;

-- Placeholder dupes should exist and have NO enrollments (bomb-out if unexpectedly enrolled)
IF EXISTS (
    SELECT 1 FROM oe.Enrollments
    WHERE MemberId IN (@LanceDupeMemberId, @GabriellaDupeMemberId)
)
BEGIN
    RAISERROR('Placeholder dupe members have enrollment rows. Inspect before deleting. Aborting.', 16, 1);
    ROLLBACK TRAN; RETURN;
END;

-- ---------- 1. Re-parent the real orphan dependents to Danielle's household ----------
UPDATE oe.Members
SET HouseholdId  = @PrimaryMemberId,
    AgentId      = @TargetAgentId,
    ModifiedBy   = @PrimaryUserId,
    ModifiedDate = SYSUTCDATETIME()
WHERE MemberId IN (@LanceMemberId, @GabriellaMemberId);

-- ---------- 2. Re-parent their enrollment rows + activate them ----------
-- These were left as PaymentHold $0 because complete-enrollment never finalized them.
-- Danielle is already paying EC tier pricing on her own enrollments, so the dependent
-- enrollment rows stay at $0 premium (dependent coverage is rolled up into the primary).
-- If the vendor/commission logic requires a non-zero premium on dependent rows, that
-- will need a separate product-level review.
UPDATE oe.Enrollments
SET HouseholdId  = @PrimaryMemberId,
    AgentId      = @TargetAgentId,
    Status       = 'Active',
    ModifiedBy   = @PrimaryUserId,
    ModifiedDate = SYSUTCDATETIME()
WHERE MemberId IN (@LanceMemberId, @GabriellaMemberId);

-- ---------- 3. Remove the placeholder duplicate dependent rows ----------
DELETE FROM oe.UserRoles
WHERE UserId IN (@LanceDupeUserId, @GabriellaDupeUserId);

DELETE FROM oe.Members
WHERE MemberId IN (@LanceDupeMemberId, @GabriellaDupeMemberId);

DELETE FROM oe.Users
WHERE UserId IN (@LanceDupeUserId, @GabriellaDupeUserId);

-- ---------- 4. Verification (inspect before COMMIT) ----------
PRINT '--- Household after re-link ---';
SELECT m.MemberId, m.HouseholdId, m.RelationshipType, m.Status, m.Tier, m.EnrollmentType,
       m.DateOfBirth, CASE WHEN m.SSN IS NULL THEN NULL ELSE LEN(m.SSN) END AS SsnLen,
       m.Gender, m.AgentId,
       u.FirstName, u.LastName, u.Email
FROM oe.Members m
JOIN oe.Users u ON u.UserId = m.UserId
WHERE m.HouseholdId = @PrimaryMemberId
ORDER BY CASE m.RelationshipType WHEN 'P' THEN 0 WHEN 'S' THEN 1 ELSE 2 END, u.FirstName;

PRINT '--- Enrollments after re-link ---';
SELECT e.EnrollmentId, e.MemberId, e.ProductId, e.Status, e.PremiumAmount,
       e.HouseholdId, e.AgentId, e.EffectiveDate
FROM oe.Enrollments e
WHERE e.HouseholdId = @PrimaryMemberId
ORDER BY e.MemberId, e.CreatedDate;

PRINT '--- Orphan household should now be empty ---';
SELECT COUNT(*) AS OrphanMemberCount
FROM oe.Members WHERE HouseholdId = @OrphanHouseholdId;

SELECT COUNT(*) AS OrphanEnrollmentCount
FROM oe.Enrollments WHERE HouseholdId = @OrphanHouseholdId;

PRINT '--- Placeholder dupes should be gone ---';
SELECT COUNT(*) AS DupeMemberCount
FROM oe.Members WHERE MemberId IN (@LanceDupeMemberId, @GabriellaDupeMemberId);

SELECT COUNT(*) AS DupeUserCount
FROM oe.Users WHERE UserId IN (@LanceDupeUserId, @GabriellaDupeUserId);

COMMIT TRAN;
-- ROLLBACK TRAN;  -- uncomment the COMMIT above if verification shows anything off
