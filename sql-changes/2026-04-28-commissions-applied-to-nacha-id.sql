-- Phase 2 — oe.Commissions.AppliedToNACHAId
--
-- Adds a UNIQUEIDENTIFIER column on oe.Commissions used by the NACHA cycle to
-- mark which clawback rows were settled in which NACHA file. This mirrors the
-- pattern used in oe.PayoutClawbacks (Phase 3) so the same `markNACHAasSent` /
-- `markNACHAasNotSent` flow can flip both tables in a single transaction.
--
-- The column is nullable for forward-compat: existing positive Commission rows
-- and historical Cancelled rows leave it NULL. Only rows whose NACHA cycle has
-- been finalized will have AppliedToNACHAId populated.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE Name = N'AppliedToNACHAId'
      AND Object_ID = OBJECT_ID(N'oe.Commissions')
)
BEGIN
    ALTER TABLE oe.Commissions
        ADD AppliedToNACHAId UNIQUEIDENTIFIER NULL;

    PRINT 'Added oe.Commissions.AppliedToNACHAId';
END
ELSE
BEGIN
    PRINT 'oe.Commissions.AppliedToNACHAId already exists - skipping';
END
GO

-- Filtered index keeps mark-as-sent / mark-as-not-sent O(log n) without
-- bloating storage for historical rows that never participated in NACHA.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = N'IX_Commissions_AppliedToNACHAId'
      AND object_id = OBJECT_ID(N'oe.Commissions')
)
BEGIN
    CREATE INDEX IX_Commissions_AppliedToNACHAId
        ON oe.Commissions(AppliedToNACHAId)
        WHERE AppliedToNACHAId IS NOT NULL;

    PRINT 'Created IX_Commissions_AppliedToNACHAId';
END
ELSE
BEGIN
    PRINT 'IX_Commissions_AppliedToNACHAId already exists - skipping';
END
GO
