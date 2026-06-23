-- Point Tyler's agent at the only agency under Pinnacle Life Group (same tenant as user after move).
--
-- Verified allaboard-prod (db-query.sh):
--   Pinnacle tenant: 55EB7262-4DB6-4614-82A8-23FC2E91203B
--   Only agency:     3BD2BE1C-EB7E-4D6A-93AA-3453C5809EF3  (AgencyName = Pinnacle Life Group)
--   Agent:           A88E3E2B-41AD-44F9-9885-1E36BF2130F6  (User 2175DB76-1E27-4FE8-A97B-F1F9785E47C9)
--
-- Also updates oe.AgentOnboardingLinks and oe.AgentHierarchy for this AgentId (they had old AgencyId).

USE [allaboard-prod];
SET NOCOUNT ON;

DECLARE @AgentId UNIQUEIDENTIFIER = 'A88E3E2B-41AD-44F9-9885-1E36BF2130F6';
DECLARE @NewAgencyId UNIQUEIDENTIFIER = '3BD2BE1C-EB7E-4D6A-93AA-3453C5809EF3';
DECLARE @Execute BIT = 0; -- 1 = apply

IF @Execute = 0
BEGIN
  SELECT N'DRY RUN' AS Mode;
  SELECT a.AgentId, a.AgencyId AS CurrentAgencyId, a.TenantId
  FROM oe.Agents a
  WHERE a.AgentId = @AgentId;

  SELECT LinkId, AgencyId FROM oe.AgentOnboardingLinks WHERE AgentId = @AgentId;
  SELECT HierarchyId, AgencyId FROM oe.AgentHierarchy WHERE AgentId = @AgentId;

  SELECT @NewAgencyId AS NewAgencyId, N'Pinnacle Life Group (oe.Agencies)' AS Note;
  RETURN;
END

BEGIN TRANSACTION;
BEGIN TRY
  UPDATE oe.Agents
  SET AgencyId = @NewAgencyId, ModifiedDate = SYSUTCDATETIME()
  WHERE AgentId = @AgentId;

  UPDATE oe.AgentOnboardingLinks
  SET AgencyId = @NewAgencyId, ModifiedDate = SYSUTCDATETIME()
  WHERE AgentId = @AgentId;

  UPDATE oe.AgentHierarchy
  SET AgencyId = @NewAgencyId, ModifiedDate = SYSUTCDATETIME()
  WHERE AgentId = @AgentId;

  COMMIT TRANSACTION;

  SELECT a.AgentId, a.AgencyId, ag.AgencyName
  FROM oe.Agents a
  INNER JOIN oe.Agencies ag ON ag.AgencyId = a.AgencyId
  WHERE a.AgentId = @AgentId;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH
