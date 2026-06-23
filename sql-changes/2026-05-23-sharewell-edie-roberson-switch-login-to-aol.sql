-- ShareWELL DB: Switch Edie Roberson login email from Gmail to AOL.
-- Member SW8654381; active plans on primary member row.
-- Run against ShareWELLPartners on swp-sql-srvr.database.windows.net

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @MemberId NVARCHAR(50) = 'SW8654381';
DECLARE @UserId UNIQUEIDENTIFIER = 'DE9BD5A9-1663-466C-8517-8B93500B60C8';
DECLARE @AccountId UNIQUEIDENTIFIER = '0ABA255E-47AB-465C-9CE6-86BD503021AA';
DECLARE @OldEmail NVARCHAR(256) = 'EDIEBUG1968@GMAIL.COM';
DECLARE @NewEmail NVARCHAR(256) = 'EDIEBUG1968@AOL.COM';

IF EXISTS (
    SELECT 1
    FROM dbo.users u
    WHERE LTRIM(RTRIM(LOWER(u.email))) = LOWER(@NewEmail)
      AND u.id <> @UserId
)
BEGIN
    RAISERROR('Refusing update: AOL email already used by another users row.', 16, 1);
    RETURN;
END;

IF EXISTS (
    SELECT 1
    FROM dbo.users u
    WHERE u.id = @UserId
      AND u.member_id = @MemberId
      AND LTRIM(RTRIM(LOWER(u.email))) = LOWER(@NewEmail)
)
AND EXISTS (
    SELECT 1
    FROM dbo.accounts a
    WHERE a.id = @AccountId
      AND a.primary_member_id = @MemberId
      AND LTRIM(RTRIM(LOWER(a.contact_email))) = LOWER(@NewEmail)
)
BEGIN
    PRINT 'Already on AOL — no changes needed.';
END
ELSE
BEGIN
    BEGIN TRANSACTION;

    UPDATE dbo.users
    SET email = @NewEmail,
        username = @NewEmail
    WHERE id = @UserId
      AND member_id = @MemberId
      AND LTRIM(RTRIM(LOWER(email))) = LOWER(@OldEmail);

    IF @@ROWCOUNT <> 1
    BEGIN
        ROLLBACK TRANSACTION;
        RAISERROR('Expected exactly 1 users row updated from Gmail to AOL. Check current users.email first.', 16, 1);
        RETURN;
    END;

    UPDATE dbo.accounts
    SET contact_email = @NewEmail
    WHERE id = @AccountId
      AND primary_member_id = @MemberId
      AND LTRIM(RTRIM(LOWER(contact_email))) = LOWER(@OldEmail);

    IF @@ROWCOUNT <> 1
    BEGIN
        ROLLBACK TRANSACTION;
        RAISERROR('Expected exactly 1 accounts row updated from Gmail to AOL. Check current contact_email first.', 16, 1);
        RETURN;
    END;

    COMMIT TRANSACTION;
    PRINT 'Updated users + accounts to AOL.';
END;

SELECT 'users' AS [table], u.id, u.email, u.username, u.member_id, u.first_name, u.last_name
FROM dbo.users u
WHERE u.id = @UserId;

SELECT 'accounts' AS [table], a.id, a.contact_email, a.primary_member_id, a.contact_first_name, a.contact_last_name
FROM dbo.accounts a
WHERE a.id = @AccountId;

SELECT 'members_primary' AS [table], m.id, m.email, m.member_id, m.first_name, m.last_name, m.relationship
FROM dbo.members m
WHERE m.id = '370D9A9D-7CE1-44CA-9B0F-FA038CF1CA4E';
