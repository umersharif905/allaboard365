-- ShareWELL DB: Update inactive duplicate (SW8354986) email to INACTIVE-<original>
-- So login with RJBLEWIS1965@GMAIL.COM only resolves to active member SW2280143.
-- Run against ShareWELLPartners on swp-sql-srvr.database.windows.net

SET NOCOUNT ON;

DECLARE @InactiveMemberId NVARCHAR(50) = 'SW8354986';
DECLARE @OriginalEmail NVARCHAR(256) = 'RJBLEWIS1965@GMAIL.COM';
DECLARE @NewEmail NVARCHAR(256) = 'INACTIVE-' + @OriginalEmail;

-- Update dbo.members (inactive row only)
UPDATE dbo.members
SET email = @NewEmail
WHERE member_id = @InactiveMemberId
  AND LTRIM(RTRIM(email)) = @OriginalEmail;

PRINT 'members updated: ' + CAST(@@ROWCOUNT AS NVARCHAR(10));

-- Update dbo.users (user row linked to inactive member)
UPDATE dbo.users
SET email = @NewEmail
WHERE member_id = @InactiveMemberId
  AND LTRIM(RTRIM(email)) = @OriginalEmail;

PRINT 'users updated: ' + CAST(@@ROWCOUNT AS NVARCHAR(10));

PRINT 'Done. Inactive email is now: ' + @NewEmail;
GO
