-- ============================================================================
-- Sync oe.Payments breakdown columns FROM oe.Invoices where Payments is empty
--
-- Context: The Invoice-Sourced Payouts validation harness
-- (/admin/system-audit/payout-source-comparison) surfaced ~11 payments whose
-- oe.Payments breakdown columns are NULL / 0 / '' / '[]' while the matching
-- oe.Invoices row has the correct populated values.
--
-- Since readers now use COALESCE(inv.X, p.X), live payouts are already pulling
-- the right (invoice) values. This script exists purely to get the audit page
-- clean so we can eventually retire the oe.Payments fallback.
--
-- Safety rules:
--   * Invoice is CANONICAL — we only copy inv.X -> p.X, never the other way.
--   * Only update rows where p.X is "empty" AND inv.X is "populated".
--     - Scalars:  empty = ISNULL(p.X, 0) = 0    /    populated = ISNULL(inv.X, 0) <> 0
--     - JSON:     empty = NULL / '' / '[]' / '{}'  /  populated = anything else
--   * This script NEVER overwrites a non-zero / non-empty Payments value.
--   * Wrapped in BEGIN TRAN ... ROLLBACK so it's read-only until you flip
--     the final statement to COMMIT.
--
-- Columns synced:
--   Scalars: Commission, NetRate, OverrideRate, SystemFees,
--            ProcessingFeeAmount, SetupFee
--   JSON:    ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts
--
-- Safe to run multiple times (idempotent).
-- ============================================================================

BEGIN TRANSACTION;

-- -----------------------------------------------------------------------------
-- PREVIEW 1 — Per-column candidate counts
-- -----------------------------------------------------------------------------
SELECT 'Commission' AS Column_Name,
       COUNT(*) AS RowsWouldUpdate
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ISNULL(p.Commission, 0) = 0
  AND ISNULL(inv.Commission, 0) <> 0
UNION ALL
SELECT 'NetRate',
       COUNT(*)
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ISNULL(p.NetRate, 0) = 0
  AND ISNULL(inv.NetRate, 0) <> 0
UNION ALL
SELECT 'OverrideRate',
       COUNT(*)
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ISNULL(p.OverrideRate, 0) = 0
  AND ISNULL(inv.OverrideRate, 0) <> 0
UNION ALL
SELECT 'SystemFees',
       COUNT(*)
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ISNULL(p.SystemFees, 0) = 0
  AND ISNULL(inv.SystemFees, 0) <> 0
UNION ALL
SELECT 'ProcessingFeeAmount',
       COUNT(*)
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ISNULL(p.ProcessingFeeAmount, 0) = 0
  AND ISNULL(inv.ProcessingFeeAmount, 0) <> 0
UNION ALL
SELECT 'SetupFee',
       COUNT(*)
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ISNULL(p.SetupFee, 0) = 0
  AND ISNULL(inv.SetupFee, 0) <> 0
UNION ALL
SELECT 'ProductCommissions (JSON)',
       COUNT(*)
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE (p.ProductCommissions IS NULL OR LTRIM(RTRIM(p.ProductCommissions)) IN (N'', N'[]', N'{}'))
  AND (inv.ProductCommissions IS NOT NULL AND LTRIM(RTRIM(inv.ProductCommissions)) NOT IN (N'', N'[]', N'{}'))
UNION ALL
SELECT 'ProductVendorAmounts (JSON)',
       COUNT(*)
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE (p.ProductVendorAmounts IS NULL OR LTRIM(RTRIM(p.ProductVendorAmounts)) IN (N'', N'[]', N'{}'))
  AND (inv.ProductVendorAmounts IS NOT NULL AND LTRIM(RTRIM(inv.ProductVendorAmounts)) NOT IN (N'', N'[]', N'{}'))
UNION ALL
SELECT 'ProductOwnerAmounts (JSON)',
       COUNT(*)
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE (p.ProductOwnerAmounts IS NULL OR LTRIM(RTRIM(p.ProductOwnerAmounts)) IN (N'', N'[]', N'{}'))
  AND (inv.ProductOwnerAmounts IS NOT NULL AND LTRIM(RTRIM(inv.ProductOwnerAmounts)) NOT IN (N'', N'[]', N'{}'));


