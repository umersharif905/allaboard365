-- =============================================================================
-- Backfill oe.Payments.AgentId for rows that should have an agent but don't.
-- =============================================================================
-- Problem:
--   Paid invoices with no enrollment agent show in TenantAccounting → Generate
--   commissions preview → "Skipped invoices" (GET /api/commissions/skipped-invoices).
--   Legacy payment AgentId backfill below still helps generate-missing for
--   payment-anchored rows; invoice path uses enrollment agent via createCommissionsForInvoice.
--
-- Resolution strategy (per payment):
--   1. Individual payment (HouseholdId IS NOT NULL, GroupId IS NULL):
--      Use the AgentId from the primary member's (RelationshipType = 'P')
--      non-fee enrollment (ProductId <> '00000000-...' and Commission IS NOT NULL).
--      Fall back to any enrollment in the household with an AgentId.
--   2. Group payment (GroupId IS NOT NULL):
--      Use the most recently created enrollment in that group that has an
--      AgentId on a real product (non-'All Products' fee row).
--
-- Safety:
--   • Only touches payments that currently have AgentId = NULL.
--   • Only touches payments with no existing commissions (Status != 'Deleted').
--   • Only touches payments whose Status is one of the "eligible-for-generate"
--     statuses (same list as legacy skipped-payments endpoint).
--   • Excludes the $3.50 Advanced Cabling Solutions payment
--     80970727-0B7C-473D-A051-0303ABCF506C by explicit guard (per request —
--     that group has only inactive/terminated enrollments so commission would
--     still be $0 even after AgentId is set).
--   • Wraps in a transaction with a preview SELECT so you can eyeball matches
--     before committing. Change ROLLBACK to COMMIT to apply.
--
-- Follow-up:
--   After this runs, use TenantBilling → Transactions → payment audit →
--   "Correct values" on each affected row (or curl the endpoint in a loop)
--   to recompute NetRate/OverrideRate/Commission/ProductCommissions from
--   enrollments. Then "Generate missing commissions" will pick them up.
-- =============================================================================

SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRANSACTION;

-- -----------------------------------------------------------------------------
-- Build the candidate set + the AgentId we'd assign to each.
-- -----------------------------------------------------------------------------
DECLARE @ExcludePaymentIds TABLE (PaymentId UNIQUEIDENTIFIER PRIMARY KEY);
INSERT INTO @ExcludePaymentIds (PaymentId) VALUES
    ('80970727-0B7C-473D-A051-0303ABCF506C'); -- ACS $3.50, ignore per request

IF OBJECT_ID('tempdb..#PaymentAgentBackfill') IS NOT NULL
    DROP TABLE #PaymentAgentBackfill;

CREATE TABLE #PaymentAgentBackfill (
    PaymentId       UNIQUEIDENTIFIER PRIMARY KEY,
    TenantId        UNIQUEIDENTIFIER NOT NULL,
    PaymentDate     DATETIME NULL,
    Amount          DECIMAL(18, 2) NULL,
    HouseholdId     UNIQUEIDENTIFIER NULL,
    GroupId         UNIQUEIDENTIFIER NULL,
    ResolvedAgentId UNIQUEIDENTIFIER NULL,
    ResolutionPath  NVARCHAR(100) NULL
);

-- Individual household payments: prefer primary member's real-product enrollment.
INSERT INTO #PaymentAgentBackfill (
    PaymentId, TenantId, PaymentDate, Amount, HouseholdId, GroupId,
    ResolvedAgentId, ResolutionPath
)
SELECT
    p.PaymentId,
    p.TenantId,
    p.PaymentDate,
    p.Amount,
    p.HouseholdId,
    p.GroupId,
    COALESCE(primary_real.AgentId, primary_any.AgentId, household_any.AgentId) AS ResolvedAgentId,
    CASE
        WHEN primary_real.AgentId IS NOT NULL THEN 'household.primary.realProduct'
        WHEN primary_any.AgentId  IS NOT NULL THEN 'household.primary.anyEnrollment'
        WHEN household_any.AgentId IS NOT NULL THEN 'household.anyEnrollment'
        ELSE NULL
    END AS ResolutionPath
