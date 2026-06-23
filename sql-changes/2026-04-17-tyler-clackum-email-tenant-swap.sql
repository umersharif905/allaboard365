/*
  Tyler Clackum — swap emails + retarget AiOS agent to MightyWELL (prod IDs as of 2026-04-17)

  Rule (source of truth)
  - Whoever owns the AgentId on **AiOS Group** (`oe.Groups`) becomes **tyler@mightywellhealth.com**,
    primary tenant **MightyWELL Health**, agent under **MightyWELL Health LLC** agency.
  - The *other* Tyler user becomes **tyler@mightywell.us**, primary tenant **Pinnacle**, tenant admin only (no agent row).

  Prod snapshot
  - AiOS Group `7075B0B2-6CF0-46BE-B672-C7198FDFE146` → AgentId `A88E3E2B-41AD-44F9-9885-1E36BF2130F6` → User `2175DB76-1E27-4FE8-A97B-F1F9785E47C9`
  - Pinnacle enrollment templates still reference the same AgentId (no template updates needed).

  AgentId is unchanged; AiOS Group.AgentId unchanged — only `oe.Agents` tenant/agency (and user emails) move.

  Run order
  1) Run PART 1 only (dry run) — confirm AiOS row matches @AgentId / @UserAgentProfile.
  2) PART 2 below is active — run entire script from line 1 on the target database in one batch (or run PART 1 then PART 2 in same session with variables in scope).

  Optional: after migration, set `oe.Users.AdditionalTenants` on the mightywellhealth.com user to include Pinnacle
  if that user should use tenant switcher for Pinnacle admin (not included here).

  OAuth / IdP: update identity provider emails if federated.
*/

SET NOCOUNT ON;

DECLARE
    @TenantMightyWell UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826', -- MightyWELL Health
    @TenantPinnacle   UNIQUEIDENTIFIER = '55EB7262-4DB6-4614-82A8-23FC2E91203B', -- Pinnacle Life Group

    @UserAgentProfile UNIQUEIDENTIFIER = '2175DB76-1E27-4FE8-A97B-F1F9785E47C9', -- keeps agent + Agent role
    @UserAdminOnly    UNIQUEIDENTIFIER = '4EA5D272-45C1-46D4-9DE7-9958FE745F75', -- tenant admin only (no agent row)

    @AgentId UNIQUEIDENTIFIER = 'A88E3E2B-41AD-44F9-9885-1E36BF2130F6',

    /* MightyWELL Health LLC — verify in oe.Agencies for @TenantMightyWell */
    @MightyWellAgencyId UNIQUEIDENTIFIER = '4532C6DC-1290-4A4A-A1A7-533497694265',

    /* AiOS Group — used in PART 1 to prove AgentId/UserId match (prod) */
    @AiOSGroupId UNIQUEIDENTIFIER = '7075B0B2-6CF0-46BE-B672-C7198FDFE146',

    @EmailFinalAgent   NVARCHAR(320) = N'tyler@mightywellhealth.com',
    @EmailFinalAdmin   NVARCHAR(320) = N'tyler@mightywell.us',
    @EmailTempAdmin    NVARCHAR(320) = N'tyler-migrate-temp-4ea5@openenroll-internal.invalid';

-- Role IDs (oe.Roles.Name — do not filter by IsSystemRole; TenantAdmin is not flagged system)
DECLARE @RoleAgentId UNIQUEIDENTIFIER = (SELECT RoleId FROM oe.Roles WHERE Name = N'Agent');
DECLARE @RoleTaId UNIQUEIDENTIFIER = (SELECT RoleId FROM oe.Roles WHERE Name = N'TenantAdmin');

PRINT N'--- Resolved role IDs (PART 2 uses these) ---';
SELECT @RoleAgentId AS RoleAgentId, @RoleTaId AS RoleTenantAdminId;

-- =============================================================================
-- PART 1 — DRY RUN (read-only). Safe to run anytime.
-- =============================================================================

PRINT N'--- PART 1: AiOS Group → Agent → User (must match @AgentId / @UserAgentProfile) ---';
SELECT
    g.GroupId,
    g.Name AS GroupName,
    g.AgentId AS GroupAgentId,
    a.UserId AS AgentUserId,
    u.Email AS AgentUserEmail
FROM oe.Groups g
INNER JOIN oe.Agents a ON a.AgentId = g.AgentId
INNER JOIN oe.Users u ON u.UserId = a.UserId
WHERE g.GroupId = @AiOSGroupId;

PRINT N'--- PART 1: Current users (expect two rows) ---';
SELECT
    u.UserId,
    u.Email,
    u.FirstName,
    u.LastName,
    u.Status,
    u.TenantId,
    t.Name AS PrimaryTenantName,
    u.AdditionalTenants
