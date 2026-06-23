/*
Migrate Steve Burris and Richard Reynolds from Kevo Benefits tenant to MightyWELL.
- Change their tenant to MightyWELL Health
- Remove TenantAdmin role (if any)
- Assign them to Kevo Benefits agency within MightyWELL

Default: DRY RUN. Set @DryRun = 0 to execute.

Run: ./ai_scripts/db-execute.sh ai_scripts/migrate-kevo-agents-to-mightywell.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- 1 = dry run, 0 = execute

-- Target IDs (from DB lookup)
DECLARE @KevoTenantId UNIQUEIDENTIFIER = '85005456-5A97-43BE-9E35-0FD78578E91B';
DECLARE @MightyWellTenantId UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
DECLARE @KevoAgencyInMW UNIQUEIDENTIFIER = '96DF8FBA-A753-4286-9417-6882E8F92332';
DECLARE @TenantAdminRoleId UNIQUEIDENTIFIER = '246A7EE8-3CD7-46A4-AAA5-2BF2518DBFC8';

-- User IDs: Steve Burris (steve@kevobenefits.com), Richard Reynolds (richardnrey69@gmail.com)
DECLARE @SteveUserId UNIQUEIDENTIFIER = '8C8D5487-4FC6-43EE-907D-96E30C30F721';
DECLARE @RichardUserId UNIQUEIDENTIFIER = '45FE1292-D087-4889-B44D-9D1D21211D8E';

PRINT '=== DRY RUN: Migrate Kevo agents (Steve Burris, Richard Reynolds) to MightyWELL ===';
PRINT 'DryRun: ' + CAST(@DryRun AS NVARCHAR(1));

-- Show current state
SELECT 'CURRENT oe.Users' AS [Step], u.UserId, u.FirstName, u.LastName, u.Email, u.TenantId
FROM oe.Users u
WHERE u.UserId IN (@SteveUserId, @RichardUserId);

SELECT 'CURRENT oe.Agents' AS [Step], a.AgentId, a.UserId, a.TenantId, a.AgencyId
FROM oe.Agents a
WHERE a.UserId IN (@SteveUserId, @RichardUserId);

SELECT 'TenantAdmin roles to remove' AS [Step], ur.UserRoleId, ur.UserId, r.Name AS RoleName
FROM oe.UserRoles ur
INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
WHERE ur.UserId IN (@SteveUserId, @RichardUserId) AND r.Name = 'TenantAdmin';

IF @DryRun = 1
BEGIN
  PRINT 'DRY RUN complete. No changes applied. Set @DryRun = 0 to execute.';
  RETURN;
END;

BEGIN TRANSACTION;

BEGIN TRY
  -- 1. Remove TenantAdmin role
  DELETE FROM oe.UserRoles
  WHERE UserId IN (@SteveUserId, @RichardUserId) AND RoleId = @TenantAdminRoleId;

  PRINT 'Deleted TenantAdmin role(s): ' + CAST(@@ROWCOUNT AS NVARCHAR(10));

  -- 2. Update oe.Users: set TenantId to MightyWELL
  UPDATE oe.Users
  SET TenantId = @MightyWellTenantId, ModifiedDate = GETUTCDATE()
  WHERE UserId IN (@SteveUserId, @RichardUserId);

  PRINT 'Updated oe.Users: ' + CAST(@@ROWCOUNT AS NVARCHAR(10));

  -- 3. Update oe.Agents: set TenantId and AgencyId
  UPDATE oe.Agents
  SET TenantId = @MightyWellTenantId, AgencyId = @KevoAgencyInMW, ModifiedDate = GETUTCDATE()
  WHERE UserId IN (@SteveUserId, @RichardUserId);

  PRINT 'Updated oe.Agents: ' + CAST(@@ROWCOUNT AS NVARCHAR(10));

  COMMIT TRANSACTION;
  PRINT 'Migration complete.';

  -- Verify
  SELECT 'AFTER oe.Users' AS [Step], u.UserId, u.FirstName, u.LastName, u.TenantId, t.Name AS TenantName
  FROM oe.Users u
  LEFT JOIN oe.Tenants t ON u.TenantId = t.TenantId
  WHERE u.UserId IN (@SteveUserId, @RichardUserId);

  SELECT 'AFTER oe.Agents' AS [Step], a.AgentId, a.UserId, a.TenantId, a.AgencyId, ag.AgencyName
  FROM oe.Agents a
  LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
  WHERE a.UserId IN (@SteveUserId, @RichardUserId);

END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
  DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
  PRINT 'FAILED: ' + @Err;
  THROW;
END CATCH;
