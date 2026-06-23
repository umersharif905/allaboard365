-- =================================================================================
-- SAFE CLEANUP OF DUPLICATE -SB ACCOUNTS
-- =================================================================================
-- This script will:
-- 1. PROTECT all accounts that have members with share_requests
-- 2. Move other members from duplicate -SB accounts to the correct account
-- 3. Delete ONLY empty duplicate -SB accounts (created today, with "- SB" suffix)
-- =================================================================================

BEGIN TRANSACTION;

PRINT '================================================================================';
PRINT 'SAFE CLEANUP OF DUPLICATE -SB ACCOUNTS';
PRINT '================================================================================';
PRINT '';

-- Step 1: Identify PROTECTED accounts (those with members that have share_requests)
PRINT 'Step 1: Identifying PROTECTED accounts (with share_requests members)...';
PRINT '';

CREATE TABLE #ProtectedAccounts (
    account_id UNIQUEIDENTIFIER
);

INSERT INTO #ProtectedAccounts
SELECT DISTINCT a.id
FROM accounts a
INNER JOIN members m ON a.id = m.account_id
WHERE EXISTS (
    SELECT 1 
    FROM share_requests sr 
    WHERE sr.member_id = m.id
);

DECLARE @ProtectedAccountCount INT = (SELECT COUNT(*) FROM #ProtectedAccounts);
PRINT 'Found ' + CAST(@ProtectedAccountCount AS NVARCHAR(10)) + ' PROTECTED accounts';
PRINT '(These will NOT be touched)';
PRINT '';

-- Step 2: Identify duplicate -SB accounts created today
PRINT 'Step 2: Identifying duplicate -SB accounts (created today)...';
PRINT '';

CREATE TABLE #DuplicateSBAccounts (
    account_id UNIQUEIDENTIFIER,
    primary_member_id NVARCHAR(100),
    account_name NVARCHAR(255),
    created_dt DATETIME,
    member_count INT,
    is_protected BIT
);

