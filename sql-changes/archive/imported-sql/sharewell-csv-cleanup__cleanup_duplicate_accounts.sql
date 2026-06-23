-- =================================================================================
-- CLEANUP DUPLICATE SB ACCOUNTS
-- =================================================================================
-- Strategy:
-- 1. Keep the account with members (if exists) or oldest account
-- 2. Delete the empty duplicate accounts
-- 3. Move any orphaned members to the kept account
-- =================================================================================

BEGIN TRANSACTION;

PRINT 'Starting duplicate SB account cleanup...';

-- Create temp table to track accounts to delete
CREATE TABLE #AccountsToDelete (
    account_id UNIQUEIDENTIFIER,
    primary_member_id NVARCHAR(100),
    account_name NVARCHAR(255),
    member_count INT,
    has_members BIT,
    created_dt DATETIME
);

PRINT 'Identifying duplicate accounts...';

-- Find all accounts that should be deleted (duplicates)
INSERT INTO #AccountsToDelete (account_id, primary_member_id, account_name, member_count, has_members, created_dt)
SELECT 
    a.id,
    a.primary_member_id,
    a.account_name,
    (SELECT COUNT(*) FROM members WHERE account_id = a.id) as member_count,
    CASE WHEN (SELECT COUNT(*) FROM members WHERE account_id = a.id) > 0 THEN 1 ELSE 0 END as has_members,
    a.created_dt
FROM accounts a
WHERE a.bill_type = 'SB' 
    AND a.primary_member_id IS NOT NULL
    AND EXISTS (
        -- This account is a duplicate
        SELECT 1 
        FROM accounts a2 
        WHERE a2.primary_member_id = a.primary_member_id 
            AND a2.bill_type = 'SB'
            AND a2.primary_member_id IS NOT NULL
        GROUP BY a2.primary_member_id
        HAVING COUNT(*) > 1
    )
    -- This is NOT the one to keep (the one with most members or oldest)
    AND a.id NOT IN (
        SELECT TOP 1 WITH TIES a3.id
        FROM accounts a3
        WHERE a3.bill_type = 'SB' 
            AND a3.primary_member_id = a.primary_member_id
            AND a3.primary_member_id IS NOT NULL
        ORDER BY 
            (SELECT COUNT(*) FROM members WHERE account_id = a3.id) DESC,  -- Most members first
            COALESCE(a3.created_dt, '1970-01-01') ASC  -- Then oldest
    );

DECLARE @DeleteCount INT = (SELECT COUNT(*) FROM #AccountsToDelete);
PRINT 'Found ' + CAST(@DeleteCount AS NVARCHAR(10)) + ' duplicate accounts to delete';

-- Show some examples
PRINT '';
PRINT 'Sample accounts to be deleted:';
SELECT TOP 10 
    primary_member_id,
    account_name,
    member_count,
    created_dt
FROM #AccountsToDelete
ORDER BY member_count DESC, created_dt DESC;

-- Check for orphaned members (members in accounts we're deleting)
PRINT '';
PRINT 'Checking for orphaned members...';

CREATE TABLE #OrphanedMembers (
    member_id UNIQUEIDENTIFIER,
    account_id UNIQUEIDENTIFIER,
    member_name NVARCHAR(255),
    kept_account_id UNIQUEIDENTIFIER
);

INSERT INTO #OrphanedMembers (member_id, account_id, member_name, kept_account_id)
SELECT 
    m.id,
    m.account_id,
    m.first_name + ' ' + m.last_name,
    -- Find the kept account for this primary_member_id
    (SELECT TOP 1 a4.id
     FROM accounts a4
     WHERE a4.bill_type = 'SB'
         AND a4.primary_member_id = a.primary_member_id
         AND a4.primary_member_id IS NOT NULL
     ORDER BY 
         (SELECT COUNT(*) FROM members WHERE account_id = a4.id) DESC,
         COALESCE(a4.created_dt, '1970-01-01') ASC
    ) as kept_account_id
FROM members m
INNER JOIN accounts a ON m.account_id = a.id
WHERE a.id IN (SELECT account_id FROM #AccountsToDelete)
    AND m.account_id IN (SELECT account_id FROM #AccountsToDelete);

DECLARE @OrphanCount INT = (SELECT COUNT(*) FROM #OrphanedMembers);
PRINT 'Found ' + CAST(@OrphanCount AS NVARCHAR(10)) + ' orphaned members';

-- Move orphaned members to kept accounts
IF @OrphanCount > 0
BEGIN
    PRINT 'Moving orphaned members to kept accounts...';
    
    UPDATE m
    SET m.account_id = om.kept_account_id
    FROM members m
    INNER JOIN #OrphanedMembers om ON m.id = om.member_id;
    
    PRINT 'Moved ' + CAST(@@ROWCOUNT AS NVARCHAR(10)) + ' members';
END

-- Delete the duplicate accounts
PRINT '';
PRINT 'Deleting duplicate accounts...';

DELETE FROM accounts
WHERE id IN (SELECT account_id FROM #AccountsToDelete);

DECLARE @DeletedCount INT = @@ROWCOUNT;
PRINT 'Deleted ' + CAST(@DeletedCount AS NVARCHAR(10)) + ' duplicate accounts';

-- Cleanup temp tables
DROP TABLE #AccountsToDelete;
DROP TABLE #OrphanedMembers;

PRINT '';
PRINT 'Cleanup complete!';
PRINT 'Summary:';
PRINT '  - Duplicate accounts identified: ' + CAST(@DeleteCount AS NVARCHAR(10));
PRINT '  - Orphaned members moved: ' + CAST(@OrphanCount AS NVARCHAR(10));
PRINT '  - Accounts deleted: ' + CAST(@DeletedCount AS NVARCHAR(10));

-- Verify no more duplicates
PRINT '';
PRINT 'Verifying no more duplicates...';
SELECT 
    primary_member_id,
    COUNT(*) as account_count
FROM accounts
WHERE bill_type = 'SB' AND primary_member_id IS NOT NULL
GROUP BY primary_member_id
HAVING COUNT(*) > 1;

IF @@ROWCOUNT = 0
BEGIN
    PRINT '✓ No more duplicate SB accounts!';
END
ELSE
BEGIN
    PRINT '⚠ WARNING: Duplicates still exist!';
END

-- ROLLBACK TRANSACTION;  -- Uncomment to test without committing
COMMIT TRANSACTION;

PRINT 'Transaction committed.';

