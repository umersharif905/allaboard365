-- Backfill: Tenant/Agent INSERT paths did not set IsActive; NULL fails public onboarding (IsActive = 1) and "Active" list filter.
-- Safe: only touches rows where IsActive is unknown (NULL).

UPDATE oe.AgentOnboardingLinks
SET IsActive = 1
WHERE IsActive IS NULL;
