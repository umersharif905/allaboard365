-- 2026-06-09 — Procedure pricing snapshot columns on oe.ShareRequestProcedures
-- Branch: feat/backoffice/cpt-pricing
-- Spec: docs/superpowers/specs/2026-06-09-procedure-pricing-design.md
--
-- NOTE: the base table oe.ShareRequestProcedures already exists on BOTH
-- testing and prod, but its CREATE predates sql-changes tracking. This script
-- is ALTERs only and is idempotent (guards on COL_LENGTH).
--
-- Columns store the Medicare pricing snapshot fetched from the internal
-- pricing API (pricing.mightywellhealth.com) at lookup time, so negotiation
-- numbers stay stable even when CMS reference data updates:
--   PricingSnapshot — full JSON: sections (professional/facility/anesthesia/
--                     DRG), per-site all-in totals, 150%-200% target ranges
--   MedicareTotal   — cheapest-site all-in Medicare allowed amount
--   TargetMin/Max   — 150% / 200% of MedicareTotal (headline range)
--   SnapshotZip     — ZIP used for locality adjustment
--   SnapshotDate    — when the snapshot was fetched
--
-- Applied to testing: 2026-06-09 (this branch). MUST be applied to prod on merge.

IF COL_LENGTH('oe.ShareRequestProcedures', 'PricingSnapshot') IS NULL
    ALTER TABLE oe.ShareRequestProcedures ADD PricingSnapshot NVARCHAR(MAX) NULL;

IF COL_LENGTH('oe.ShareRequestProcedures', 'MedicareTotal') IS NULL
    ALTER TABLE oe.ShareRequestProcedures ADD MedicareTotal DECIMAL(12,2) NULL;

IF COL_LENGTH('oe.ShareRequestProcedures', 'TargetMin') IS NULL
    ALTER TABLE oe.ShareRequestProcedures ADD TargetMin DECIMAL(12,2) NULL;

IF COL_LENGTH('oe.ShareRequestProcedures', 'TargetMax') IS NULL
    ALTER TABLE oe.ShareRequestProcedures ADD TargetMax DECIMAL(12,2) NULL;

IF COL_LENGTH('oe.ShareRequestProcedures', 'SnapshotZip') IS NULL
    ALTER TABLE oe.ShareRequestProcedures ADD SnapshotZip CHAR(5) NULL;

IF COL_LENGTH('oe.ShareRequestProcedures', 'SnapshotDate') IS NULL
    ALTER TABLE oe.ShareRequestProcedures ADD SnapshotDate DATETIME2 NULL;

-- Verify
SELECT c.name, ty.name AS type_name, c.max_length, c.is_nullable
FROM sys.tables t
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE t.name = 'ShareRequestProcedures'
ORDER BY c.column_id;