INSERT INTO #DuplicateSBAccounts
SELECT 
    a.id,
    a.primary_member_id,
    a.account_name,
    a.created_dt,
    (SELECT COUNT(*) FROM members WHERE account_id = a.id) as member_count,
    CASE WHEN EXISTS (SELECT 1 FROM #ProtectedAccounts pa WHERE pa.account_id = a.id) THEN 1 ELSE 0 END
FROM accounts a
WHERE a.bill_type = 'SB'
    AND a.account_name LIKE '%- SB'  -- Has "- SB" suffix
    AND a.created_dt = '2025-10-27'  -- Created today
    AND EXISTS (
        -- This member has MULTIPLE SB accounts
        SELECT 1 
        FROM accounts a2 
        WHERE a2.primary_member_id = a.primary_member_id
            AND a2.bill_type = 'SB'
        GROUP BY a2.primary_member_id
        HAVING COUNT(*) > 1
    );

DECLARE @DuplicateCount INT = (SELECT COUNT(*) FROM #DuplicateSBAccounts);
PRINT 'Found ' + CAST(@DuplicateCount AS NVARCHAR(10)) + ' duplicate -SB accounts';
PRINT '';

-- Show breakdown
SELECT 
    member_count,
    COUNT(*) as account_count
FROM #DuplicateSBAccounts
GROUP BY member_count
ORDER BY member_count;

PRINT '';

-- Check protected accounts in duplicates
DECLARE @ProtectedInDuplicates INT = (SELECT COUNT(*) FROM #DuplicateSBAccounts WHERE is_protected = 1);
IF @ProtectedInDuplicates > 0
BEGIN
    PRINT 'WARNING: ' + CAST(@ProtectedInDuplicates AS NVARCHAR(10)) + ' duplicate accounts are PROTECTED (have share_requests members)';
    PRINT 'These will NOT be deleted or modified.';
    PRINT '';
END

-- Step 3: For accounts with members, find the target account to move them to
PRINT 'Step 3: Preparing member moves (for non-protected accounts)...';
PRINT '';

CREATE TABLE #MembersToMove (
    member_id UNIQUEIDENTIFIER,
    current_account_id UNIQUEIDENTIFIER,
    target_account_id UNIQUEIDENTIFIER,
    member_name NVARCHAR(255),
    is_protected BIT
);

-- Get members from duplicate -SB accounts that need to be moved
INSERT INTO #MembersToMove (member_id, current_account_id, member_name, is_protected)
SELECT 
    m.id,
    m.account_id,
    m.first_name + ' ' + m.last_name,
    CASE WHEN EXISTS (SELECT 1 FROM #ProtectedAccounts pa WHERE pa.account_id = m.account_id) THEN 1 ELSE 0 END
FROM members m
INNER JOIN accounts a ON m.account_id = a.id
WHERE a.id IN (SELECT account_id FROM #DuplicateSBAccounts)
    AND a.is_protected = 0;  -- Only from non-protected accounts

-- Find target account (the OLD account or non -SB account for this primary_member_id)
UPDATE mtm
SET target_account_id = (
    SELECT TOP 1 a.id
    FROM accounts a
    WHERE a.bill_type = 'SB'
        AND a.primary_member_id = (
            SELECT primary_member_id 
            FROM accounts 
            WHERE id = mtm.current_account_id
        )
        AND a.account_name NOT LIKE '%- SB'  -- The correct account (without - SB suffix)
    ORDER BY COALESCE(a.created_dt, '1970-01-01') ASC  -- Oldest first
)
FROM #MembersToMove mtm;

DECLARE @MembersToMoveCount INT = (SELECT COUNT(*) FROM #MembersToMove WHERE target_account_id IS NOT NULL);
PRINT 'Found ' + CAST(@MembersToMoveCount AS NVARCHAR(10)) + ' members to move to correct accounts';
PRINT '';

-- Step 4: EXECUTE - Move members to correct accounts
PRINT 'Step 4: Moving members...';
PRINT '';

DECLARE @MovedCount INT = 0;

IF @MembersToMoveCount > 0
BEGIN
    UPDATE m
    SET m.account_id = mtm.target_account_id
    FROM members m
    INNER JOIN #MembersToMove mtm ON m.id = mtm.member_id
    WHERE mtm.target_account_id IS NOT NULL
        AND mtm.is_protected = 0;
    
    SET @MovedCount = @@ROWCOUNT;
    PRINT 'Moved ' + CAST(@MovedCount AS NVARCHAR(10)) + ' members to correct accounts';
    PRINT '';
END
ELSE
BEGIN
    PRINT 'No members to move (all are protected or already in correct accounts)';
    PRINT '';
END

-- Step 5: DELETE empty duplicate -SB accounts (but NOT protected ones)
PRINT 'Step 5: Deleting empty duplicate -SB accounts...';
PRINT '';

DECLARE @DeletedCount INT = 0;

DELETE FROM accounts
WHERE id IN (
    SELECT account_id 
    FROM #DuplicateSBAccounts
    WHERE member_count = 0  -- Empty accounts
        AND is_protected = 0  -- Not protected
);

SET @DeletedCount = @@ROWCOUNT;
PRINT 'Deleted ' + CAST(@DeletedCount AS NVARCHAR(10)) + ' empty duplicate -SB accounts';
PRINT '';

-- Step 6: For protected accounts with members, report but DO NOT DELETE
DECLARE @ProtectedRemaining INT = (
    SELECT COUNT(*) 
    FROM #DuplicateSBAccounts 
    WHERE is_protected = 1 AND member_count > 0
);

IF @ProtectedRemaining > 0
BEGIN
    PRINT 'Note: ' + CAST(@ProtectedRemaining AS NVARCHAR(10)) + ' duplicate -SB accounts were KEPT because they contain protected members';
    PRINT 'These accounts will remain untouched.';
    PRINT '';
END

-- Cleanup temp tables
DROP TABLE #ProtectedAccounts;
DROP TABLE #DuplicateSBAccounts;
DROP TABLE #MembersToMove;

-- Final summary
PRINT '================================================================================';
PRINT 'CLEANUP COMPLETE';
PRINT '================================================================================';
PRINT 'Members moved:           ' + CAST(@MovedCount AS NVARCHAR(10));
PRINT 'Accounts deleted:        ' + CAST(@DeletedCount AS NVARCHAR(10));
PRINT 'Protected accounts kept: ' + CAST(@ProtectedRemaining AS NVARCHAR(10));
PRINT 'Share requests members:  PROTECTED (all safe)';
PRINT '================================================================================';
PRINT '';

-- Verify no members were orphaned
DECLARE @OrphanedMembers INT = (
    SELECT COUNT(*) 
    FROM members m
    WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = m.account_id)
);

IF @OrphanedMembers > 0
BEGIN
    PRINT 'ERROR: ' + CAST(@OrphanedMembers AS NVARCHAR(10)) + ' members are orphaned!';
    ROLLBACK TRANSACTION;
    PRINT 'Transaction rolled back due to orphaned members.';
END
ELSE
BEGIN
    PRINT 'Verification passed: No orphaned members.';
    
    -- ROLLBACK TRANSACTION;  -- Uncomment to test without committing
    COMMIT TRANSACTION;
    PRINT 'Transaction committed successfully.';
END
