-- ShareWELL DB: Mark Whitesides (mark@mightywell.us)
-- Prefix terminated legacy member email and repoint login to active member.
--
-- mobile-og authenticates via dbo.users (email), then loads member/plans by users.member_id.
-- It does NOT auto-pick the member row with active member_products.
-- Today users.member_id = SW6291958 (terminated plan); active plan is on MW15990262.
--
-- Run against ShareWELLPartners on swp-sql-srvr.database.windows.net

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @LoginEmail NVARCHAR(256) = 'mark@mightywell.us';
DECLARE @TerminatedMemberId NVARCHAR(50) = 'SW6291958';
DECLARE @ActiveMemberId NVARCHAR(50) = 'MW15990262';
DECLARE @UserId UNIQUEIDENTIFIER = '3EC87062-3A23-4AB1-B076-6D4D2D243FB7';
DECLARE @TerminatedMemberGuid UNIQUEIDENTIFIER = 'C9B5BA49-A4F9-4DE2-9631-274CC9FFA6BE';
DECLARE @ActiveMemberGuid UNIQUEIDENTIFIER = '83D0CC75-65DC-4EA9-AC35-57B48F5561A3';
DECLARE @NewTerminatedEmail NVARCHAR(256) = 'terminated_' + @LoginEmail;

IF EXISTS (
    SELECT 1
    FROM dbo.members m
    WHERE LTRIM(RTRIM(LOWER(m.email))) = LOWER(@NewTerminatedEmail)
      AND m.id <> @TerminatedMemberGuid
)
BEGIN
    RAISERROR('Refusing update: terminated_ email already used by another members row.', 16, 1);
    RETURN;
END;

IF NOT EXISTS (
    SELECT 1
    FROM dbo.members m
    WHERE m.id = @ActiveMemberGuid
      AND m.member_id = @ActiveMemberId
      AND LTRIM(RTRIM(LOWER(m.email))) = LOWER(@LoginEmail)
)
BEGIN
    RAISERROR('Active member MW15990262 not found with expected email.', 16, 1);
    RETURN;
END;

IF EXISTS (
    SELECT 1
    FROM dbo.users u
    WHERE LTRIM(RTRIM(LOWER(u.email))) = LOWER(@LoginEmail)
      AND u.id <> @UserId
)
BEGIN
    RAISERROR('Refusing update: another users row already has this login email.', 16, 1);
    RETURN;
END;

IF EXISTS (
    SELECT 1
    FROM dbo.users u
    WHERE u.id = @UserId
      AND u.member_id = @ActiveMemberId
      AND LTRIM(RTRIM(LOWER(u.email))) = LOWER(@LoginEmail)
)
AND EXISTS (
    SELECT 1
    FROM dbo.members m
    WHERE m.id = @TerminatedMemberGuid
      AND m.member_id = @TerminatedMemberId
      AND LTRIM(RTRIM(LOWER(m.email))) = LOWER(@NewTerminatedEmail)
)
BEGIN
    PRINT 'Already applied — terminated member prefixed and login points to MW15990262.';
END
ELSE
BEGIN
    BEGIN TRANSACTION;

    UPDATE dbo.members
    SET email = @NewTerminatedEmail
    WHERE id = @TerminatedMemberGuid
      AND member_id = @TerminatedMemberId
      AND LTRIM(RTRIM(LOWER(email))) = LOWER(@LoginEmail);

    IF @@ROWCOUNT <> 1
    BEGIN
        ROLLBACK TRANSACTION;
        RAISERROR('Expected exactly 1 terminated members row updated.', 16, 1);
        RETURN;
    END;

    UPDATE dbo.users
    SET member_id = @ActiveMemberId,
        first_name = 'MARK',
        last_name = 'WHITESIDES'
    WHERE id = @UserId
      AND member_id = @TerminatedMemberId
      AND LTRIM(RTRIM(LOWER(email))) = LOWER(@LoginEmail);

    IF @@ROWCOUNT <> 1
    BEGIN
        ROLLBACK TRANSACTION;
        RAISERROR('Expected exactly 1 users row repointed to active member.', 16, 1);
        RETURN;
    END;

    COMMIT TRANSACTION;
    PRINT 'Updated terminated member email and repointed login to MW15990262.';
END;

SELECT 'users' AS [table], u.id, u.email, u.username, u.member_id, u.first_name, u.last_name, u.active
FROM dbo.users u
WHERE u.id = @UserId;

SELECT 'members_active' AS [table], m.id, m.member_id, m.email, m.first_name, m.last_name, m.relationship, m.status
FROM dbo.members m
WHERE m.id = @ActiveMemberGuid;

SELECT 'members_terminated' AS [table], m.id, m.member_id, m.email, m.first_name, m.last_name, m.relationship, m.status
FROM dbo.members m
WHERE m.id = @TerminatedMemberGuid;

SELECT 'active_plans' AS [table], m.member_id, p.product_name, pb.benefit_name, mp.effective_date, mp.termination_date
FROM dbo.member_products mp
INNER JOIN dbo.members m ON m.id = mp.member_id
LEFT JOIN dbo.products p ON p.id = mp.product_id
LEFT JOIN dbo.product_benefits pb ON pb.id = mp.benefit_id
WHERE m.member_id = @ActiveMemberId
  AND (mp.termination_date IS NULL OR mp.termination_date > GETUTCDATE());
