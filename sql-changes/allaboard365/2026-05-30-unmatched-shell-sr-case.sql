/*
  2026-05-30  Unmatched public-form submissions -> flagged "shell" SR/Case
  ---------------------------------------------------------------------------
  An unmatched submission can now create a member-less ShareRequest/Case so it
  appears in the back-office dashboards, flagged NeedsMemberMatch. A staffer
  backfills the real member later (clearing the flag) — no duplicate.

  - Relax oe.ShareRequests.MemberId and oe.Cases.MemberId to NULL (metadata-only
    widening; FK to oe.Members is preserved and simply permits NULL).
  - Add NeedsMemberMatch BIT NOT NULL DEFAULT 0 to both tables.
  VendorId stays NOT NULL (no-default-vendor submissions stay submission-only).

  Idempotent. DRY-RUN by default — set @Apply = 1 to write.
  (Applied to allaboard-testing first; allaboard-prod at deploy time.)
*/

SET NOCOUNT ON;
DECLARE @Apply bit = 0;   -- <<< set to 1 to apply

-------------------------------------------------------------------------------
-- 1) Relax MemberId to NULL on ShareRequests
-------------------------------------------------------------------------------
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.ShareRequests') AND name = 'MemberId' AND is_nullable = 0
)
BEGIN
    IF @Apply = 1
    BEGIN
        ALTER TABLE oe.ShareRequests ALTER COLUMN MemberId UNIQUEIDENTIFIER NULL;
        PRINT 'ShareRequests.MemberId -> NULLable';
    END
    ELSE PRINT 'DRY-RUN: would relax ShareRequests.MemberId to NULL';
END
ELSE PRINT 'ShareRequests.MemberId already NULLable (skip)';

-------------------------------------------------------------------------------
-- 2) Relax MemberId to NULL on Cases
-------------------------------------------------------------------------------
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.Cases') AND name = 'MemberId' AND is_nullable = 0
)
BEGIN
    IF @Apply = 1
    BEGIN
        ALTER TABLE oe.Cases ALTER COLUMN MemberId UNIQUEIDENTIFIER NULL;
        PRINT 'Cases.MemberId -> NULLable';
    END
    ELSE PRINT 'DRY-RUN: would relax Cases.MemberId to NULL';
END
ELSE PRINT 'Cases.MemberId already NULLable (skip)';

-------------------------------------------------------------------------------
-- 3) Add NeedsMemberMatch flag to ShareRequests
-------------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.ShareRequests') AND name = 'NeedsMemberMatch'
)
BEGIN
    IF @Apply = 1
    BEGIN
        ALTER TABLE oe.ShareRequests
            ADD NeedsMemberMatch BIT NOT NULL
            CONSTRAINT DF_ShareRequests_NeedsMemberMatch DEFAULT 0;
        PRINT 'Added ShareRequests.NeedsMemberMatch';
    END
    ELSE PRINT 'DRY-RUN: would add ShareRequests.NeedsMemberMatch';
END
ELSE PRINT 'ShareRequests.NeedsMemberMatch already exists (skip)';

-------------------------------------------------------------------------------
-- 4) Add NeedsMemberMatch flag to Cases
-------------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.Cases') AND name = 'NeedsMemberMatch'
)
BEGIN
    IF @Apply = 1
    BEGIN
        ALTER TABLE oe.Cases
            ADD NeedsMemberMatch BIT NOT NULL
            CONSTRAINT DF_Cases_NeedsMemberMatch DEFAULT 0;
        PRINT 'Added Cases.NeedsMemberMatch';
    END
    ELSE PRINT 'DRY-RUN: would add Cases.NeedsMemberMatch';
END
ELSE PRINT 'Cases.NeedsMemberMatch already exists (skip)';
