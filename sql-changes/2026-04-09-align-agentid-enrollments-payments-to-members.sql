-- Align oe.Enrollments.AgentId and oe.Payments.AgentId to oe.Members.AgentId
-- for member-linked records (direct enrollment-linked and household-linked payments).
--
-- Usage:
--   1) Dry run (default): leave @ApplyChanges = 0
--   2) Apply updates:      set @ApplyChanges = 1
--
-- Notes:
-- - Enrollment-linked payments are aligned via p.EnrollmentId -> e.MemberId -> m.AgentId.
-- - Household-only payments (no EnrollmentId) are aligned to the household primary member (RelationshipType = 'P'),
--   falling back to any member in that household if no primary exists.

SET NOCOUNT ON;

DECLARE @ApplyChanges BIT = 0;

DECLARE @ZeroGuid UNIQUEIDENTIFIER = '00000000-0000-0000-0000-000000000000';

IF OBJECT_ID('tempdb..#EnrollmentMismatches') IS NOT NULL DROP TABLE #EnrollmentMismatches;
IF OBJECT_ID('tempdb..#PaymentEnrollmentMismatches') IS NOT NULL DROP TABLE #PaymentEnrollmentMismatches;
IF OBJECT_ID('tempdb..#PaymentHouseholdMismatches') IS NOT NULL DROP TABLE #PaymentHouseholdMismatches;
IF OBJECT_ID('tempdb..#AllMismatches') IS NOT NULL DROP TABLE #AllMismatches;

SELECT
    e.EnrollmentId,
    e.MemberId,
    m.HouseholdId,
    m.GroupId,
    m.TenantId,
    CurrentAgentId = e.AgentId,
    TargetAgentId = m.AgentId
INTO #EnrollmentMismatches
FROM oe.Enrollments e
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
WHERE ISNULL(e.AgentId, @ZeroGuid) <> ISNULL(m.AgentId, @ZeroGuid);

SELECT
    p.PaymentId,
    p.EnrollmentId,
    p.HouseholdId,
    m.MemberId,
    m.GroupId,
    m.TenantId,
    CurrentAgentId = p.AgentId,
    TargetAgentId = m.AgentId
INTO #PaymentEnrollmentMismatches
FROM oe.Payments p
INNER JOIN oe.Enrollments e ON e.EnrollmentId = p.EnrollmentId
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
WHERE ISNULL(p.AgentId, @ZeroGuid) <> ISNULL(m.AgentId, @ZeroGuid);

SELECT
    hpt.PaymentId,
    hpt.EnrollmentId,
    hpt.HouseholdId,
    hpt.MemberId,
    hpt.GroupId,
    hpt.TenantId,
    CurrentAgentId = hpt.CurrentAgentId,
    TargetAgentId = hpt.TargetAgentId
INTO #PaymentHouseholdMismatches
FROM (
    SELECT
        p.PaymentId,
        p.EnrollmentId,
        p.HouseholdId,
        p.AgentId AS CurrentAgentId,
        hm.MemberId,
        hm.GroupId,
        hm.TenantId,
        hm.AgentId AS TargetAgentId
    FROM oe.Payments p
    OUTER APPLY (
        SELECT TOP 1 m.MemberId, m.GroupId, m.TenantId, m.AgentId
        FROM oe.Members m
        WHERE m.HouseholdId = p.HouseholdId
        ORDER BY CASE WHEN m.RelationshipType = 'P' THEN 0 ELSE 1 END, m.ModifiedDate DESC
    ) hm
    WHERE p.EnrollmentId IS NULL
      AND p.HouseholdId IS NOT NULL
) hpt
WHERE hpt.MemberId IS NOT NULL
  AND ISNULL(hpt.CurrentAgentId, @ZeroGuid) <> ISNULL(hpt.TargetAgentId, @ZeroGuid);

CREATE TABLE #AllMismatches (
    MismatchType NVARCHAR(50) NOT NULL,
    RefId NVARCHAR(36) NOT NULL,
    MemberId UNIQUEIDENTIFIER NULL,
    HouseholdId UNIQUEIDENTIFIER NULL,
    GroupId UNIQUEIDENTIFIER NULL,
    TenantId UNIQUEIDENTIFIER NULL,
    CurrentAgentId UNIQUEIDENTIFIER NULL,
    TargetAgentId UNIQUEIDENTIFIER NULL
);

INSERT INTO #AllMismatches (MismatchType, RefId, MemberId, HouseholdId, GroupId, TenantId, CurrentAgentId, TargetAgentId)
SELECT
    'Enrollment',
    CAST(em.EnrollmentId AS NVARCHAR(36)),
    em.MemberId,
    em.HouseholdId,
    em.GroupId,
    em.TenantId,
    em.CurrentAgentId,
    em.TargetAgentId
FROM #EnrollmentMismatches em;

INSERT INTO #AllMismatches (MismatchType, RefId, MemberId, HouseholdId, GroupId, TenantId, CurrentAgentId, TargetAgentId)
SELECT
    'PaymentByEnrollment',
    CAST(pem.PaymentId AS NVARCHAR(36)),
    pem.MemberId,
    pem.HouseholdId,
    pem.GroupId,
    pem.TenantId,
    pem.CurrentAgentId,
    pem.TargetAgentId
FROM #PaymentEnrollmentMismatches pem;

