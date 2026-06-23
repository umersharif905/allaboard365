-- ShareWELL DB: Verify Rebecca Lewis email update.
-- Run against ShareWELLPartners on swp-sql-srvr.database.windows.net
-- After running sharewell-rebecca-lewis-inactive-email.sql you should see:
--   SW2280143 (active)  -> RJBLEWIS1965@GMAIL.COM
--   SW8354986 (inactive)-> INACTIVE-RJBLEWIS1965@GMAIL.COM

SET NOCOUNT ON;

-- 1) dbo.members: who has which email
SELECT 'dbo.members' AS [table], member_id, email
FROM dbo.members
WHERE member_id IN ('SW2280143', 'SW8354986')
ORDER BY member_id;

-- 2) dbo.users: who has which email (this is what login uses)
SELECT 'dbo.users' AS [table], member_id, email
FROM dbo.users
WHERE member_id IN ('SW2280143', 'SW8354986')
ORDER BY member_id;

-- 3) Login check: only one user should have the real email (active)
DECLARE @LoginEmail NVARCHAR(256) = 'rjblewis1965@gmail.com';
SELECT member_id, email
FROM dbo.users
WHERE LTRIM(RTRIM(LOWER(email))) = @LoginEmail;
-- Expected: exactly 1 row, member_id = SW2280143

GO
