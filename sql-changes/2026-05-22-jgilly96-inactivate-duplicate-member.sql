-- Fallback when hard DELETE on oe.Members times out (prod lock contention).
-- Soft-removes the duplicate individual row — same pattern as in-app household remove.
-- User + group member row (9561A75B…) are untouched.
--
-- MemberId to inactivate: 3A293C44-A4AF-4047-B358-D891535CB31F
-- Run ONE statement at a time. Cancel any other hung DELETE sessions first.

SET LOCK_TIMEOUT 30000; -- 30s; fail fast instead of hanging 2 min

-- Preview
SELECT MemberId, UserId, GroupId, Status, RelationshipType, CreatedDate
FROM oe.Members
WHERE MemberId = '3A293C44-A4AF-4047-B358-D891535CB31F';

-- Apply (uncomment to run):
/*
UPDATE oe.Members
SET Status = 'Inactive',
    ModifiedDate = GETUTCDATE(),
    ModifiedBy = '00000000-0000-0000-0000-000000000000' -- replace with your UserId if desired
WHERE MemberId = '3A293C44-A4AF-4047-B358-D891535CB31F'
  AND Status <> 'Inactive';
*/

-- Verify (should show Active group row + Inactive duplicate, or only Active if list filters inactive)
SELECT m.MemberId, m.GroupId, g.Name AS GroupName, m.Status, u.Email
FROM oe.Members m
JOIN oe.Users u ON u.UserId = m.UserId
LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
WHERE u.Email = 'jgilly96@yahoo.com';
