-- Migration: Split Scott Page (agent) from Klint Gable (member) — shared oe.Users row
-- Date: 2026-06-03
--
-- Prod state (pre-fix):
--   oe.Users FACDF90C... = Klint Gable / klintgable@gmail.com (Member + Agent roles)
--   oe.Agents A9502596... still has Scott Page profile (scottpage@mightywell.us, 4782341417)
--   No oe.Users row for scottpage@mightywell.us — Scott cannot log in as agent
--
-- Fix: new Scott user (agent login), re-link agent, remove Agent role from Klint (member-only).

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- APPLIED on prod 2026-06-03; set 0 only to re-run

DECLARE @KlintUserId UNIQUEIDENTIFIER = 'FACDF90C-206B-4431-A677-3B4C97216FAB';
DECLARE @ScottAgentId UNIQUEIDENTIFIER = 'A9502596-E407-451C-A22D-74758F2F22ED';
DECLARE @ScottEmail NVARCHAR(255) = N'scottpage@mightywell.us';
DECLARE @KlintEmail NVARCHAR(255) = N'klintgable@gmail.com';
DECLARE @HouseholdMemberId NVARCHAR(50) = N'SW15990942';
DECLARE @AgentRoleId UNIQUEIDENTIFIER;
DECLARE @MemberRoleId UNIQUEIDENTIFIER;
DECLARE @NewScottUserId UNIQUEIDENTIFIER = NEWID();

SELECT @AgentRoleId = r.RoleId FROM oe.Roles r WHERE r.Name = N'Agent' AND r.TenantId IS NULL;
SELECT @MemberRoleId = r.RoleId FROM oe.Roles r WHERE r.Name = N'Member' AND r.TenantId IS NULL;

