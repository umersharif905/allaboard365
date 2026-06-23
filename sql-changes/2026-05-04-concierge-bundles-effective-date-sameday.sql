-- Migration: Switch Concierge bundle EffectiveDateLogic from FirstOfMonth to SameDay
-- Purpose: Allow individual enrollment in the two Concierge bundles to choose any day
--          within 90 days, instead of being restricted to the 1st of the month.
--          Group enrollment is unaffected — the group code path in
--          backend/routes/effective-dates.js generates 1st-of-month dates regardless
--          of the bundle's EffectiveDateLogic value, so groups still get the
--          1st-of-month dropdown.
--
--          Both bundles' components are already 'SameDay', so flipping the wrapper
--          fully unblocks any-day enrollment for individuals.
--
-- Affected products:
--   • 96EB6D03-79AA-438D-B0BD-BB49E26A1D50 — MightyWELL Health Concierge Membership Bundle
--   • F07B391A-37C0-44EA-BF7D-1A9511659AB7 — ShareWELL Concierge (bundle wrapper)
--
-- Already applied to TESTING (allaboard-testing) on 2026-05-04.
-- This migration applies the same change to PROD.
--
-- DryRun = 1 (default): preview only, no writes
-- DryRun = 0: execute UPDATEs

DECLARE @DryRun BIT = 1;

-- ============================================================
-- Pre-change snapshot (always shown)
-- ============================================================
PRINT '=== Before ===';
SELECT
  ProductId,
  Name,
  EffectiveDateLogic,
  Status,
  ModifiedDate
FROM oe.Products
WHERE ProductId IN (
  '96EB6D03-79AA-438D-B0BD-BB49E26A1D50',  -- MightyWELL Health Concierge Membership Bundle
  'F07B391A-37C0-44EA-BF7D-1A9511659AB7'   -- ShareWELL Concierge bundle
)
ORDER BY Name;

-- ============================================================
-- Step 1: MightyWELL Health Concierge Membership Bundle → SameDay
-- ============================================================
IF EXISTS (
  SELECT 1 FROM oe.Products
  WHERE ProductId = '96EB6D03-79AA-438D-B0BD-BB49E26A1D50'
    AND EffectiveDateLogic = 'FirstOfMonth'
)
BEGIN
  IF @DryRun = 0
  BEGIN
    UPDATE oe.Products
    SET EffectiveDateLogic = 'SameDay',
        ModifiedDate = GETUTCDATE()
    WHERE ProductId = '96EB6D03-79AA-438D-B0BD-BB49E26A1D50'
      AND EffectiveDateLogic = 'FirstOfMonth';
    PRINT 'Updated MightyWELL Health Concierge Membership Bundle → SameDay';
  END
  ELSE
  BEGIN
    PRINT '[DryRun] Would update MightyWELL Health Concierge Membership Bundle → SameDay';
  END
END
ELSE
BEGIN
  PRINT 'MightyWELL Health Concierge Membership Bundle is not FirstOfMonth — skipping';
END;

-- ============================================================
-- Step 2: ShareWELL Concierge (bundle wrapper) → SameDay
-- ============================================================
IF EXISTS (
  SELECT 1 FROM oe.Products
  WHERE ProductId = 'F07B391A-37C0-44EA-BF7D-1A9511659AB7'
    AND EffectiveDateLogic = 'FirstOfMonth'
)
BEGIN
  IF @DryRun = 0
  BEGIN
    UPDATE oe.Products
    SET EffectiveDateLogic = 'SameDay',
        ModifiedDate = GETUTCDATE()
    WHERE ProductId = 'F07B391A-37C0-44EA-BF7D-1A9511659AB7'
      AND EffectiveDateLogic = 'FirstOfMonth';
    PRINT 'Updated ShareWELL Concierge bundle → SameDay';
  END
  ELSE
  BEGIN
    PRINT '[DryRun] Would update ShareWELL Concierge bundle → SameDay';
  END
END
ELSE
BEGIN
  PRINT 'ShareWELL Concierge bundle is not FirstOfMonth — skipping';
END;

-- ============================================================
-- Post-change verification (always shown)
-- ============================================================
PRINT '=== After ===';
SELECT
  ProductId,
  Name,
  EffectiveDateLogic,
  Status,
  ModifiedDate
FROM oe.Products
WHERE ProductId IN (
  '96EB6D03-79AA-438D-B0BD-BB49E26A1D50',
  'F07B391A-37C0-44EA-BF7D-1A9511659AB7'
)
ORDER BY Name;

-- ============================================================
-- ROLLBACK (uncomment and run separately to revert)
-- ============================================================
-- UPDATE oe.Products
-- SET EffectiveDateLogic = 'FirstOfMonth',
--     ModifiedDate = GETUTCDATE()
-- WHERE ProductId IN (
--   '96EB6D03-79AA-438D-B0BD-BB49E26A1D50',
--   'F07B391A-37C0-44EA-BF7D-1A9511659AB7'
-- );
