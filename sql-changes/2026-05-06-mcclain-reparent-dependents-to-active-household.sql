-- =============================================================================
-- Re-parent Tiffany + Charleston McClain to Charles McClain's ACTIVE household
-- and align oe.Enrollments.HouseholdId (duplicate-account / wrong HouseholdId).
-- =============================================================================
-- Run order:
--   1) @Apply = 0 (default) — prints DRY RUN only; no data changes.
--   2) Review output: only the two dependent MemberIds + their enrollments must appear
--      under "WILL BE UPDATED"; terminated primary must appear only under "NOT updated".
--      Dependent enrollments today are often Inactive with TerminationDate set (legacy split).
--      APPLY also sets Status = 'Active', TerminationDate = NULL (PremiumAmount unchanged).
--      oe.Members.ModifiedDate and oe.Enrollments.ModifiedDate are set to GETUTCDATE() on
--      apply so EligibilityIncludeOnlyChanges / e.ModifiedDate > lastSentAt picks up rows.
--   3) Set @Apply = 1 — runs the same guards, then UPDATEs + COMMIT.
--
-- Background (prod snapshot 2026-05-06):
--   Active primary (keep):  chipmcclain6@gmail.com
--     UserId      = 7C9F9104-0B42-41C7-BEFE-B7ADA70F447C
--     MemberId    = ADBF8860-BB54-404D-BDB8-F65F3C2652D0
--     HouseholdId = 0AC345C5-DC28-4CD8-939E-E22082BE4CF0  (NOT equal to MemberId)
--     TenantId    = 1CD92AF7-B6F2-4E48-A8F3-EC6316158826 (MightyWELL Health)
--
--   Dependents (move FROM old household):
--     Tiffany     MemberId = AAE988FC-F04F-4DAC-A578-BA59AA75A2BB  (S)  tiffanyjmcclain@yahoo.com
--     Charleston  MemberId = F3FEA554-4321-404A-92CB-D053876A87EF  (C)  dependent-...@noemail.com
--
--   Old household (terminated primary chipmcclain6+old@gmail.com):
--     SourceHouseholdId = 58B769A7-C5DA-41F1-A1C8-475AF085427B
--     TerminatedPrimaryMemberId = same GUID (MemberId = HouseholdId for that legacy row)
--
--   This script does NOT modify the terminated primary member
--   (58B769A7-C5DA-41F1-A1C8-475AF085427B) or its enrollment rows.
--
-- Billing artifacts on SourceHouseholdId (review separately — never auto-updated here):
--   * oe.Payments: 83289DBB-90B2-4D1E-A42E-4602AB74D488 — Status RecurringScheduled, $816.14
--   * oe.IndividualRecurringSchedules: cancelled schedule on source household
-- =============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Apply BIT = 0; /* 0 = dry run (SELECTs only); 1 = execute UPDATEs + COMMIT */

DECLARE @PrimaryMemberId             UNIQUEIDENTIFIER = 'ADBF8860-BB54-404D-BDB8-F65F3C2652D0';
DECLARE @PrimaryUserId               UNIQUEIDENTIFIER = '7C9F9104-0B42-41C7-BEFE-B7ADA70F447C';
DECLARE @TenantId                    UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';

DECLARE @TargetHouseholdId           UNIQUEIDENTIFIER = '0AC345C5-DC28-4CD8-939E-E22082BE4CF0';
DECLARE @SourceHouseholdId           UNIQUEIDENTIFIER = '58B769A7-C5DA-41F1-A1C8-475AF085427B';
DECLARE @TerminatedPrimaryMemberId  UNIQUEIDENTIFIER = '58B769A7-C5DA-41F1-A1C8-475AF085427B';

DECLARE @TiffanyMemberId             UNIQUEIDENTIFIER = 'AAE988FC-F04F-4DAC-A578-BA59AA75A2BB';
DECLARE @CharlestonMemberId          UNIQUEIDENTIFIER = 'F3FEA554-4321-404A-92CB-D053876A87EF';

DECLARE @TargetAgentId UNIQUEIDENTIFIER =
    (SELECT m.AgentId FROM oe.Members m WHERE m.MemberId = @PrimaryMemberId);