-- -----------------------------------------------------------------------------
-- PREVIEW 2 — Per-payment detail: exactly which rows get touched and what values
-- -----------------------------------------------------------------------------
SELECT
    p.PaymentId,
    p.InvoiceId,
    p.PaymentDate,
    p.Amount,
    -- Scalars: show current vs new side by side
    p.Commission          AS P_Commission,          inv.Commission          AS I_Commission,
    p.NetRate             AS P_NetRate,             inv.NetRate             AS I_NetRate,
    p.OverrideRate        AS P_OverrideRate,        inv.OverrideRate        AS I_OverrideRate,
    p.SystemFees          AS P_SystemFees,          inv.SystemFees          AS I_SystemFees,
    p.ProcessingFeeAmount AS P_ProcessingFeeAmount, inv.ProcessingFeeAmount AS I_ProcessingFeeAmount,
    p.SetupFee            AS P_SetupFee,            inv.SetupFee            AS I_SetupFee,
    -- JSON: length only (full value too noisy for grid)
    CASE WHEN p.ProductCommissions   IS NULL THEN 'NULL' ELSE CAST(LEN(p.ProductCommissions)   AS NVARCHAR(20)) + ' chars' END AS P_ProductCommissions_Len,
    CASE WHEN inv.ProductCommissions IS NULL THEN 'NULL' ELSE CAST(LEN(inv.ProductCommissions) AS NVARCHAR(20)) + ' chars' END AS I_ProductCommissions_Len,
    CASE WHEN p.ProductVendorAmounts   IS NULL THEN 'NULL' ELSE CAST(LEN(p.ProductVendorAmounts)   AS NVARCHAR(20)) + ' chars' END AS P_ProductVendorAmounts_Len,
    CASE WHEN inv.ProductVendorAmounts IS NULL THEN 'NULL' ELSE CAST(LEN(inv.ProductVendorAmounts) AS NVARCHAR(20)) + ' chars' END AS I_ProductVendorAmounts_Len,
    CASE WHEN p.ProductOwnerAmounts   IS NULL THEN 'NULL' ELSE CAST(LEN(p.ProductOwnerAmounts)   AS NVARCHAR(20)) + ' chars' END AS P_ProductOwnerAmounts_Len,
    CASE WHEN inv.ProductOwnerAmounts IS NULL THEN 'NULL' ELSE CAST(LEN(inv.ProductOwnerAmounts) AS NVARCHAR(20)) + ' chars' END AS I_ProductOwnerAmounts_Len
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE
    (ISNULL(p.Commission, 0)          = 0 AND ISNULL(inv.Commission, 0)          <> 0)
 OR (ISNULL(p.NetRate, 0)             = 0 AND ISNULL(inv.NetRate, 0)             <> 0)
 OR (ISNULL(p.OverrideRate, 0)        = 0 AND ISNULL(inv.OverrideRate, 0)        <> 0)
 OR (ISNULL(p.SystemFees, 0)          = 0 AND ISNULL(inv.SystemFees, 0)          <> 0)
 OR (ISNULL(p.ProcessingFeeAmount, 0) = 0 AND ISNULL(inv.ProcessingFeeAmount, 0) <> 0)
 OR (ISNULL(p.SetupFee, 0)            = 0 AND ISNULL(inv.SetupFee, 0)            <> 0)
 OR ((p.ProductCommissions   IS NULL OR LTRIM(RTRIM(p.ProductCommissions))   IN (N'', N'[]', N'{}')) AND (inv.ProductCommissions   IS NOT NULL AND LTRIM(RTRIM(inv.ProductCommissions))   NOT IN (N'', N'[]', N'{}')))
 OR ((p.ProductVendorAmounts IS NULL OR LTRIM(RTRIM(p.ProductVendorAmounts)) IN (N'', N'[]', N'{}')) AND (inv.ProductVendorAmounts IS NOT NULL AND LTRIM(RTRIM(inv.ProductVendorAmounts)) NOT IN (N'', N'[]', N'{}')))
 OR ((p.ProductOwnerAmounts  IS NULL OR LTRIM(RTRIM(p.ProductOwnerAmounts))  IN (N'', N'[]', N'{}')) AND (inv.ProductOwnerAmounts  IS NOT NULL AND LTRIM(RTRIM(inv.ProductOwnerAmounts))  NOT IN (N'', N'[]', N'{}')))
ORDER BY p.PaymentDate DESC;


-- -----------------------------------------------------------------------------
-- UPDATE 1 — Scalars. One UPDATE per column so each only touches rows where
-- that specific column is empty on Payments and populated on Invoices.
-- -----------------------------------------------------------------------------
UPDATE p
SET p.Commission = inv.Commission
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ISNULL(p.Commission, 0) = 0
  AND ISNULL(inv.Commission, 0) <> 0;
PRINT CONCAT('Commission: updated ', @@ROWCOUNT, ' row(s)');

UPDATE p
SET p.NetRate = inv.NetRate
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ISNULL(p.NetRate, 0) = 0
  AND ISNULL(inv.NetRate, 0) <> 0;
PRINT CONCAT('NetRate: updated ', @@ROWCOUNT, ' row(s)');

UPDATE p
SET p.OverrideRate = inv.OverrideRate
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ISNULL(p.OverrideRate, 0) = 0
  AND ISNULL(inv.OverrideRate, 0) <> 0;
PRINT CONCAT('OverrideRate: updated ', @@ROWCOUNT, ' row(s)');

UPDATE p
SET p.SystemFees = inv.SystemFees
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ISNULL(p.SystemFees, 0) = 0
  AND ISNULL(inv.SystemFees, 0) <> 0;
