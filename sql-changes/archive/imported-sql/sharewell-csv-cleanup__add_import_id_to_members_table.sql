-- Add import_id column to members table for AlignHealthProcessor
-- This script adds the import_id column and populates it for existing members

-- Step 1: Add import_id column if it doesn't exist
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('members') AND name = 'import_id')
BEGIN
    ALTER TABLE members ADD import_id NVARCHAR(255) NULL;
    PRINT 'Added import_id column to members table';
END
ELSE
BEGIN
    PRINT 'import_id column already exists in members table';
END

-- Step 2: Create index on import_id for performance
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE object_id = OBJECT_ID('members') AND name = 'IX_members_import_id')
BEGIN
    CREATE INDEX IX_members_import_id ON members(import_id);
    PRINT 'Created index on import_id column';
END
ELSE
BEGIN
    PRINT 'Index on import_id already exists';
END

-- Step 3: Populate import_id for existing Align Health members
-- This uses the same logic as the Python _generate_import_id method
UPDATE members 
SET import_id = (
    member_id + '_' + 
    LEFT(ISNULL(first_name, ''), 1) + 
    CASE 
        WHEN middle_name IS NULL OR middle_name = '' OR middle_name = 'None' OR middle_name = 'nan' 
        THEN '' 
        ELSE LEFT(middle_name, 1) 
    END + 
    '_' + 
    CASE 
        WHEN relationship = 'P' THEN 'P'
        WHEN relationship = 'S' THEN 'S'
        WHEN relationship = 'C' THEN 'C'
        ELSE ISNULL(relationship, '')
    END + 
    '_' + 
    FORMAT(dob, 'MMddyyyy')
)
WHERE account_id = '697E53F8-881D-4C06-A0CC-6731F3B536ED'  -- Align Health account
  AND import_id IS NULL
  AND member_id IS NOT NULL
  AND first_name IS NOT NULL
  AND last_name IS NOT NULL
  AND dob IS NOT NULL;

PRINT 'Populated import_id for existing Align Health members';

-- Step 4: Verify the update
SELECT COUNT(*) as total_members,
       COUNT(import_id) as members_with_import_id,
       COUNT(*) - COUNT(import_id) as members_without_import_id
FROM members 
WHERE account_id = '697E53F8-881D-4C06-A0CC-6731F3B536ED';

PRINT 'Import_id population complete for AlignHealthProcessor';
