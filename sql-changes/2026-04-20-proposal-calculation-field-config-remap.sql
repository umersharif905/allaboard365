-- Remap obsolete ShareWELL deductible configs on proposal CALCULATION fields.
-- Companion to 2026-04-20-proposal-field-config-remap.sql (which covered price
-- fields). Business proposals use FieldType='calculation' with FieldName='dynamicPrice',
-- encoding the deductible under the 'configValue' JSON key (lowercase 'c'),
-- NOT '_priceConfig' like the price fields. Previous remap missed these.
--
-- Affects 8 business proposals (Base / Gold / Silver / HSA × Overview/Proposal),
-- 72 calculation fields total on testing DB (2026-04-20):
--   3000 -> 2500: 36 rows
--   6000 -> 5000: 36 rows
--
-- Same root cause as the price-field remap: ShareWELL and derivatives use
-- deductibles 1500/2500/5000. Templates still held the old 3000/6000 values.
-- BundleProcessor's silent fallback made these render wrong numbers instead
-- of failing loudly.

SET NOCOUNT ON;

PRINT '--- Before ---';
SELECT
  SUM(CASE WHEN ConfigValue LIKE '%"configValue":"3000"%' THEN 1 ELSE 0 END) AS Count_3000,
  SUM(CASE WHEN ConfigValue LIKE '%"configValue":"6000"%' THEN 1 ELSE 0 END) AS Count_6000
FROM oe.ProposalFields
WHERE FieldType = 'calculation';

BEGIN TRANSACTION;

UPDATE oe.ProposalFields
SET ConfigValue = REPLACE(ConfigValue, '"configValue":"3000"', '"configValue":"2500"'),
    ModifiedDate = SYSUTCDATETIME()
WHERE FieldType = 'calculation'
  AND ConfigValue LIKE '%"configValue":"3000"%';

DECLARE @Updated3000 INT = @@ROWCOUNT;

UPDATE oe.ProposalFields
SET ConfigValue = REPLACE(ConfigValue, '"configValue":"6000"', '"configValue":"5000"'),
    ModifiedDate = SYSUTCDATETIME()
WHERE FieldType = 'calculation'
  AND ConfigValue LIKE '%"configValue":"6000"%';

DECLARE @Updated6000 INT = @@ROWCOUNT;

PRINT '--- Updated ---';
PRINT CONCAT('Rows updated 3000 -> 2500: ', @Updated3000);
PRINT CONCAT('Rows updated 6000 -> 5000: ', @Updated6000);

-- Verify: zero remaining 3000/6000 on calculation fields.
DECLARE @Remaining INT;
SELECT @Remaining = COUNT(*)
FROM oe.ProposalFields
WHERE FieldType = 'calculation'
  AND (ConfigValue LIKE '%"configValue":"3000"%' OR ConfigValue LIKE '%"configValue":"6000"%');

PRINT CONCAT('Remaining bad configs: ', @Remaining);

IF @Remaining > 0
BEGIN
  RAISERROR('Remaining bad configValue values found after remap. Rolling back.', 16, 1);
  ROLLBACK TRANSACTION;
END
ELSE
BEGIN
  COMMIT TRANSACTION;
  PRINT '--- Commit OK ---';
END;

PRINT '--- After ---';
SELECT
  SUM(CASE WHEN ConfigValue LIKE '%"configValue":"1500"%' THEN 1 ELSE 0 END) AS Count_1500,
  SUM(CASE WHEN ConfigValue LIKE '%"configValue":"2500"%' THEN 1 ELSE 0 END) AS Count_2500,
  SUM(CASE WHEN ConfigValue LIKE '%"configValue":"5000"%' THEN 1 ELSE 0 END) AS Count_5000,
  SUM(CASE WHEN ConfigValue LIKE '%"configValue":"3000"%' THEN 1 ELSE 0 END) AS Count_3000,
  SUM(CASE WHEN ConfigValue LIKE '%"configValue":"6000"%' THEN 1 ELSE 0 END) AS Count_6000
FROM oe.ProposalFields
WHERE FieldType = 'calculation';
