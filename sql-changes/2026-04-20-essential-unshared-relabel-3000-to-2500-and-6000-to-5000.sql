-- ============================================================================
-- Essential (ShareWELL) — Relabel "Unshared Amount $" options: 3000→2500, 6000→5000
--
-- Why this migration is safe by design:
--   • oe.Enrollments → oe.ProductPricing are linked by stable GUID (ProductPricingId),
--     not by text. Relabeling ConfigValue1 on pricing rows does NOT break that link.
--   • Display/export code (Step 1 code flip, already deployed) now prefers
--     oe.ProductPricing.ConfigValue1 over the oe.Enrollments.EnrollmentDetails
--     snapshot. So relabeling pricing immediately flows to every existing
--     Essential member's dashboard, admin Plans tab, and vendor UA column on
--     the next page load — no per-enrollment snapshot rewrite needed.
--   • We do NOT touch oe.Enrollments.EnrollmentDetails. Those snapshots stay as
--     an audit record of what the member originally selected (3000 / 6000) at
--     sign-up time. If the business ever needs the historical label, query
--     JSON_VALUE(EnrollmentDetails, '$.configuration').
--
-- Tables updated:
--   1. oe.Products.RequiredDataFields    — fieldOptions array, 1 row
--   2. oe.ProductPricing                  — ConfigValue1 + Label, 32 rows
--   3. oe.ProductBundles                  — AllowedConfigOptions, 2 rows
--   4. oe.GroupProducts                   — CustomSettings, element-wise JSON, 12 rows
--
-- Single transaction with post-check asserts. Any count mismatch triggers
-- RAISERROR which causes the transaction to be rolled back in the CATCH block.
--
-- Product under change:
--   Essential (ShareWELL) ProductId = F165AF93-8268-448D-9DD6-F02FB338EEAE
--
-- To run: review Phase 1 counts printed by the preview SELECTs, then execute
-- the whole script. COMMIT is explicit at the end.
-- ============================================================================

DECLARE @EssentialProductId UNIQUEIDENTIFIER = 'F165AF93-8268-448D-9DD6-F02FB338EEAE';
DECLARE @FieldName           NVARCHAR(100)   = N'Unshared Amount $';

-- ----------------------------------------------------------------------------
-- Preview: current state before the migration
-- ----------------------------------------------------------------------------

PRINT '--- Preview: current state ---';

SELECT
    'Products.RequiredDataFields (before)' AS Target,
    ProductId,
    RequiredDataFields
FROM oe.Products
WHERE ProductId = @EssentialProductId;

SELECT
    'ProductPricing rows to update (before)' AS Target,
    ConfigValue1,
    COUNT(*) AS [RowCount]
FROM oe.ProductPricing
WHERE ProductId = @EssentialProductId
  AND ConfigValue1 IN ('3000', '6000')
GROUP BY ConfigValue1;

SELECT
    'ProductBundles rows to update (before)' AS Target,
    ProductBundleId,
    AllowedConfigOptions
FROM oe.ProductBundles
WHERE IncludedProductId = @EssentialProductId
  AND (AllowedConfigOptions LIKE '%3000%' OR AllowedConfigOptions LIKE '%6000%');

SELECT
    'GroupProducts rows to update (before)' AS Target,
    COUNT(*) AS [RowCount]
FROM oe.GroupProducts gp
WHERE gp.CustomSettings LIKE '%F165AF93-8268-448D-9DD6-F02FB338EEAE%'
  AND (gp.CustomSettings LIKE '%"3000"%' OR gp.CustomSettings LIKE '%"6000"%');

-- ----------------------------------------------------------------------------
-- Capture expected-change counts so post-checks can assert we did the right thing
-- ----------------------------------------------------------------------------

DECLARE @ExpectedPricingRows INT;
SELECT @ExpectedPricingRows = COUNT(*)
FROM oe.ProductPricing
WHERE ProductId = @EssentialProductId
  AND ConfigValue1 IN ('3000', '6000');

DECLARE @ExpectedBundleRows INT;
SELECT @ExpectedBundleRows = COUNT(*)
FROM oe.ProductBundles
WHERE IncludedProductId = @EssentialProductId
  AND (AllowedConfigOptions LIKE '%"3000"%' OR AllowedConfigOptions LIKE '%"6000"%');

