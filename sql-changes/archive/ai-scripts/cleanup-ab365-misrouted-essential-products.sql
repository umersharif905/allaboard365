/*
  Cleanup script: AB365 misrouted Essential rows from a bad import window.

  Purpose
  - Identify (and optionally delete) member_products rows that were inserted
    for AB365 account during a specific UTC time window and mapped to Essential.

  Safety
  - DRY RUN by default (@ExecuteDelete = 0).
  - Delete runs inside an explicit transaction.
  - @CommitDelete controls COMMIT vs ROLLBACK.
  - Captures targeted row IDs in #target for exact, deterministic deletes.

  Usage
  1) Set @WindowStartUtc / @WindowEndUtc to your exact run.
  2) Run with @ExecuteDelete = 0 to preview count/details.
  3) Set @ExecuteDelete = 1 and @CommitDelete = 0 to test delete + rollback.
  4) Set @ExecuteDelete = 1 and @CommitDelete = 1 to commit.
*/

SET NOCOUNT ON;

DECLARE @AccountId UNIQUEIDENTIFIER = '7f37dae9-3db8-448e-9385-613269e6b8f9';
DECLARE @WrongProductId UNIQUEIDENTIFIER = '3BA721EA-5356-4480-B9D3-74E1D2F332E9'; -- Essential fallback product

-- IMPORTANT: set these to your exact bad run window (UTC).
DECLARE @WindowStartUtc DATETIME2(3) = '2026-03-06T20:35:40.000';
DECLARE @WindowEndUtc   DATETIME2(3) = '2026-03-06T20:36:10.000';

-- Controls
DECLARE @ExecuteDelete BIT = 0; -- 0 = preview only, 1 = run delete block
DECLARE @CommitDelete  BIT = 0; -- 0 = rollback, 1 = commit (only used when @ExecuteDelete=1)

IF OBJECT_ID('tempdb..#target') IS NOT NULL DROP TABLE #target;

SELECT
    mp.id,
    mp.member_id,
    m.member_id AS member_code,
    mp.product_id,
    p.product_name,
    mp.benefit_id,
    mp.effective_date,
    mp.termination_date,
    mp.created_dt
INTO #target
FROM member_products mp
INNER JOIN members m ON m.id = mp.member_id
LEFT JOIN products p ON p.id = mp.product_id
WHERE m.account_id = @AccountId
  AND mp.product_id = @WrongProductId
  AND mp.created_dt >= @WindowStartUtc
  AND mp.created_dt <= @WindowEndUtc;

PRINT '=== PREVIEW ===';
SELECT COUNT(*) AS target_rows FROM #target;

SELECT TOP 100
    id,
    member_id,
    member_code,
    product_id,
    product_name,
    benefit_id,
    effective_date,
    termination_date,
    created_dt
FROM #target
ORDER BY created_dt DESC, member_code;

-- Optional validation: ensure no duplicate ids in target set
SELECT
    COUNT(*) AS total_rows,
    COUNT(DISTINCT id) AS distinct_ids
FROM #target;

IF @ExecuteDelete = 1
BEGIN
    PRINT '=== DELETE MODE ===';
    BEGIN TRANSACTION;

    DELETE mp
    FROM member_products mp
    INNER JOIN #target t ON t.id = mp.id;

    PRINT CONCAT('Deleted rows: ', @@ROWCOUNT);

    -- Post-delete verification inside transaction
    SELECT COUNT(*) AS still_present_after_delete
    FROM member_products mp
    INNER JOIN #target t ON t.id = mp.id;

    IF @CommitDelete = 1
    BEGIN
        COMMIT TRANSACTION;
        PRINT 'Delete COMMITTED.';
    END
    ELSE
    BEGIN
        ROLLBACK TRANSACTION;
        PRINT 'Delete ROLLED BACK (test mode).';
    END
END
ELSE
BEGIN
    PRINT 'Preview only. No delete executed.';
END

