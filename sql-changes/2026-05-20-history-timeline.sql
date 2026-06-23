-- ============================================================================
-- 2026-05-20-history-timeline.sql
-- Schema for the Case & Share Request history timeline feature (Phases 2 & 3).
-- See docs/backoffice/case-history-implementation.md
--
-- Idempotent — guarded with COL_LENGTH / sys.indexes, safe to re-run.
-- Run order: column adds first, GO, then indexes (so the new columns are
-- visible to the index batch).
--
-- Phase 1 / 1.5 needed no schema. Everything here supports:
--   Phase 2  — creation source       (Cases.CreatedVia, ShareRequests.CreatedVia)
--   Phase 3A — plan changes          (MemberEventLog.EventDetails)
--   Phase 3B — outreach linkage      (MessageHistory.CaseId / ShareRequestId)
--
-- All backend code tolerates these columns being absent (defensive queries),
-- so the app keeps working whether or not this has run — but the timeline
-- only shows creation source / plan detail / outreach once it has.
-- ============================================================================

-- Phase 2: creation source ----------------------------------------------------
IF COL_LENGTH('oe.Cases', 'CreatedVia') IS NULL
BEGIN
    ALTER TABLE oe.Cases ADD CreatedVia NVARCHAR(20) NULL;  -- 'form' | 'vendor' | 'encounter'
    PRINT 'Added oe.Cases.CreatedVia';
END

IF COL_LENGTH('oe.ShareRequests', 'CreatedVia') IS NULL
BEGIN
    ALTER TABLE oe.ShareRequests ADD CreatedVia NVARCHAR(20) NULL;  -- 'form' | 'vendor'
    PRINT 'Added oe.ShareRequests.CreatedVia';
END

-- Phase 3A: free-form detail for member events --------------------------------
IF COL_LENGTH('oe.MemberEventLog', 'EventDetails') IS NULL
BEGIN
    ALTER TABLE oe.MemberEventLog ADD EventDetails NVARCHAR(MAX) NULL;
    PRINT 'Added oe.MemberEventLog.EventDetails';
END

-- Phase 3B: outreach linkage --------------------------------------------------
IF COL_LENGTH('oe.MessageHistory', 'CaseId') IS NULL
BEGIN
    ALTER TABLE oe.MessageHistory ADD CaseId UNIQUEIDENTIFIER NULL;
    PRINT 'Added oe.MessageHistory.CaseId';
END

IF COL_LENGTH('oe.MessageHistory', 'ShareRequestId') IS NULL
BEGIN
    ALTER TABLE oe.MessageHistory ADD ShareRequestId UNIQUEIDENTIFIER NULL;
    PRINT 'Added oe.MessageHistory.ShareRequestId';
END
GO

-- Indexes (separate batch — the columns above must be visible) ---------------
-- Filtered: the new columns are NULL for the vast majority of MessageHistory
-- rows, so the indexes stay tiny and only cover case/SR-linked messages.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_MessageHistory_CaseId'
                 AND object_id = OBJECT_ID('oe.MessageHistory'))
BEGIN
    CREATE INDEX IX_MessageHistory_CaseId ON oe.MessageHistory(CaseId)
        WHERE CaseId IS NOT NULL;
    PRINT 'Created IX_MessageHistory_CaseId';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_MessageHistory_ShareRequestId'
                 AND object_id = OBJECT_ID('oe.MessageHistory'))
BEGIN
    CREATE INDEX IX_MessageHistory_ShareRequestId ON oe.MessageHistory(ShareRequestId)
        WHERE ShareRequestId IS NOT NULL;
    PRINT 'Created IX_MessageHistory_ShareRequestId';
END
GO

PRINT 'history-timeline migration complete.';