DECLARE @ExpectedGroupRows INT;
SELECT @ExpectedGroupRows = COUNT(*)
FROM oe.GroupProducts gp
WHERE gp.CustomSettings LIKE '%F165AF93-8268-448D-9DD6-F02FB338EEAE%'
  AND (gp.CustomSettings LIKE '%"3000"%' OR gp.CustomSettings LIKE '%"6000"%');

PRINT CONCAT('Expected ProductPricing rows to update: ', @ExpectedPricingRows);
PRINT CONCAT('Expected ProductBundles rows to update: ', @ExpectedBundleRows);
PRINT CONCAT('Expected GroupProducts rows to update: ', @ExpectedGroupRows);

BEGIN TRY
    BEGIN TRANSACTION;

    -- ------------------------------------------------------------------------
    -- 1. oe.Products.RequiredDataFields — rewrite fieldOptions for the Essential product
    -- ------------------------------------------------------------------------
    -- Known structure (verified pre-migration):
    --   [{"id":"1752871847153","fieldName":"Unshared Amount $","fieldOptions":["1500","3000","6000"],"isDeductible":true}]
    --
    -- New structure:
    --   [{"id":"1752871847153","fieldName":"Unshared Amount $","fieldOptions":["1500","2500","5000"],"isDeductible":true}]
    --
    -- Use JSON_MODIFY to rewrite the fieldOptions array inside the first (and only)
    -- field object. This preserves the field's id, fieldName, and isDeductible.

    UPDATE oe.Products
    SET RequiredDataFields = JSON_MODIFY(
        RequiredDataFields,
        '$[0].fieldOptions',
        JSON_QUERY('["1500","2500","5000"]')
    )
    WHERE ProductId = @EssentialProductId;

    -- ------------------------------------------------------------------------
    -- 2. oe.ProductPricing — relabel ConfigValue1 and update Label
    -- ------------------------------------------------------------------------
    -- ConfigValue1 changes: 3000 → 2500, 6000 → 5000.
    -- Label is a display label like "EE 3000" / "EF 6000" — replace the numeric
    -- suffix with the new value. Tier prefix (EE/ES/EC/EF) and spacing preserved.
    -- ProductPricingId GUIDs are NOT changed, so every existing enrollment
    -- pointing at these rows stays linked.

    UPDATE oe.ProductPricing
    SET
        ConfigValue1 = '2500',
        Label        = REPLACE(Label, '3000', '2500')
    WHERE ProductId = @EssentialProductId
      AND ConfigValue1 = '3000';

    DECLARE @Updated3000 INT = @@ROWCOUNT;

    UPDATE oe.ProductPricing
    SET
        ConfigValue1 = '5000',
        Label        = REPLACE(Label, '6000', '5000')
    WHERE ProductId = @EssentialProductId
      AND ConfigValue1 = '6000';

    DECLARE @Updated6000 INT = @@ROWCOUNT;

    PRINT CONCAT('Relabeled ProductPricing rows: 3000→2500 = ', @Updated3000, ', 6000→5000 = ', @Updated6000);

    -- ------------------------------------------------------------------------
    -- 3. oe.ProductBundles.AllowedConfigOptions — rewrite the text array
    -- ------------------------------------------------------------------------
    -- Current shape: {"Unshared Amount $":["3000","6000"]}
    -- After:          {"Unshared Amount $":["2500","5000"]}
    --
    -- Use element-wise JSON_MODIFY to rebuild the text array in a single UPDATE.
    -- We read the current array, remap each element via CASE, and write it back.

    UPDATE pb
    SET pb.AllowedConfigOptions = JSON_MODIFY(
        pb.AllowedConfigOptions,
        CONCAT('$."', @FieldName, '"'),
        JSON_QUERY(remapped.NewArrayJson)
    )
    FROM oe.ProductBundles pb
    CROSS APPLY (
        SELECT
            CONCAT(
                '[',
                STRING_AGG(
                    CONCAT(
                        '"',
                        CASE opt.[value]
                            WHEN '3000' THEN '2500'
                            WHEN '6000' THEN '5000'
                            ELSE opt.[value]
                        END,
                        '"'
                    ),
                    ','
                ),
                ']'
            ) AS NewArrayJson
        FROM OPENJSON(JSON_QUERY(pb.AllowedConfigOptions, CONCAT('$."', @FieldName, '"'))) opt
    ) remapped
    WHERE pb.IncludedProductId = @EssentialProductId
      AND (pb.AllowedConfigOptions LIKE '%"3000"%' OR pb.AllowedConfigOptions LIKE '%"6000"%');

    DECLARE @UpdatedBundles INT = @@ROWCOUNT;
    PRINT CONCAT('Relabeled ProductBundles rows: ', @UpdatedBundles);

    -- ------------------------------------------------------------------------
    -- 4. oe.GroupProducts.CustomSettings — rewrite nested deductible options array
    -- ------------------------------------------------------------------------
    -- Current shape:
    --   {"allowedDeductibleOptionsByProduct":{
    --      "F165AF93-8268-448D-9DD6-F02FB338EEAE":{"Unshared Amount $":["3000","6000"]}
    --   }}
    --
    -- Same remap approach as bundles, but at a deeper JSON path.

    DECLARE @DeepPath NVARCHAR(500) = CONCAT(
        '$.allowedDeductibleOptionsByProduct."',
        CAST(@EssentialProductId AS NVARCHAR(50)),
        '"."',
        @FieldName,
        '"'
    );

    UPDATE gp
    SET gp.CustomSettings = JSON_MODIFY(
        gp.CustomSettings,
        @DeepPath,
        JSON_QUERY(remapped.NewArrayJson)
    )
    FROM oe.GroupProducts gp
    CROSS APPLY (
        SELECT
            CONCAT(
                '[',
                STRING_AGG(
                    CONCAT(
                        '"',
                        CASE opt.[value]
                            WHEN '3000' THEN '2500'
                            WHEN '6000' THEN '5000'
                            ELSE opt.[value]
                        END,
                        '"'
                    ),
                    ','
                ),
                ']'
            ) AS NewArrayJson
        FROM OPENJSON(JSON_QUERY(gp.CustomSettings, @DeepPath)) opt
    ) remapped
    WHERE gp.CustomSettings LIKE '%F165AF93-8268-448D-9DD6-F02FB338EEAE%'
      AND (gp.CustomSettings LIKE '%"3000"%' OR gp.CustomSettings LIKE '%"6000"%');

    DECLARE @UpdatedGroups INT = @@ROWCOUNT;
    PRINT CONCAT('Relabeled GroupProducts rows: ', @UpdatedGroups);

    -- ------------------------------------------------------------------------
    -- Post-check assertions — any mismatch triggers RAISERROR → rollback
    -- ------------------------------------------------------------------------

    -- A) All ProductPricing rows we expected to relabel actually were relabeled,
    --    and the new values appear in the expected counts.
    DECLARE @TotalPricingUpdated INT = @Updated3000 + @Updated6000;
    IF @TotalPricingUpdated <> @ExpectedPricingRows
    BEGIN
        RAISERROR(
            'Post-check failed: ProductPricing update count (%d) does not match expected (%d)',
            16, 1,
            @TotalPricingUpdated, @ExpectedPricingRows
        );
    END;

    -- B) No Essential ProductPricing row should still have ConfigValue1 in (3000, 6000).
    DECLARE @LeftoverPricing INT;
    SELECT @LeftoverPricing = COUNT(*)
    FROM oe.ProductPricing
    WHERE ProductId = @EssentialProductId
      AND ConfigValue1 IN ('3000', '6000');

    IF @LeftoverPricing > 0
    BEGIN
        RAISERROR(
            'Post-check failed: %d Essential ProductPricing rows still have ConfigValue1 in (3000, 6000)',
            16, 1, @LeftoverPricing
        );
    END;

    -- C) Products.RequiredDataFields fieldOptions array should no longer contain
    --    "3000" or "6000" for Essential.
    DECLARE @LeftoverProductOptions INT;
    SELECT @LeftoverProductOptions = COUNT(*)
    FROM oe.Products
    WHERE ProductId = @EssentialProductId
      AND (RequiredDataFields LIKE '%"3000"%' OR RequiredDataFields LIKE '%"6000"%');

    IF @LeftoverProductOptions > 0
    BEGIN
        RAISERROR(
            'Post-check failed: oe.Products.RequiredDataFields still contains "3000" or "6000" for Essential',
            16, 1
        );
    END;

    -- D) ProductBundles relabel count should match expected.
    IF @UpdatedBundles <> @ExpectedBundleRows
    BEGIN
        RAISERROR(
            'Post-check failed: ProductBundles update count (%d) does not match expected (%d)',
            16, 1, @UpdatedBundles, @ExpectedBundleRows
        );
    END;

    -- E) No Essential-linked ProductBundles row should still contain "3000" or "6000".
    DECLARE @LeftoverBundles INT;
    SELECT @LeftoverBundles = COUNT(*)
    FROM oe.ProductBundles
    WHERE IncludedProductId = @EssentialProductId
      AND (AllowedConfigOptions LIKE '%"3000"%' OR AllowedConfigOptions LIKE '%"6000"%');

    IF @LeftoverBundles > 0
    BEGIN
        RAISERROR(
            'Post-check failed: %d ProductBundles rows still reference "3000" or "6000" for Essential',
            16, 1, @LeftoverBundles
        );
    END;

    -- F) GroupProducts relabel count should match expected.
    IF @UpdatedGroups <> @ExpectedGroupRows
    BEGIN
        RAISERROR(
            'Post-check failed: GroupProducts update count (%d) does not match expected (%d)',
            16, 1, @UpdatedGroups, @ExpectedGroupRows
        );
    END;

    -- G) No GroupProducts.CustomSettings row keyed on Essential should still contain
    --    "3000" or "6000" for its deductible options.
    --    (We use a string LIKE here which could theoretically match "3000" inside an
    --    unrelated product's block, so this is a weaker check than A/D. It's still a
    --    useful sanity guard — if any Essential entry remains with the old text, this
    --    would catch it unless another product has the same value.)
    DECLARE @LeftoverGroups INT;
    SELECT @LeftoverGroups = COUNT(*)
    FROM oe.GroupProducts gp
    CROSS APPLY OPENJSON(
        JSON_QUERY(gp.CustomSettings, @DeepPath)
    ) opt
    WHERE gp.CustomSettings LIKE '%F165AF93-8268-448D-9DD6-F02FB338EEAE%'
      AND opt.[value] IN ('3000', '6000');

    IF @LeftoverGroups > 0
    BEGIN
        RAISERROR(
            'Post-check failed: %d GroupProducts deductible entries still contain "3000" or "6000" for Essential',
            16, 1, @LeftoverGroups
        );
    END;

    PRINT '--- All post-checks passed ---';

    COMMIT TRANSACTION;

    PRINT '--- Migration committed ---';