FROM oe.Users u
LEFT JOIN oe.Tenants t ON u.TenantId = t.TenantId
WHERE u.UserId IN (@UserAgentProfile, @UserAdminOnly)
ORDER BY u.Email;

PRINT N'--- PART 1: Current roles ---';
SELECT
    u.UserId,
    u.Email,
    r.Name AS RoleName
FROM oe.Users u
INNER JOIN oe.UserRoles ur ON ur.UserId = u.UserId
INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
WHERE u.UserId IN (@UserAgentProfile, @UserAdminOnly)
ORDER BY u.Email, r.Name;

PRINT N'--- PART 1: Agent row for @UserAgentProfile ---';
SELECT
    a.AgentId,
    a.UserId,
    a.TenantId,
    a.AgencyId,
    a.Status,
    ag.AgencyName,
    t.Name AS AgentTenantName
FROM oe.Agents a
LEFT JOIN oe.Agencies ag ON ag.AgencyId = a.AgencyId
LEFT JOIN oe.Tenants t ON t.TenantId = a.TenantId
WHERE a.AgentId = @AgentId;

PRINT N'--- PART 1: AgencyAdmins for this AgentId (if any) ---';
SELECT aa.*
FROM oe.AgencyAdmins aa
WHERE aa.AgentId = @AgentId;

PRINT N'--- PART 1: Groups pointing at this AgentId (sample) ---';
SELECT TOP (50) g.GroupId, g.Name, g.TenantId, t.Name AS GroupTenantName, g.AgentId
FROM oe.Groups g
LEFT JOIN oe.Tenants t ON t.TenantId = g.TenantId
WHERE g.AgentId = @AgentId;

PRINT N'--- PART 1: Target MightyWELL agency row (must match @MightyWellAgencyId) ---';
SELECT a.AgencyId, a.AgencyName, a.AgencyCode, a.TenantId, a.Status
FROM oe.Agencies a
WHERE a.AgencyId = @MightyWellAgencyId
  AND a.TenantId = @TenantMightyWell;

PRINT N'--- PART 1: Preconditions (should be 0 / 1 / 1 as described) ---';
-- Expect: two users exist; agent user has exactly one agent row; admin-only user has zero agent rows
SELECT
    (SELECT COUNT(*) FROM oe.Users WHERE UserId IN (@UserAgentProfile, @UserAdminOnly)) AS UserRowCount_Expect2,
    (SELECT COUNT(*) FROM oe.Agents WHERE UserId = @UserAgentProfile) AS AgentRowsFor2175_Expect1,
    (SELECT COUNT(*) FROM oe.Agents WHERE UserId = @UserAdminOnly) AS AgentRowsFor4EA5_Expect0;

PRINT N'--- PART 1: AiOS AgentId matches script (1 row) ---';
SELECT
    CASE
        WHEN EXISTS (
            SELECT 1
            FROM oe.Groups g
            WHERE g.GroupId = @AiOSGroupId
              AND g.AgentId = @AgentId
        )
        THEN N'OK: AiOS Group.AgentId = @AgentId'
        ELSE N'FAIL: update @AgentId / @AiOSGroupId or DB changed'
    END AS CheckAiOSAgentId;
SELECT
    CASE
        WHEN EXISTS (
            SELECT 1
            FROM oe.Agents a
            WHERE a.AgentId = @AgentId
              AND a.UserId = @UserAgentProfile
        )
        THEN N'OK: Agent row belongs to @UserAgentProfile'
        ELSE N'FAIL: update @UserAgentProfile to match AiOS agent owner'
    END AS CheckAgentUser;

PRINT N'--- PART 1 done. Review output, then run PART 2 in a transaction if correct. ---';


-- =============================================================================
-- PART 2 — APPLY (transaction). Executes on run — use correct database (prod vs testing).
-- Run from the top of this file in the same batch so DECLARE variables exist.
-- =============================================================================

BEGIN TRANSACTION tr_tyler_swap;

