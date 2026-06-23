/*
Add AgencyOwner role to oe.Roles (if missing) and assign to Toby Pedford (Toby@kevobenefits.com).
AgencyOwner = agent who owns an agency, can manage downline agents, templates, etc.

Run: ./ai_scripts/db-execute.sh ai_scripts/add-agencyowner-role-toby.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @TobyUserId UNIQUEIDENTIFIER = 'C3735394-1570-409E-BC5F-8C62D07BA024';  -- Toby@kevobenefits.com

-- 1. Create AgencyOwner role if it doesn't exist
IF NOT EXISTS (SELECT 1 FROM oe.Roles WHERE Name = 'AgencyOwner')
BEGIN
  INSERT INTO oe.Roles (RoleId, Name, Description, IsSystemRole, CreatedDate)
  VALUES (NEWID(), 'AgencyOwner', 'Agency owner - can manage downline agents, agency settings, and templates', 1, GETUTCDATE());
  PRINT 'Created AgencyOwner role';
END
ELSE
  PRINT 'AgencyOwner role already exists';

-- 2. Get AgencyOwner RoleId
DECLARE @AgencyOwnerRoleId UNIQUEIDENTIFIER = (SELECT RoleId FROM oe.Roles WHERE Name = 'AgencyOwner');

-- 3. Assign AgencyOwner to Toby if not already assigned
IF NOT EXISTS (SELECT 1 FROM oe.UserRoles WHERE UserId = @TobyUserId AND RoleId = @AgencyOwnerRoleId)
BEGIN
  INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedDate)
  VALUES (NEWID(), @TobyUserId, @AgencyOwnerRoleId, GETUTCDATE());
  PRINT 'Assigned AgencyOwner role to Toby Pedford';
END
ELSE
  PRINT 'Toby already has AgencyOwner role';

-- Verify
SELECT u.FirstName, u.LastName, u.Email, r.Name AS RoleName
FROM oe.Users u
INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
WHERE u.UserId = @TobyUserId;
