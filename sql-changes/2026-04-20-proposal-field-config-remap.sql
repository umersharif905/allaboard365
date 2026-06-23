-- Remap obsolete ShareWELL deductible configs on proposal price fields.
-- Context: ShareWELL (and derivatives like ShareWELL Concierge) were migrated to
-- deductibles 1500/2500/5000. Proposal templates still held the old 1500/3000/6000
-- values baked into ProposalFields.ConfigValue's _priceConfig key. When proposal
-- PDF generation requested a missing config (3000 or 6000), BundleProcessor's
-- silent fallback picked the first matching row regardless of config, so all
-- three price fields on a page rendered the same price.
--
-- This script fixes the template data by remapping:
--   _priceConfig: "3000" -> "2500"
--   _priceConfig: "6000" -> "5000"
-- The 1500 entries are already correct.
--
-- Safe-by-inspection:
--   - REPLACE is scoped to the exact substring '"_priceConfig":"3000"' / "6000".
--   - Only rows where FieldType='price' and the substring exists are touched.
--   - No JSON parse required; works on malformed legacy ConfigValue too.
--
-- Expected row counts (verified on testing DB 2026-04-20):
--   3000 -> 2500: 10 rows
--   6000 -> 5000: 6 rows
--   Total: 16 rows across 4 ProposalDocuments (all individual / Category='General').

SET NOCOUNT ON;

PRINT '--- Before ---';
SELECT
  SUM(CASE WHEN ConfigValue LIKE '%"_priceConfig":"3000"%' THEN 1 ELSE 0 END) AS Count_3000,
  SUM(CASE WHEN ConfigValue LIKE '%"_priceConfig":"6000"%' THEN 1 ELSE 0 END) AS Count_6000
FROM oe.ProposalFields
WHERE FieldType = 'price';

BEGIN TRANSACTION;

UPDATE oe.ProposalFields
SET ConfigValue = REPLACE(ConfigValue, '"_priceConfig":"3000"', '"_priceConfig":"2500"'),
    ModifiedDate = SYSUTCDATETIME()
WHERE FieldType = 'price'
  AND ConfigValue LIKE '%"_priceConfig":"3000"%';

DECLARE @Updated3000 INT = @@ROWCOUNT;

UPDATE oe.ProposalFields
SET ConfigValue = REPLACE(ConfigValue, '"_priceConfig":"6000"', '"_priceConfig":"5000"'),
    ModifiedDate = SYSUTCDATETIME()
WHERE FieldType = 'price'
  AND ConfigValue LIKE '%"_priceConfig":"6000"%';

DECLARE @Updated6000 INT = @@ROWCOUNT;

PRINT '--- Updated ---';
PRINT CONCAT('Rows updated 3000 -> 2500: ', @Updated3000);
PRINT CONCAT('Rows updated 6000 -> 5000: ', @Updated6000);

-- Verify: zero remaining 3000 or 6000 fields.
DECLARE @Remaining INT;
SELECT @Remaining = COUNT(*)
FROM oe.ProposalFields
WHERE FieldType = 'price'
  AND (ConfigValue LIKE '%"_priceConfig":"3000"%' OR ConfigValue LIKE '%"_priceConfig":"6000"%');

PRINT CONCAT('Remaining bad configs: ', @Remaining);

IF @Remaining > 0
BEGIN
  RAISERROR('Remaining bad _priceConfig values found after remap. Rolling back.', 16, 1);
  ROLLBACK TRANSACTION;
END
ELSE
BEGIN
  COMMIT TRANSACTION;
  PRINT '--- Commit OK ---';
END;

PRINT '--- After ---';
SELECT
  SUM(CASE WHEN ConfigValue LIKE '%"_priceConfig":"1500"%' THEN 1 ELSE 0 END) AS Count_1500,
  SUM(CASE WHEN ConfigValue LIKE '%"_priceConfig":"2500"%' THEN 1 ELSE 0 END) AS Count_2500,
  SUM(CASE WHEN ConfigValue LIKE '%"_priceConfig":"5000"%' THEN 1 ELSE 0 END) AS Count_5000,
  SUM(CASE WHEN ConfigValue LIKE '%"_priceConfig":"3000"%' THEN 1 ELSE 0 END) AS Count_3000,
  SUM(CASE WHEN ConfigValue LIKE '%"_priceConfig":"6000"%' THEN 1 ELSE 0 END) AS Count_6000
FROM oe.ProposalFields
WHERE FieldType = 'price';
