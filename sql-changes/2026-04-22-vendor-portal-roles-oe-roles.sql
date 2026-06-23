-- Vendor portal: ensure VendorAdmin, VendorAgent, VendorAccounting, VendorIT exist in oe.Roles.
-- Required for UserRolesService.assignRoleToUser when creating vendor users (admin UI, /api/me/vendor/users, etc.).
-- Idempotent: safe to run multiple times.

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF NOT EXISTS (SELECT 1 FROM oe.Roles WHERE Name = N'VendorAdmin')
BEGIN
  INSERT INTO oe.Roles (RoleId, Name, Description, IsSystemRole, CreatedDate)
  VALUES (
    NEWID(),
    N'VendorAdmin',
    N'Vendor administrator — full vendor portal access (share requests, settings, users).',
    1,
    GETUTCDATE()
  );
  PRINT 'Created VendorAdmin role';
END
ELSE
  PRINT 'VendorAdmin role already exists';

IF NOT EXISTS (SELECT 1 FROM oe.Roles WHERE Name = N'VendorAgent')
BEGIN
  INSERT INTO oe.Roles (RoleId, Name, Description, IsSystemRole, CreatedDate)
  VALUES (
    NEWID(),
    N'VendorAgent',
    N'Vendor agent — operational vendor portal access.',
    1,
    GETUTCDATE()
  );
  PRINT 'Created VendorAgent role';
END
ELSE
  PRINT 'VendorAgent role already exists';

IF NOT EXISTS (SELECT 1 FROM oe.Roles WHERE Name = N'VendorAccounting')
BEGIN
  INSERT INTO oe.Roles (RoleId, Name, Description, IsSystemRole, CreatedDate)
  VALUES (
    NEWID(),
    N'VendorAccounting',
    N'Vendor accounting — payments and financial areas of the vendor portal.',
    1,
    GETUTCDATE()
  );
  PRINT 'Created VendorAccounting role';
END
ELSE
  PRINT 'VendorAccounting role already exists';

IF NOT EXISTS (SELECT 1 FROM oe.Roles WHERE Name = N'VendorIT')
BEGIN
  INSERT INTO oe.Roles (RoleId, Name, Description, IsSystemRole, CreatedDate)
  VALUES (
    NEWID(),
    N'VendorIT',
    N'Vendor IT — integrations and technical configuration for the vendor.',
    1,
    GETUTCDATE()
  );
  PRINT 'Created VendorIT role';
END
ELSE
  PRINT 'VendorIT role already exists';

SELECT Name, RoleId, Description
FROM oe.Roles
WHERE Name IN (N'VendorAdmin', N'VendorAgent', N'VendorAccounting', N'VendorIT')
ORDER BY Name;
