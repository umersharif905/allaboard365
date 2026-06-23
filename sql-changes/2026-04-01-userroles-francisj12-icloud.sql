/*
  One-time fix: ensure oe.UserRoles rows for francisj12@icloud.com only.

  - Member: insert if user has an oe.Members row and role not already assigned.
  - Agent: insert only if user has an oe.Agents row and role not already assigned.

  Idempotent: safe to re-run.

  User: francisj12@icloud.com
  UserId: 30D27716-0A12-499D-9BBD-2CDA563AD8D3
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email NVARCHAR(256) = N'francisj12@icloud.com';
DECLARE @UserId UNIQUEIDENTIFIER = '30D27716-0A12-499D-9BBD-2CDA563AD8D3';

IF NOT EXISTS (SELECT 1 FROM oe.Users WHERE UserId = @UserId AND Email = @Email)
BEGIN
  RAISERROR(N'Expected user not found: verify Email and UserId match this environment.', 16, 1);
  RETURN;
END;

DECLARE @MemberRoleId UNIQUEIDENTIFIER = (SELECT RoleId FROM oe.Roles WHERE Name = N'Member');
DECLARE @AgentRoleId UNIQUEIDENTIFIER = (SELECT RoleId FROM oe.Roles WHERE Name = N'Agent');

IF @MemberRoleId IS NULL OR @AgentRoleId IS NULL
BEGIN
  RAISERROR(N'Member or Agent role missing from oe.Roles.', 16, 1);
  RETURN;
END;

BEGIN TRANSACTION;

-- Member role (when they are a member)
IF EXISTS (SELECT 1 FROM oe.Members WHERE UserId = @UserId)
   AND NOT EXISTS (
     SELECT 1 FROM oe.UserRoles WHERE UserId = @UserId AND RoleId = @MemberRoleId
   )
BEGIN
  INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
  VALUES (NEWID(), @UserId, @MemberRoleId, NULL, GETDATE());
  PRINT N'Inserted Member role.';
END
ELSE
  PRINT N'Member role skipped (no member row or already assigned).';

-- Agent role (only when they have an agent record)
IF EXISTS (SELECT 1 FROM oe.Agents WHERE UserId = @UserId)
   AND NOT EXISTS (
     SELECT 1 FROM oe.UserRoles WHERE UserId = @UserId AND RoleId = @AgentRoleId
   )
BEGIN
  INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
  VALUES (NEWID(), @UserId, @AgentRoleId, NULL, GETDATE());
  PRINT N'Inserted Agent role.';
END
ELSE
  PRINT N'Agent role skipped (no agent row or already assigned).';

COMMIT TRANSACTION;

SELECT r.Name AS RoleName, ur.CreatedDate
FROM oe.UserRoles ur
INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
WHERE ur.UserId = @UserId
ORDER BY r.Name;
