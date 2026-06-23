-- Normalize EffectiveDateLogic: merge SelectedDay → SameDay (identical behavior).
-- Also fix MightyWELL Health Concierge Membership Bundle which was incorrectly set to FirstOfMonth.

BEGIN TRANSACTION;

-- 1. Fix the bundle: FirstOfMonth → SameDay (children are all SameDay/SelectedDay — "choose any day")
UPDATE oe.Products
SET    EffectiveDateLogic = 'SameDay',
       ModifiedDate = GETUTCDATE()
WHERE  ProductId = '96EB6D03-79AA-438D-B0BD-BB49E26A1D50'
  AND  EffectiveDateLogic = 'FirstOfMonth';

-- 2. Normalize all SelectedDay → SameDay across all products
UPDATE oe.Products
SET    EffectiveDateLogic = 'SameDay',
       ModifiedDate = GETUTCDATE()
WHERE  EffectiveDateLogic = 'SelectedDay';

-- Verify
SELECT ProductId, Name, EffectiveDateLogic
FROM   oe.Products
WHERE  EffectiveDateLogic IN ('SameDay')
   OR  ProductId = '96EB6D03-79AA-438D-B0BD-BB49E26A1D50'
ORDER BY Name;

COMMIT;