BEGIN TRY
    IF @TargetAgentId IS NULL
        RAISERROR('Could not resolve AgentId from primary member. Aborting.', 16, 1);

    IF NOT EXISTS (
        SELECT 1 FROM oe.Members
        WHERE MemberId = @PrimaryMemberId
          AND UserId = @PrimaryUserId
          AND TenantId = @TenantId
          AND HouseholdId = @TargetHouseholdId
          AND RelationshipType = 'P'
          AND Status = 'Active'
    )
        RAISERROR('Active primary Charles McClain not found with expected IDs/HouseholdId. Aborting.', 16, 1);

    IF NOT EXISTS (
        SELECT 1 FROM oe.Members
        WHERE MemberId = @TiffanyMemberId
          AND HouseholdId = @SourceHouseholdId
          AND RelationshipType = 'S'
          AND Status = 'Active'
    ) OR NOT EXISTS (
        SELECT 1 FROM oe.Members
        WHERE MemberId = @CharlestonMemberId
          AND HouseholdId = @SourceHouseholdId
          AND RelationshipType = 'C'
          AND Status = 'Active'
    )
        RAISERROR('Expected dependents not found on source household (already moved?). Aborting.', 16, 1);

    IF EXISTS (
        SELECT 1
        FROM oe.Enrollments e
        WHERE e.MemberId IN (@TiffanyMemberId, @CharlestonMemberId)
        GROUP BY e.MemberId, e.ProductId
        HAVING COUNT(*) > 1
    )
        RAISERROR('Duplicate (MemberId, ProductId) on dependent enrollments. Inspect manually. Aborting.', 16, 1);

    /* ---------------------------------------------------------------------- */
    /* DRY RUN — always printed (whether or not @Apply = 1)                    */
    /* ---------------------------------------------------------------------- */
    PRINT N'';
    PRINT N'========== DRY RUN: scope & impact (no changes when @Apply = 0) ==========';

    PRINT N'--- Parameter summary ---';
    SELECT
        @Apply AS ApplyFlag,
        @PrimaryMemberId AS PrimaryMemberId,
        @TargetHouseholdId AS TargetHouseholdId,
        @SourceHouseholdId AS SourceHouseholdId,
        @TiffanyMemberId AS TiffanyMemberId,
        @CharlestonMemberId AS CharlestonMemberId,
        @TerminatedPrimaryMemberId AS TerminatedPrimaryMemberId_NotUpdated,
        @TargetAgentId AS NewAgentIdForDependents;

    PRINT N'--- Active primary (must match; read-only) ---';
    SELECT m.MemberId, m.UserId, m.HouseholdId, m.RelationshipType, m.Status, m.AgentId,
           u.Email, u.FirstName, u.LastName
    FROM oe.Members m
    JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.MemberId = @PrimaryMemberId;

    PRINT N'--- Members THAT WILL BE UPDATED (expect exactly 2 rows) ---';
    SELECT
        m.MemberId,
        m.HouseholdId AS CurrentHouseholdId,
        @TargetHouseholdId AS NewHouseholdId,
        m.AgentId AS CurrentAgentId,
        @TargetAgentId AS NewAgentId,
        m.RelationshipType,
        m.Status,
        m.MemberSequence AS CurrentMemberSequence,
        CASE m.MemberId
            WHEN @TiffanyMemberId THEN 2
            WHEN @CharlestonMemberId THEN 3
        END AS NewMemberSequence,
        m.ModifiedDate AS CurrentMemberModifiedDate,
        u.Email, u.FirstName, u.LastName
    FROM oe.Members m
    JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.MemberId IN (@TiffanyMemberId, @CharlestonMemberId);

    DECLARE @EnrollmentRowsToTouch INT = (
        SELECT COUNT(*) FROM oe.Enrollments e
        WHERE e.MemberId IN (@TiffanyMemberId, @CharlestonMemberId)
    );

    PRINT N'--- Enrollments THAT WILL BE UPDATED (household, agent, activate, clear termination; ModifiedDate <- GETUTCDATE on apply) ---';
    SELECT
        e.EnrollmentId,
        e.MemberId,
        e.HouseholdId AS CurrentHouseholdId,
        @TargetHouseholdId AS NewHouseholdId,
        e.AgentId AS CurrentAgentId,
        @TargetAgentId AS NewAgentId,
        e.Status AS CurrentStatus,
        N'Active' AS NewStatus,
        e.TerminationDate AS CurrentTerminationDate,
        CAST(NULL AS DATETIME2) AS NewTerminationDate,
        e.ModifiedDate AS CurrentModifiedDate,
        e.PremiumAmount,
        e.EffectiveDate,
        e.ProductId
    FROM oe.Enrollments e
    WHERE e.MemberId IN (@TiffanyMemberId, @CharlestonMemberId)
    ORDER BY e.MemberId, e.CreatedDate;

    PRINT N'--- Duplicate check: no two rows per (MemberId, ProductId) for dependents (expect 0 rows) ---';
    SELECT e.MemberId, e.ProductId, COUNT(*) AS RowCnt
    FROM oe.Enrollments e
    WHERE e.MemberId IN (@TiffanyMemberId, @CharlestonMemberId)
    GROUP BY e.MemberId, e.ProductId
    HAVING COUNT(*) > 1;

    PRINT N'--- After APPLY: expect 3 Active product rows per dependent (same 3 ProductIds as primary, no dupes per member) ---';
    SELECT e.ProductId, COUNT(DISTINCT e.MemberId) AS MemberCount
    FROM oe.Enrollments e
    WHERE e.MemberId IN (@TiffanyMemberId, @CharlestonMemberId)
    GROUP BY e.ProductId
    ORDER BY e.ProductId;

    PRINT N'--- Row counts DML will touch ---';
    SELECT N'oe.Members' AS TableName, CAST(COUNT(*) AS INT) AS RowsAffected
    FROM oe.Members m
    WHERE m.MemberId IN (@TiffanyMemberId, @CharlestonMemberId)
    UNION ALL
    SELECT N'oe.Enrollments', CAST(@EnrollmentRowsToTouch AS INT);

    PRINT N'--- NOT updated: terminated primary member (must be 1 row on source household) ---';
    SELECT m.MemberId, m.HouseholdId, m.RelationshipType, m.Status, m.AgentId,
           u.Email, u.FirstName, u.LastName
    FROM oe.Members m
    JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.MemberId = @TerminatedPrimaryMemberId;

    PRINT N'--- NOT updated: enrollments belonging ONLY to terminated primary ---';
    SELECT e.EnrollmentId, e.MemberId, e.HouseholdId, e.Status, e.PremiumAmount
    FROM oe.Enrollments e
    WHERE e.MemberId = @TerminatedPrimaryMemberId
    ORDER BY e.CreatedDate;

    PRINT N'--- Sanity: members on source household (expect 3 rows: P terminated + S + C) ---';
    SELECT m.MemberId, m.RelationshipType, m.Status, u.Email
    FROM oe.Members m
    LEFT JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.HouseholdId = @SourceHouseholdId
    ORDER BY CASE m.RelationshipType WHEN 'P' THEN 0 WHEN 'S' THEN 1 ELSE 2 END;

    PRINT N'--- Sanity: enrollments still keyed to source HouseholdId (includes terminated primary + dependents) ---';
    SELECT e.EnrollmentId, e.MemberId, e.HouseholdId, e.Status
    FROM oe.Enrollments e
    WHERE e.HouseholdId = @SourceHouseholdId
    ORDER BY e.MemberId, e.CreatedDate;

    PRINT N'--- Billing on source household (this script does not move these) ---';
    SELECT N'Payments' AS Artifact, COUNT(*) AS Cnt
    FROM oe.Payments p WHERE p.HouseholdId = @SourceHouseholdId
    UNION ALL
    SELECT N'IndividualRecurringSchedules', COUNT(*)
    FROM oe.IndividualRecurringSchedules irs WHERE irs.HouseholdId = @SourceHouseholdId;

    SELECT p.PaymentId, p.HouseholdId, p.Amount, p.Status, p.PaymentDate
    FROM oe.Payments p
    WHERE p.HouseholdId = @SourceHouseholdId;

    SELECT irs.ScheduleId, irs.HouseholdId, irs.MonthlyAmount, irs.IsActive, irs.DimeScheduleId
    FROM oe.IndividualRecurringSchedules irs
    WHERE irs.HouseholdId = @SourceHouseholdId;

    IF @Apply = 0
    BEGIN
        PRINT N'';
        PRINT N'>>> DRY RUN ONLY: no UPDATE executed. Set @Apply = 1 to apply changes. <<<';
        RETURN;
    END;

    /* ---------------------------------------------------------------- apply --- */
    PRINT N'';
    PRINT N'========== APPLY: executing UPDATEs ==========';

    BEGIN TRAN;

    UPDATE oe.Members
    SET HouseholdId    = @TargetHouseholdId,
        AgentId        = @TargetAgentId,
        MemberSequence = CASE MemberId
                           WHEN @TiffanyMemberId THEN 2
                           WHEN @CharlestonMemberId THEN 3
                           ELSE MemberSequence
                         END,
        ModifiedBy     = @PrimaryUserId,
        ModifiedDate   = GETUTCDATE()
    WHERE MemberId IN (@TiffanyMemberId, @CharlestonMemberId);

    DECLARE @RcMembers INT = @@ROWCOUNT;
    IF @RcMembers <> 2
    BEGIN
        ROLLBACK TRAN;
        RAISERROR(N'Expected exactly 2 member rows updated; got %d. Rolled back.', 16, 1, @RcMembers);
    END;

    UPDATE oe.Enrollments
    SET HouseholdId     = @TargetHouseholdId,
        AgentId         = @TargetAgentId,
        Status          = N'Active',
        TerminationDate = NULL,
        ModifiedBy      = @PrimaryUserId,
        ModifiedDate    = GETUTCDATE()
    WHERE MemberId IN (@TiffanyMemberId, @CharlestonMemberId);

    DECLARE @RcEnroll INT = @@ROWCOUNT;
    IF @RcEnroll <> @EnrollmentRowsToTouch
    BEGIN
        ROLLBACK TRAN;
        RAISERROR(N'Enrollment update rowcount mismatch: expected %d, got %d. Rolled back.', 16, 1, @EnrollmentRowsToTouch, @RcEnroll);
    END;

    PRINT N'--- POST: household members (target) ---';
    SELECT m.MemberId, m.HouseholdId, m.RelationshipType, m.Status, m.MemberSequence, m.AgentId,
           m.ModifiedDate,
           u.FirstName, u.LastName, u.Email
    FROM oe.Members m
    JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.HouseholdId = @TargetHouseholdId
    ORDER BY CASE m.RelationshipType WHEN 'P' THEN 0 WHEN 'S' THEN 1 ELSE 2 END, m.MemberSequence, u.FirstName;

    PRINT N'--- POST: enrollments for moved members ---';
    SELECT e.EnrollmentId, e.MemberId, e.HouseholdId, e.AgentId, e.Status, e.TerminationDate,
           e.PremiumAmount, e.EffectiveDate, e.ProductId, e.ModifiedDate
    FROM oe.Enrollments e
    WHERE e.MemberId IN (@TiffanyMemberId, @CharlestonMemberId)
    ORDER BY e.MemberId, e.CreatedDate;

    PRINT N'--- POST: remaining members on source household (expect terminated primary only) ---';
    SELECT m.MemberId, m.HouseholdId, m.RelationshipType, m.Status, u.Email
    FROM oe.Members m
    LEFT JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.HouseholdId = @SourceHouseholdId;

    COMMIT TRAN;
    PRINT N'Done: committed.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRAN;
    DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
    RAISERROR(N'Failed: %s', 16, 1, @Err);
END CATCH;
GO

-- =============================================================================
-- OPTIONAL (run only after ops review — separate batch)
-- =============================================================================
-- UPDATE oe.Payments
-- SET HouseholdId = '0AC345C5-DC28-4CD8-939E-E22082BE4CF0',
--     ModifiedDate  = SYSUTCDATETIME(),
--     ModifiedBy    = '7C9F9104-0B42-41C7-BEFE-B7ADA70F447C'
-- WHERE PaymentId   = '83289DBB-90B2-4D1E-A42E-4602AB74D488'
--   AND HouseholdId = '58B769A7-C5DA-41F1-A1C8-475AF085427B';
--
-- UPDATE oe.IndividualRecurringSchedules
-- SET HouseholdId  = '0AC345C5-DC28-4CD8-939E-E22082BE4CF0',
--     ModifiedDate = SYSUTCDATETIME()
-- WHERE ScheduleId = '4876BF7E-B00E-48CA-883D-3CFA3CD3B31E'
--   AND HouseholdId = '58B769A7-C5DA-41F1-A1C8-475AF085427B';
