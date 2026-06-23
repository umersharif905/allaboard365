-- Remove the VendorAccounting and VendorIT roles from the vendor portal.
-- The back office is collapsed to VendorAdmin + VendorAgent only.
--
-- Pre-flight check (2026-05-11, allaboard-testing): 0 users assigned to either
-- role, so the UserRoles DELETE is a safety net only. Production was confirmed
-- by the owner to mirror testing (PHI-redacted copy) with no additional
-- assignments for these two roles.
--
-- Idempotent: safe to run multiple times. After this script, oe.Roles will
-- have only VendorAdmin and VendorAgent in the vendor family (plus the
-- non-vendor roles SysAdmin, TenantAdmin, Agent, GroupAdmin, Member, etc.).

SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRANSACTION;

-- Capture the RoleIds being removed (so the DELETE can match by both name and id).
DECLARE @VendorAccountingRoleId UNIQUEIDENTIFIER;
DECLARE @VendorITRoleId UNIQUEIDENTIFIER;

SELECT @VendorAccountingRoleId = RoleId FROM oe.Roles WHERE Name = N'VendorAccounting';
SELECT @VendorITRoleId         = RoleId FROM oe.Roles WHERE Name = N'VendorIT';

PRINT CONCAT('VendorAccounting RoleId: ', ISNULL(CONVERT(NVARCHAR(50), @VendorAccountingRoleId), '<not found>'));
PRINT CONCAT('VendorIT RoleId:         ', ISNULL(CONVERT(NVARCHAR(50), @VendorITRoleId),         '<not found>'));

-- 1. Safety-net DELETE on oe.UserRoles. Expected: 0 rows affected (confirmed
--    against testing 2026-05-11). Any rows here would indicate a user gained
--    one of these roles between the pre-flight pull and this migration; those
--    users would lose the role (and possibly become role-less) — review before
--    applying if @@ROWCOUNT > 0 below.
DECLARE @DeletedUserRoles INT;

DELETE FROM oe.UserRoles
WHERE RoleId IN (@VendorAccountingRoleId, @VendorITRoleId);

SET @DeletedUserRoles = @@ROWCOUNT;
PRINT CONCAT('oe.UserRoles rows removed: ', @DeletedUserRoles);

-- 2. Hard delete the role definitions themselves.
DECLARE @DeletedRoles INT;

DELETE FROM oe.Roles
WHERE Name IN (N'VendorAccounting', N'VendorIT');

SET @DeletedRoles = @@ROWCOUNT;
PRINT CONCAT('oe.Roles rows removed:     ', @DeletedRoles);

COMMIT TRANSACTION;

-- Verification: only VendorAdmin and VendorAgent should remain in the vendor family.
SELECT Name, RoleId, Description, IsSystemRole
FROM oe.Roles
WHERE Name LIKE N'Vendor%'
ORDER BY Name;
