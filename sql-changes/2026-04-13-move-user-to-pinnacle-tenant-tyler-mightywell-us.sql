-- Move Tyler agent account to tenant "Pinnacle Life Group" (updates TenantId on user, agent, and
-- child rows that carry TenantId for that user/agent).
--
-- Target tenant (explicit GUID; no oe.Tenants query in script):
--   ./db-query.sh "SELECT TenantId, Name, Status FROM oe.Tenants WHERE Name = N'Pinnacle Life Group'"
--   -> 55EB7262-4DB6-4614-82A8-23FC2E91203B
--
-- Subject user ids read from DB (allaboard-prod) via db-query.sh 2026-04-13:
--   ./db-query.sh "SELECT u.UserId, u.Email, u.TenantId, a.AgentId FROM oe.Users u INNER JOIN oe.Agents a ON a.UserId = u.UserId WHERE LOWER(LTRIM(RTRIM(u.Email))) IN (LOWER(N'tyler@mightywell.us'), LOWER(N'tyler@mightywellhealth.com'))"
--   -> UserId = 2175DB76-1E27-4FE8-A97B-F1F9785E47C9, AgentId = A88E3E2B-41AD-44F9-9885-1E36BF2130F6, Email = tyler@mightywellhealth.com
--   (no row for tyler@mightywell.us on prod at read time — re-run query if you clone to a second login.)
--
-- In SSMS, select database allaboard-prod (or USE below). Wrong database => wrong/missing oe.* tables.
--
-- NOT updated: audit/history tables (e.g. UserActivityLog, ApplicationLogs) — avoid rewriting past events.
--
-- REVIEW AFTER RUN: oe.Agents.AgencyId, CommissionRuleId, CommissionGroupId, CommissionLevelId may still
-- reference entities from the previous tenant. Reassign or NULL in a follow-up if the app requires it.

USE [allaboard-prod];
SET NOCOUNT ON;

-- --- from db-query.sh (see header); set NULL to resolve by @Email only ---
DECLARE @UserIdExplicit UNIQUEIDENTIFIER = '2175DB76-1E27-4FE8-A97B-F1F9785E47C9';
DECLARE @AgentIdExplicit UNIQUEIDENTIFIER = 'A88E3E2B-41AD-44F9-9885-1E36BF2130F6';
-- Fallback if both NULL above: resolve by email.
DECLARE @Email NVARCHAR(255) = N'tyler@mightywellhealth.com';

DECLARE @Execute BIT = 0; -- 1 = apply updates

DECLARE @NewTenantId UNIQUEIDENTIFIER = '55EB7262-4DB6-4614-82A8-23FC2E91203B';
DECLARE @NewTenantName NVARCHAR(255) = N'Pinnacle Life Group';

DECLARE @UserId UNIQUEIDENTIFIER;
DECLARE @AgentId UNIQUEIDENTIFIER;
DECLARE @OldTenantId UNIQUEIDENTIFIER;

IF @UserIdExplicit IS NOT NULL
BEGIN
  SET @UserId = @UserIdExplicit;

  SELECT @OldTenantId = u.TenantId
  FROM oe.Users u
  WHERE u.UserId = @UserId;

  IF @OldTenantId IS NULL
  BEGIN
    RAISERROR(N'No oe.Users row for @UserIdExplicit (wrong database or invalid UserId).', 16, 1);
    RETURN;
  END

  IF @AgentIdExplicit IS NOT NULL
    SET @AgentId = @AgentIdExplicit;
  ELSE
    SELECT @AgentId = a.AgentId
    FROM oe.Agents a
    WHERE a.UserId = @UserId;
END
ELSE
BEGIN
  SELECT @UserId = u.UserId, @OldTenantId = u.TenantId
  FROM oe.Users u
  WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@Email));

  SELECT @AgentId = a.AgentId
  FROM oe.Agents a
  WHERE a.UserId = @UserId;
END

IF @UserId IS NULL
BEGIN
  RAISERROR(N'No subject user: set @UserIdExplicit to the clone user''s UserId, or ensure @Email exists in this database (run clone first if needed).', 16, 1);
  RETURN;
END

IF @AgentId IS NULL
BEGIN
  RAISERROR(N'No oe.Agents row for this user (set @AgentIdExplicit if agent row uses a different key).', 16, 1);
  RETURN;
END

IF @OldTenantId = @NewTenantId
BEGIN
  PRINT N'No-op: user already has target TenantId.';
  RETURN;
END

IF @Execute = 0
BEGIN
  SELECT N'DRY RUN — no changes' AS Mode;

  SELECT
    (SELECT u.Email FROM oe.Users u WHERE u.UserId = @UserId) AS Email,
    @UserId AS UserId,
    @AgentId AS AgentId,
    @OldTenantId AS CurrentTenantId,
    @NewTenantId AS NewTenantId,
    @NewTenantName AS NewTenantName;

  SELECT (SELECT COUNT(*) FROM oe.Members m WHERE m.UserId = @UserId) AS MembersToUpdate;
  SELECT (SELECT COUNT(*) FROM oe.AgentHierarchy h WHERE h.AgentId = @AgentId) AS AgentHierarchyToUpdate;
  SELECT (SELECT COUNT(*) FROM oe.AgentOnboardingLinks l WHERE l.AgentId = @AgentId) AS AgentOnboardingLinksToUpdate;
  SELECT (SELECT COUNT(*) FROM oe.EnrollmentLinkTemplates e WHERE e.AgentId = @AgentId) AS EnrollmentLinkTemplatesToUpdate;

  SELECT
    a.AgencyId,
    a.CommissionRuleId,
    a.CommissionGroupId,
    a.CommissionLevelId
  FROM oe.Agents a
  WHERE a.AgentId = @AgentId;

  RETURN;
END

BEGIN TRANSACTION;

BEGIN TRY
  UPDATE oe.Users
  SET
    TenantId = @NewTenantId,
    ModifiedDate = SYSUTCDATETIME()
  WHERE UserId = @UserId;

  UPDATE oe.Agents
  SET
    TenantId = @NewTenantId,
    ModifiedDate = SYSUTCDATETIME()
  WHERE AgentId = @AgentId;

  UPDATE oe.Members
  SET
    TenantId = @NewTenantId,
    ModifiedDate = SYSUTCDATETIME()
  WHERE UserId = @UserId;

  UPDATE oe.AgentHierarchy
  SET
    TenantId = @NewTenantId,
    ModifiedDate = SYSUTCDATETIME()
  WHERE AgentId = @AgentId;

  UPDATE oe.AgentOnboardingLinks
  SET
    TenantId = @NewTenantId,
    ModifiedDate = SYSUTCDATETIME()
  WHERE AgentId = @AgentId;

  UPDATE oe.EnrollmentLinkTemplates
  SET
    TenantId = @NewTenantId,
    ModifiedDate = SYSUTCDATETIME()
  WHERE AgentId = @AgentId;

  COMMIT TRANSACTION;

  SELECT
    u.UserId,
    u.Email,
    u.TenantId,
    @NewTenantName AS TenantName
  FROM oe.Users u
  WHERE u.UserId = @UserId;

  SELECT a.AgentId, a.TenantId, a.AgencyId
  FROM oe.Agents a
  WHERE a.AgentId = @AgentId;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0
    ROLLBACK TRANSACTION;
  THROW;
END CATCH
