-- Fix: Member portal requires a row in oe.UserRoles for role "Member".
-- HouseholdMemberID MW15990782 had UserId set on oe.Members but no oe.UserRoles rows
-- (user: Aaron Crumbaugh / aaron@scfinandins.com, UserId 78F7B71E-0BCB-4F65-BAE7-753E70352E20).
-- Idempotent: skips if Member role already present for that user.

DECLARE @HouseholdMemberID NVARCHAR(50) = N'MW15990782';

DECLARE @UserId UNIQUEIDENTIFIER;
SELECT @UserId = m.UserId
FROM oe.Members m
WHERE m.HouseholdMemberID = @HouseholdMemberID;

IF @UserId IS NULL
BEGIN
  RAISERROR(N'No member found for HouseholdMemberID %s', 16, 1, @HouseholdMemberID);
  RETURN;
END;

DECLARE @MemberRoleId UNIQUEIDENTIFIER;
SELECT @MemberRoleId = r.RoleId
FROM oe.Roles r
WHERE r.Name = N'Member';

IF @MemberRoleId IS NULL
BEGIN
  RAISERROR(N'Member role not found in oe.Roles', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1
  FROM oe.UserRoles ur
  WHERE ur.UserId = @UserId AND ur.RoleId = @MemberRoleId
)
BEGIN
  INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
  VALUES (NEWID(), @UserId, @MemberRoleId, NULL, SYSUTCDATETIME());
END