BEGIN TRY
    BEGIN TRANSACTION;

    -- Safety: expected pre-state
    IF NOT EXISTS (
        SELECT 1 FROM oe.Users u
        WHERE u.UserId = @KlintUserId
          AND LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@KlintEmail))
          AND u.FirstName = N'Klint' AND u.LastName = N'Gable'
    )
    BEGIN
        RAISERROR(N'Safety check failed: Klint user email/name mismatch.', 16, 1);
    END

    IF NOT EXISTS (
        SELECT 1 FROM oe.Members m
        WHERE m.UserId = @KlintUserId AND m.HouseholdMemberID = @HouseholdMemberId
    )
    BEGIN
        RAISERROR(N'Safety check failed: Klint member SW15990942 not linked to Klint user.', 16, 1);
    END

    DECLARE @ScottUserId UNIQUEIDENTIFIER;
    SELECT @ScottUserId = u.UserId
    FROM oe.Users u
    WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@ScottEmail));

    IF @ScottUserId IS NOT NULL
    BEGIN
        IF EXISTS (
            SELECT 1 FROM oe.Agents a
            WHERE a.AgentId = @ScottAgentId AND a.UserId = @ScottUserId
        )
        AND NOT EXISTS (
            SELECT 1 FROM oe.UserRoles ur
            WHERE ur.UserId = @KlintUserId AND ur.RoleId = @AgentRoleId
        )
        AND EXISTS (
            SELECT 1 FROM oe.UserRoles ur
            WHERE ur.UserId = @ScottUserId AND ur.RoleId = @AgentRoleId
        )
        BEGIN
            SELECT N'Already applied — Scott agent login split is in place.' AS Status;
            IF @DryRun = 1 BEGIN ROLLBACK TRANSACTION; RETURN; END
        END
        ELSE
            RAISERROR(N'Scott user exists but agent/roles are not in expected split state.', 16, 1);
    END
    ELSE IF NOT EXISTS (
        SELECT 1 FROM oe.Agents a
        WHERE a.AgentId = @ScottAgentId
          AND a.UserId = @KlintUserId
          AND LOWER(LTRIM(RTRIM(a.Email))) = LOWER(LTRIM(@ScottEmail))
          AND a.FirstName = N'Scott' AND a.LastName = N'Page'
    )
    BEGIN
        RAISERROR(N'Safety check failed: Scott agent row not linked to Klint user (pre-split state).', 16, 1);
    END

    SELECT N'Current — Klint user + roles' AS Preview;
    SELECT u.UserId, u.Email, u.FirstName, u.LastName, u.PhoneNumber, u.Status,
           CASE WHEN u.PasswordHash IS NOT NULL THEN LEN(u.PasswordHash) ELSE NULL END AS PwHashLen
    FROM oe.Users u WHERE u.UserId = @KlintUserId;

    SELECT r.Name AS RoleName, ur.UserRoleId
    FROM oe.UserRoles ur
    INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
    WHERE ur.UserId = @KlintUserId;

    SELECT N'Current — Scott agent (still on Klint UserId)' AS Preview;
    SELECT a.AgentId, a.UserId, a.Email, a.FirstName, a.LastName, a.Phone, a.AgentCode, a.Status
    FROM oe.Agents a WHERE a.AgentId = @ScottAgentId;

    SELECT N'Proposed — new Scott user' AS Preview;
    SELECT @NewScottUserId AS NewScottUserId,
           @ScottEmail AS Email,
           N'Scott' AS FirstName,
           N'Page' AS LastName,
           N'4782341417' AS PhoneNumber,
           u.TenantId,
           u.Status,
           CASE WHEN u.PasswordHash IS NOT NULL THEN N'copy from Klint user' ELSE N'NULL — password reset required' END AS PasswordNote
    FROM oe.Users u WHERE u.UserId = @KlintUserId;

    IF @DryRun = 1
    BEGIN
        SELECT N'DRY RUN — no changes applied. Set @DryRun = 0 to apply.' AS Status;
        ROLLBACK TRANSACTION;
        RETURN;
    END

    INSERT INTO oe.Users (
        UserId, Email, PasswordHash, FirstName, LastName, UserType, Status, TenantId,
        PhoneNumber, LastLoginDate, MfaEnabled, ResetPasswordToken, ResetPasswordExpiry,
        UserSettings, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy, Phone, Roles,
        TerminationDate, TenantAdminLink, TenantAdminLinkCreateDate, VendorId,
        AdditionalTenants, ProfileImageUrl
    )
    SELECT
        @NewScottUserId,
        LOWER(LTRIM(RTRIM(@ScottEmail))),
        u.PasswordHash,
        N'Scott',
        N'Page',
        u.UserType,
        u.Status,
        u.TenantId,
        N'4782341417',
        NULL,
        u.MfaEnabled,
        NULL,
        NULL,
        u.UserSettings,
        SYSUTCDATETIME(),
        SYSUTCDATETIME(),
        u.CreatedBy,
        @KlintUserId,
        NULL,
        NULL,
        u.TerminationDate,
        u.TenantAdminLink,
        u.TenantAdminLinkCreateDate,
        u.VendorId,
        u.AdditionalTenants,
        u.ProfileImageUrl
    FROM oe.Users u
    WHERE u.UserId = @KlintUserId;

    UPDATE oe.Agents
    SET UserId = @NewScottUserId,
        ModifiedDate = SYSUTCDATETIME(),
        ModifiedBy = @KlintUserId
    WHERE AgentId = @ScottAgentId;

    INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
    VALUES (NEWID(), @NewScottUserId, @AgentRoleId, @KlintUserId, SYSUTCDATETIME());

    DELETE FROM oe.UserRoles
    WHERE UserId = @KlintUserId AND RoleId = @AgentRoleId;

    SELECT N'Applied — verify' AS Status;

    SELECT u.UserId, u.Email, u.FirstName, u.LastName, r.Name AS RoleName
    FROM oe.Users u
    LEFT JOIN oe.UserRoles ur ON ur.UserId = u.UserId
    LEFT JOIN oe.Roles r ON r.RoleId = ur.RoleId
    WHERE u.UserId IN (@KlintUserId, @NewScottUserId)
    ORDER BY u.Email, r.Name;

    SELECT a.AgentId, a.UserId, a.Email, a.FirstName, a.LastName, u.Email AS LoginEmail
    FROM oe.Agents a
    INNER JOIN oe.Users u ON u.UserId = a.UserId
    WHERE a.AgentId = @ScottAgentId;

    COMMIT TRANSACTION;
    SELECT N'Changes applied successfully' AS FinalStatus;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS Error, ERROR_LINE() AS Line;
END CATCH;