END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRANSACTION;

    PRINT '--- Migration ROLLED BACK due to error ---';
    PRINT ERROR_MESSAGE();
    THROW;
END CATCH;

-- ----------------------------------------------------------------------------
-- Post-migration verification (read-only — run after commit to sanity check)
-- ----------------------------------------------------------------------------

PRINT '--- Post-migration state ---';

SELECT
    'Products.RequiredDataFields (after)' AS Target,
    ProductId,
    RequiredDataFields
FROM oe.Products
WHERE ProductId = 'F165AF93-8268-448D-9DD6-F02FB338EEAE';

SELECT
    'ProductPricing summary (after)' AS Target,
    ConfigValue1,
    COUNT(*) AS [RowCount]
FROM oe.ProductPricing
WHERE ProductId = 'F165AF93-8268-448D-9DD6-F02FB338EEAE'
GROUP BY ConfigValue1
ORDER BY ConfigValue1;

SELECT
    'ProductBundles (after)' AS Target,
    ProductBundleId,
    AllowedConfigOptions
FROM oe.ProductBundles
WHERE IncludedProductId = 'F165AF93-8268-448D-9DD6-F02FB338EEAE';

-- Active enrollments should still resolve to new values via the Step 1 code flip:
SELECT
    'Essential active enrollments by current pricing label' AS Target,
    pp.ConfigValue1 AS CurrentLabel,
    COUNT(*) AS EnrollmentCount
FROM oe.Enrollments e
INNER JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
WHERE e.ProductId = 'F165AF93-8268-448D-9DD6-F02FB338EEAE'
  AND e.Status = 'Active'
GROUP BY pp.ConfigValue1
ORDER BY pp.ConfigValue1;