FROM oe.Payments p
OUTER APPLY (
    SELECT TOP 1 e.AgentId
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    WHERE e.HouseholdId = p.HouseholdId
      AND m.RelationshipType = 'P'
      AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
      AND e.Commission IS NOT NULL
      AND e.AgentId IS NOT NULL
    ORDER BY e.CreatedDate DESC
) primary_real
OUTER APPLY (
    SELECT TOP 1 e.AgentId
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    WHERE e.HouseholdId = p.HouseholdId
      AND m.RelationshipType = 'P'
      AND e.AgentId IS NOT NULL
    ORDER BY e.CreatedDate DESC
) primary_any
OUTER APPLY (
    SELECT TOP 1 e.AgentId
    FROM oe.Enrollments e
    WHERE e.HouseholdId = p.HouseholdId
      AND e.AgentId IS NOT NULL
    ORDER BY e.CreatedDate DESC
) household_any
WHERE p.AgentId IS NULL
  AND p.HouseholdId IS NOT NULL
  AND p.GroupId IS NULL
  AND p.Status IN ('Completed', 'Draft', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded')
  AND p.PaymentId NOT IN (SELECT PaymentId FROM @ExcludePaymentIds)
  AND NOT EXISTS (
      SELECT 1 FROM oe.Commissions c
      WHERE c.PaymentId = p.PaymentId AND c.Status <> 'Deleted'
  );

-- Group payments: most recent real-product enrollment in the group with an AgentId.
INSERT INTO #PaymentAgentBackfill (
    PaymentId, TenantId, PaymentDate, Amount, HouseholdId, GroupId,
    ResolvedAgentId, ResolutionPath
)
SELECT
    p.PaymentId,
    p.TenantId,
    p.PaymentDate,
    p.Amount,
    p.HouseholdId,
    p.GroupId,
    COALESCE(group_real.AgentId, group_any.AgentId) AS ResolvedAgentId,
    CASE
        WHEN group_real.AgentId IS NOT NULL THEN 'group.realProduct'
        WHEN group_any.AgentId  IS NOT NULL THEN 'group.anyEnrollment'
        ELSE NULL
    END AS ResolutionPath
FROM oe.Payments p
OUTER APPLY (
    SELECT TOP 1 e.AgentId
    FROM oe.Enrollments e
    WHERE e.GroupID = p.GroupId
      AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
      AND e.Commission IS NOT NULL
      AND e.AgentId IS NOT NULL
    ORDER BY e.CreatedDate DESC
) group_real
OUTER APPLY (
    SELECT TOP 1 e.AgentId
    FROM oe.Enrollments e
    WHERE e.GroupID = p.GroupId
      AND e.AgentId IS NOT NULL
    ORDER BY e.CreatedDate DESC
) group_any
WHERE p.AgentId IS NULL
  AND p.GroupId IS NOT NULL
  AND p.Status IN ('Completed', 'Draft', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded')
  AND p.PaymentId NOT IN (SELECT PaymentId FROM @ExcludePaymentIds)
  AND NOT EXISTS (
      SELECT 1 FROM oe.Commissions c
      WHERE c.PaymentId = p.PaymentId AND c.Status <> 'Deleted'
  );

-- -----------------------------------------------------------------------------
-- Preview: rows we are about to fix, and rows we can't resolve yet.
-- Inspect these BEFORE flipping ROLLBACK -> COMMIT at the bottom.
-- -----------------------------------------------------------------------------
PRINT '--- Resolvable payments (will be updated) ---';
SELECT
    b.PaymentId,
    b.TenantId,
    b.PaymentDate,
    b.Amount,
    b.HouseholdId,
    b.GroupId,
    b.ResolvedAgentId,
    b.ResolutionPath,
    u.FirstName + ' ' + u.LastName AS ResolvedAgentName
FROM #PaymentAgentBackfill b
LEFT JOIN oe.Agents a ON b.ResolvedAgentId = a.AgentId
LEFT JOIN oe.Users u  ON a.UserId = u.UserId
WHERE b.ResolvedAgentId IS NOT NULL
ORDER BY b.PaymentDate DESC;

PRINT '--- Unresolvable payments (no enrollment with an AgentId found) ---';
SELECT
    b.PaymentId,
    b.TenantId,
    b.PaymentDate,
    b.Amount,
    b.HouseholdId,
    b.GroupId
FROM #PaymentAgentBackfill b
WHERE b.ResolvedAgentId IS NULL
ORDER BY b.PaymentDate DESC;

-- -----------------------------------------------------------------------------
-- Apply the update.
-- -----------------------------------------------------------------------------
UPDATE p
SET
    p.AgentId      = b.ResolvedAgentId,
    p.ModifiedDate = GETUTCDATE()
FROM oe.Payments p
INNER JOIN #PaymentAgentBackfill b ON b.PaymentId = p.PaymentId
WHERE p.AgentId IS NULL
  AND b.ResolvedAgentId IS NOT NULL;

PRINT '--- Rows updated ---';
SELECT @@ROWCOUNT AS RowsUpdated;

-- -----------------------------------------------------------------------------
-- Post-update verification: these should all come back with AgentId set.
-- -----------------------------------------------------------------------------
PRINT '--- Verification: post-update state of affected payments ---';
SELECT
    p.PaymentId,
    p.AgentId,
    p.TenantId,
    p.PaymentDate,
    p.Amount,
    p.Commission,
    p.HouseholdId,
    p.GroupId,
    u.FirstName + ' ' + u.LastName AS AgentName
FROM oe.Payments p
INNER JOIN #PaymentAgentBackfill b ON b.PaymentId = p.PaymentId
LEFT JOIN oe.Agents a ON p.AgentId = a.AgentId
LEFT JOIN oe.Users u  ON a.UserId = u.UserId
ORDER BY p.PaymentDate DESC;

DROP TABLE #PaymentAgentBackfill;

-- SAFETY: starts as ROLLBACK so running the script is a dry-run.
-- Flip to COMMIT once the preview above looks correct.
ROLLBACK TRANSACTION;
-- COMMIT TRANSACTION;
