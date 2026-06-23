-- =============================================
-- Add 'PlanTermination' campaign trigger type
-- =============================================
-- Allows campaigns to fire when a member's coverage is terminated.
-- The nightly enrollment-termination-sync job (which flips Active -> Terminated
-- once TerminationDate passes) fires this trigger so a termination email is sent.
--
-- This only widens the CHECK constraint on oe.Campaigns.TriggerType. No data is
-- modified. Run against each environment (staging, prod) before deploying the code.
--
-- Safe to re-run: it drops the constraint only if present, then recreates it.
-- =============================================

SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_Campaigns_TriggerType'
    AND parent_object_id = OBJECT_ID('oe.Campaigns')
)
BEGIN
  ALTER TABLE oe.Campaigns DROP CONSTRAINT CK_Campaigns_TriggerType;
END;

ALTER TABLE oe.Campaigns
  ADD CONSTRAINT CK_Campaigns_TriggerType
  CHECK (TriggerType IN ('EnrollmentCompletion', 'FirstDayOfCoverage', 'DependentAdded', 'PlanTermination'));

COMMIT TRANSACTION;

-- Verify (read-only):
-- SELECT definition FROM sys.check_constraints WHERE name = 'CK_Campaigns_TriggerType';
