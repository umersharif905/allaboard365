-- One-off: ensure oe.UserRoles has the Agent role for a user identified by email.
-- Agent RoleId comes from oe.Roles (Name = N'Agent'); insert is skipped if the pair already exists.
-- Review output, then run in a transaction if you want rollback safety.

DECLARE @Email NVARCHAR(320) = N'Fischholdings@gmail.com';

DECLARE @UserId UNIQUEIDENTIFIER;
DECLARE @RoleId UNIQUEIDENTIFIER;

SELECT @RoleId = r.RoleId
FROM oe.Roles r
WHERE r.Name = N'Agent'
  AND r.TenantId IS NULL;

SELECT @UserId = u.UserId
FROM oe.Users u
WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@Email));

-- Preview
SELECT @UserId AS ResolvedUserId, @RoleId AS AgentRoleId;

SELECT ur.UserRoleId, ur.UserId, ur.RoleId, r.Name AS RoleName, ur.CreatedDate
FROM oe.UserRoles ur
INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
WHERE ur.UserId = @UserId;

-- Assign Agent role (idempotent: UQ_UserRoles_UserRole on UserId + RoleId)
IF @UserId IS NULL
BEGIN
    RAISERROR(N'No oe.Users row for that email.', 16, 1);
END
ELSE IF @RoleId IS NULL
BEGIN
    RAISERROR(N'oe.Roles row for Agent (TenantId NULL) not found.', 16, 1);
END
ELSE IF NOT EXISTS (
    SELECT 1
    FROM oe.UserRoles ur
    WHERE ur.UserId = @UserId
      AND ur.RoleId = @RoleId
)
BEGIN
    INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
    VALUES (NEWID(), @UserId, @RoleId, NULL, GETUTCDATE());
END

-- Verify
SELECT ur.UserRoleId, ur.UserId, ur.RoleId, r.Name AS RoleName, ur.CreatedDate
FROM oe.UserRoles ur
INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
WHERE ur.UserId = @UserId;