PRINT CONCAT('SystemFees: updated ', @@ROWCOUNT, ' row(s)');

UPDATE p
SET p.ProcessingFeeAmount = inv.ProcessingFeeAmount
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ISNULL(p.ProcessingFeeAmount, 0) = 0
  AND ISNULL(inv.ProcessingFeeAmount, 0) <> 0;
PRINT CONCAT('ProcessingFeeAmount: updated ', @@ROWCOUNT, ' row(s)');

UPDATE p
SET p.SetupFee = inv.SetupFee
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE ISNULL(p.SetupFee, 0) = 0
  AND ISNULL(inv.SetupFee, 0) <> 0;
PRINT CONCAT('SetupFee: updated ', @@ROWCOUNT, ' row(s)');


-- -----------------------------------------------------------------------------
-- UPDATE 2 — JSON columns. Empty = NULL / '' / '[]' / '{}'.
-- -----------------------------------------------------------------------------
UPDATE p
SET p.ProductCommissions = inv.ProductCommissions
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE (p.ProductCommissions IS NULL OR LTRIM(RTRIM(p.ProductCommissions)) IN (N'', N'[]', N'{}'))
  AND (inv.ProductCommissions IS NOT NULL AND LTRIM(RTRIM(inv.ProductCommissions)) NOT IN (N'', N'[]', N'{}'));
PRINT CONCAT('ProductCommissions: updated ', @@ROWCOUNT, ' row(s)');

UPDATE p
SET p.ProductVendorAmounts = inv.ProductVendorAmounts
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE (p.ProductVendorAmounts IS NULL OR LTRIM(RTRIM(p.ProductVendorAmounts)) IN (N'', N'[]', N'{}'))
  AND (inv.ProductVendorAmounts IS NOT NULL AND LTRIM(RTRIM(inv.ProductVendorAmounts)) NOT IN (N'', N'[]', N'{}'));
PRINT CONCAT('ProductVendorAmounts: updated ', @@ROWCOUNT, ' row(s)');

UPDATE p
SET p.ProductOwnerAmounts = inv.ProductOwnerAmounts
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE (p.ProductOwnerAmounts IS NULL OR LTRIM(RTRIM(p.ProductOwnerAmounts)) IN (N'', N'[]', N'{}'))
  AND (inv.ProductOwnerAmounts IS NOT NULL AND LTRIM(RTRIM(inv.ProductOwnerAmounts)) NOT IN (N'', N'[]', N'{}'));
PRINT CONCAT('ProductOwnerAmounts: updated ', @@ROWCOUNT, ' row(s)');


-- -----------------------------------------------------------------------------
-- POST-STATE — Expect zero rows returned here once the updates land.
-- -----------------------------------------------------------------------------
SELECT 'Remaining drift' AS Label,
       COUNT(*)          AS RemainingDriftedPayments
FROM oe.Payments p
INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
WHERE
    (ISNULL(p.Commission, 0)          = 0 AND ISNULL(inv.Commission, 0)          <> 0)
 OR (ISNULL(p.NetRate, 0)             = 0 AND ISNULL(inv.NetRate, 0)             <> 0)
 OR (ISNULL(p.OverrideRate, 0)        = 0 AND ISNULL(inv.OverrideRate, 0)        <> 0)
 OR (ISNULL(p.SystemFees, 0)          = 0 AND ISNULL(inv.SystemFees, 0)          <> 0)
 OR (ISNULL(p.ProcessingFeeAmount, 0) = 0 AND ISNULL(inv.ProcessingFeeAmount, 0) <> 0)
 OR (ISNULL(p.SetupFee, 0)            = 0 AND ISNULL(inv.SetupFee, 0)            <> 0)
 OR ((p.ProductCommissions   IS NULL OR LTRIM(RTRIM(p.ProductCommissions))   IN (N'', N'[]', N'{}')) AND (inv.ProductCommissions   IS NOT NULL AND LTRIM(RTRIM(inv.ProductCommissions))   NOT IN (N'', N'[]', N'{}')))
 OR ((p.ProductVendorAmounts IS NULL OR LTRIM(RTRIM(p.ProductVendorAmounts)) IN (N'', N'[]', N'{}')) AND (inv.ProductVendorAmounts IS NOT NULL AND LTRIM(RTRIM(inv.ProductVendorAmounts)) NOT IN (N'', N'[]', N'{}')))
 OR ((p.ProductOwnerAmounts  IS NULL OR LTRIM(RTRIM(p.ProductOwnerAmounts))  IN (N'', N'[]', N'{}')) AND (inv.ProductOwnerAmounts  IS NOT NULL AND LTRIM(RTRIM(inv.ProductOwnerAmounts))  NOT IN (N'', N'[]', N'{}')));


-- -----------------------------------------------------------------------------
-- Dry run by default. Switch to COMMIT TRANSACTION when the preview looks right.
-- -----------------------------------------------------------------------------
ROLLBACK TRANSACTION;
-- COMMIT TRANSACTION;