BEGIN TRY
    -- Preconditions
    IF (SELECT COUNT(*) FROM oe.Users WHERE UserId IN (@UserAgentProfile, @UserAdminOnly)) <> 2
        THROW 50001, N'Expected exactly two user rows.', 1;
    IF NOT EXISTS (
        SELECT 1 FROM oe.Groups g
        WHERE g.GroupId = @AiOSGroupId AND g.AgentId = @AgentId
    )
        THROW 50005, N'AiOS Group AgentId does not match @AgentId — abort.', 1;
    IF NOT EXISTS (
        SELECT 1 FROM oe.Agents a
        WHERE a.AgentId = @AgentId AND a.UserId = @UserAgentProfile AND a.Status = N'Active'
    )
        THROW 50006, N'Agent row must belong to @UserAgentProfile (AiOS owner).', 1;
    IF (SELECT COUNT(*) FROM oe.Agents WHERE UserId = @UserAgentProfile AND AgentId = @AgentId AND Status = N'Active') <> 1
        THROW 50002, N'Expected one active agent row for @UserAgentProfile.', 1;
    IF (SELECT COUNT(*) FROM oe.Agents WHERE UserId = @UserAdminOnly) <> 0
        THROW 50003, N'Expected zero agent rows for @UserAdminOnly.', 1;
    IF NOT EXISTS (
        SELECT 1 FROM oe.Agencies
        WHERE AgencyId = @MightyWellAgencyId AND TenantId = @TenantMightyWell AND Status = N'Active'
    )
        THROW 50004, N'Target MightyWELL agency missing or inactive — fix @MightyWellAgencyId.', 1;

    -- 1) Free tyler@mightywellhealth.com (currently held by @UserAdminOnly)
    UPDATE oe.Users
    SET
        Email = @EmailTempAdmin,
        ModifiedDate = GETUTCDATE()
    WHERE UserId = @UserAdminOnly;

    -- 2) Assign final email + MightyWELL primary tenant to the agent user; clear AdditionalTenants noise
    UPDATE oe.Users
    SET
        Email = @EmailFinalAgent,
        TenantId = @TenantMightyWell,
        AdditionalTenants = NULL,
        ModifiedDate = GETUTCDATE()
    WHERE UserId = @UserAgentProfile;

    -- 3) Assign final email + Pinnacle primary tenant to the admin-only user
    UPDATE oe.Users
    SET
        Email = @EmailFinalAdmin,
        TenantId = @TenantPinnacle,
        AdditionalTenants = NULL,
        ModifiedDate = GETUTCDATE()
    WHERE UserId = @UserAdminOnly;

    -- 4) Move agent home to MightyWELL tenant + MightyWELL Health LLC agency (same AgentId)
    UPDATE oe.Agents
    SET
        TenantId = @TenantMightyWell,
        AgencyId = @MightyWellAgencyId,
        ModifiedDate = GETUTCDATE()
    WHERE AgentId = @AgentId
      AND UserId = @UserAgentProfile;

    -- 5) Ensure admin-only user has TenantAdmin but NOT Agent (defensive)
    IF @RoleAgentId IS NOT NULL
        DELETE ur
        FROM oe.UserRoles ur
        WHERE ur.UserId = @UserAdminOnly
          AND ur.RoleId = @RoleAgentId;

    IF @RoleTaId IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM oe.UserRoles WHERE UserId = @UserAdminOnly AND RoleId = @RoleTaId)
        INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
        VALUES (NEWID(), @UserAdminOnly, @RoleTaId, @UserAdminOnly, GETUTCDATE());

    IF @RoleAgentId IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM oe.UserRoles WHERE UserId = @UserAgentProfile AND RoleId = @RoleAgentId)
        INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
        VALUES (NEWID(), @UserAgentProfile, @RoleAgentId, @UserAgentProfile, GETUTCDATE());

    IF @RoleTaId IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM oe.UserRoles WHERE UserId = @UserAgentProfile AND RoleId = @RoleTaId)
        INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
        VALUES (NEWID(), @UserAgentProfile, @RoleTaId, @UserAgentProfile, GETUTCDATE());

    PRINT N'--- POST-UPDATE verification ---';
    SELECT u.UserId, u.Email, u.TenantId, t.Name AS PrimaryTenantName, u.AdditionalTenants
    FROM oe.Users u
    LEFT JOIN oe.Tenants t ON t.TenantId = u.TenantId
    WHERE u.UserId IN (@UserAgentProfile, @UserAdminOnly)
    ORDER BY u.Email;

    SELECT a.AgentId, a.UserId, a.TenantId, a.AgencyId, ag.AgencyName
    FROM oe.Agents a
    LEFT JOIN oe.Agencies ag ON ag.AgencyId = a.AgencyId
    WHERE a.AgentId = @AgentId;

    SELECT u.UserId, u.Email, r.Name AS RoleName
    FROM oe.Users u
    INNER JOIN oe.UserRoles ur ON ur.UserId = u.UserId
    INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
    WHERE u.UserId IN (@UserAgentProfile, @UserAdminOnly)
    ORDER BY u.Email, r.Name;

    COMMIT TRANSACTION tr_tyler_swap;
    PRINT N'COMMIT ok.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION tr_tyler_swap;
    DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
    RAISERROR(N'Rolled back: %s', 16, 1, @Err);
END CATCH;