INSERT INTO #AllMismatches (MismatchType, RefId, MemberId, HouseholdId, GroupId, TenantId, CurrentAgentId, TargetAgentId)
SELECT
    'PaymentByHousehold',
    CAST(phm.PaymentId AS NVARCHAR(36)),
    phm.MemberId,
    phm.HouseholdId,
    phm.GroupId,
    phm.TenantId,
    phm.CurrentAgentId,
    phm.TargetAgentId
FROM #PaymentHouseholdMismatches phm;

SELECT
    MismatchType,
    CountRows = COUNT(1)
FROM #AllMismatches
GROUP BY MismatchType
ORDER BY MismatchType;

-- Dry-run impact summary by tenant + group (what clients/groups would be touched)
SELECT
    TenantId = am.TenantId,
    TenantName = t.Name,
    GroupId = am.GroupId,
    GroupName = g.Name,
    EnrollmentRowsToUpdate = SUM(CASE WHEN am.MismatchType = 'Enrollment' THEN 1 ELSE 0 END),
    PaymentRowsToUpdate = SUM(CASE WHEN am.MismatchType IN ('PaymentByEnrollment', 'PaymentByHousehold') THEN 1 ELSE 0 END),
    DistinctHouseholds = COUNT(DISTINCT am.HouseholdId),
    DistinctMembers = COUNT(DISTINCT am.MemberId)
FROM #AllMismatches am
LEFT JOIN oe.Tenants t ON t.TenantId = am.TenantId
LEFT JOIN oe.Groups g ON g.GroupId = am.GroupId
GROUP BY am.TenantId, t.Name, am.GroupId, g.Name
ORDER BY t.Name, g.Name;

-- Dry-run impacted clients (deduped by household + target agent)
SELECT TOP 500
    d.TenantId,
    TenantName = t.Name,
    d.GroupId,
    GroupName = g.Name,
    d.HouseholdId,
    PrimaryMemberId = pm.MemberId,
    ClientName = CONCAT(COALESCE(u.FirstName, ''), CASE WHEN u.FirstName IS NOT NULL AND u.LastName IS NOT NULL THEN ' ' ELSE '' END, COALESCE(u.LastName, '')),
    CurrentAgentId = d.CurrentAgentId,
    TargetAgentId = d.TargetAgentId
FROM (
    SELECT DISTINCT
        am.TenantId,
        am.GroupId,
        am.HouseholdId,
        am.CurrentAgentId,
        am.TargetAgentId
    FROM #AllMismatches am
) d
OUTER APPLY (
    SELECT TOP 1 m.MemberId, m.UserId
    FROM oe.Members m
    WHERE m.HouseholdId = d.HouseholdId
    ORDER BY CASE WHEN m.RelationshipType = 'P' THEN 0 ELSE 1 END, m.ModifiedDate DESC
) pm
LEFT JOIN oe.Users u ON u.UserId = pm.UserId
LEFT JOIN oe.Tenants t ON t.TenantId = d.TenantId
LEFT JOIN oe.Groups g ON g.GroupId = d.GroupId
ORDER BY t.Name, g.Name, ClientName;

IF (@ApplyChanges = 1)
BEGIN
    BEGIN TRAN;

    BEGIN TRY
        -- 1) Enrollments -> Members.AgentId
        UPDATE e
        SET e.AgentId = m.AgentId,
            e.ModifiedDate = GETUTCDATE()
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON m.MemberId = e.MemberId
        WHERE ISNULL(e.AgentId, @ZeroGuid) <> ISNULL(m.AgentId, @ZeroGuid);

        DECLARE @EnrollmentsUpdated INT = @@ROWCOUNT;

        -- 2) Payments linked to Enrollments -> Members.AgentId
        UPDATE p
        SET p.AgentId = m.AgentId,
            p.ModifiedDate = GETUTCDATE()
        FROM oe.Payments p
        INNER JOIN oe.Enrollments e ON e.EnrollmentId = p.EnrollmentId
        INNER JOIN oe.Members m ON m.MemberId = e.MemberId
        WHERE ISNULL(p.AgentId, @ZeroGuid) <> ISNULL(m.AgentId, @ZeroGuid);

        DECLARE @PaymentsByEnrollmentUpdated INT = @@ROWCOUNT;

        -- 3) Household-only Payments (no EnrollmentId) -> household primary/fallback member AgentId
        UPDATE p
        SET p.AgentId = hm.AgentId,
            p.ModifiedDate = GETUTCDATE()
        FROM oe.Payments p
        OUTER APPLY (
            SELECT TOP 1 m.AgentId
            FROM oe.Members m
            WHERE m.HouseholdId = p.HouseholdId
            ORDER BY CASE WHEN m.RelationshipType = 'P' THEN 0 ELSE 1 END, m.ModifiedDate DESC
        ) hm
        WHERE p.EnrollmentId IS NULL
          AND p.HouseholdId IS NOT NULL
          AND hm.AgentId IS NOT NULL
          AND ISNULL(p.AgentId, @ZeroGuid) <> ISNULL(hm.AgentId, @ZeroGuid);

        DECLARE @PaymentsByHouseholdUpdated INT = @@ROWCOUNT;

        COMMIT TRAN;

        SELECT
            EnrollmentsUpdated = @EnrollmentsUpdated,
            PaymentsByEnrollmentUpdated = @PaymentsByEnrollmentUpdated,
            PaymentsByHouseholdUpdated = @PaymentsByHouseholdUpdated,
            TotalUpdated = @EnrollmentsUpdated + @PaymentsByEnrollmentUpdated + @PaymentsByHouseholdUpdated;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRAN;
        THROW;
    END CATCH
END;
