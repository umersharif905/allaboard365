-- =============================================
-- Campaign RecipientType
-- =============================================
-- Adds a RecipientType to oe.Campaigns so a campaign can target either the
-- enrolling Member (default, existing behaviour) or the Member's assigned Agent.
--
-- 'Agent' campaigns power the "notify the agent when a client enrolls under
-- them" use case: an EnrollmentCompletion campaign whose email is delivered to
-- the agent's email instead of the member's.
--
-- Idempotent — safe to run more than once.
-- DDL only (no data change). Run via scripts/migrate.js or the deploy pipeline.

SET NOCOUNT ON;

IF COL_LENGTH('oe.Campaigns', 'RecipientType') IS NULL
BEGIN
  ALTER TABLE oe.Campaigns
    ADD RecipientType NVARCHAR(20) NOT NULL
      CONSTRAINT DF_Campaigns_RecipientType DEFAULT 'Member';

  PRINT 'Added oe.Campaigns.RecipientType (default ''Member'')';
END
ELSE
  PRINT 'oe.Campaigns.RecipientType already exists — skipping ADD';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_Campaigns_RecipientType'
    AND parent_object_id = OBJECT_ID('oe.Campaigns')
)
BEGIN
  ALTER TABLE oe.Campaigns
    ADD CONSTRAINT CK_Campaigns_RecipientType
      CHECK (RecipientType IN ('Member', 'Agent'));

  PRINT 'Added CK_Campaigns_RecipientType';
END
ELSE
  PRINT 'CK_Campaigns_RecipientType already exists — skipping';
GO
