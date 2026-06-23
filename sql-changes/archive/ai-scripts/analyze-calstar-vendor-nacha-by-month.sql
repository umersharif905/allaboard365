/*
  Calstar vendor pay — what the OE DB records as owed/paid on NACHA batches

  Source of truth for "what we sent (or allocated) to the vendor on ACH":
    oe.NACHAPaymentDetails
      WHERE RecipientEntityType = N'Vendor'
        AND RecipientEntityId = <VendorId>

  Each row ties one PaymentId to a dollar Amount for that recipient when a NACHA was generated.
  Caveats:
    - Amounts are whatever NACHA generation calculated at that moment (not a separate accounting subledger).
    - Splitting "January vs February" depends on which date you use (see result grids below).

  Steps:
    1) Run section A — confirm Calstar VendorId(s). Set @VendorId from the row you expect.
    2) Run sections B–E as needed (comment others or use separate batches).

  Adjust year/month filters if you need 2025 or a different range.
*/

SET NOCOUNT ON;

-- ========== A) Find Calstar vendor row(s) ==========
SELECT v.VendorId, v.VendorName, v.Status
FROM oe.Vendors v
WHERE v.VendorName LIKE N'%Calstar%'
   OR v.VendorName LIKE N'%Cal Star%'
ORDER BY v.VendorName;

/*
  Example from internal docs (verify in your DB — may be account/product, not oe.Vendors):
  Sharewell notes mention account id 91F3F50E-32AF-41BF-BFEA-126044D20B92 for Calstar integration.
  Always use VendorId from oe.Vendors for NACHAPaymentDetails.RecipientEntityId when RecipientEntityType = 'Vendor'.
*/

DECLARE @VendorId UNIQUEIDENTIFIER = NULL; -- paste Guid from section A, e.g. 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'

IF @VendorId IS NULL
BEGIN
    RAISERROR(N'Set @VendorId from section A results, then re-run sections B–E.', 16, 1);
    RETURN;
END;

-- ========== B) Total vendor ACH lines by MONTH OF PAYMENT DATE (premium / collection date) ==========
-- Answers: "NACHA detail rows whose underlying Payment.PaymentDate fell in Jan vs Feb"
SELECT
    YEAR(p.PaymentDate)  AS PayYear,
    MONTH(p.PaymentDate) AS PayMonth,
    FORMAT(p.PaymentDate, N'yyyy-MM') AS PaymentMonthLabel,
    CAST(SUM(npd.Amount) AS DECIMAL(18, 2)) AS SumNachaVendorAmount,
    COUNT_BIG(*) AS DetailRowCount,
    COUNT(DISTINCT npd.NACHAId) AS DistinctNachaBatches,
    COUNT(DISTINCT npd.PaymentId) AS DistinctPayments
FROM oe.NACHAPaymentDetails npd
INNER JOIN oe.Payments p ON p.PaymentId = npd.PaymentId
WHERE npd.RecipientEntityType = N'Vendor'
  AND npd.RecipientEntityId = @VendorId
  AND p.PaymentDate >= '2026-01-01'
  AND p.PaymentDate < '2026-03-01'
GROUP BY YEAR(p.PaymentDate), MONTH(p.PaymentDate), FORMAT(p.PaymentDate, N'yyyy-MM')
ORDER BY PayYear, PayMonth;

-- ========== C) Same vendor totals by NACHA PAID-THROUGH window (StartDate month) ==========
-- Answers: "Batches labeled Feb 1–Feb 28" style (period start falls in Jan vs Feb)
SELECT
    YEAR(ng.StartDate) AS PeriodStartYear,
    MONTH(ng.StartDate) AS PeriodStartMonth,
    FORMAT(ng.StartDate, N'yyyy-MM') AS PaidThroughStartMonth,
    CAST(MIN(ng.StartDate) AS date) AS ExampleStartDate,
    CAST(MAX(ng.EndDate) AS date) AS ExampleEndDate,
    CAST(SUM(npd.Amount) AS DECIMAL(18, 2)) AS SumNachaVendorAmount,
    COUNT_BIG(*) AS DetailRowCount,
    COUNT(DISTINCT npd.NACHAId) AS DistinctNachaBatches
FROM oe.NACHAPaymentDetails npd
INNER JOIN oe.NACHAGenerations ng ON ng.NACHAId = npd.NACHAId
WHERE npd.RecipientEntityType = N'Vendor'
  AND npd.RecipientEntityId = @VendorId
  AND ng.StartDate >= '2026-01-01'
  AND ng.StartDate < '2026-03-01'
GROUP BY YEAR(ng.StartDate), MONTH(ng.StartDate), FORMAT(ng.StartDate, N'yyyy-MM')
ORDER BY PeriodStartYear, PeriodStartMonth;

-- ========== D) Drill-down: each NACHA batch for this vendor (see dates + total) ==========
SELECT
    ng.NACHAId,
    CAST(ng.StartDate AS date) AS NachaPaidThroughStart,
    CAST(ng.EndDate AS date) AS NachaPaidThroughEnd,
    CAST(ng.SentDate AS date) AS NachaSentDate,
    CAST(ng.GeneratedDate AS date) AS NachaGeneratedDate,
    CAST(SUM(npd.Amount) AS DECIMAL(18, 2)) AS VendorTotalThisBatch,
    COUNT_BIG(*) AS Lines
FROM oe.NACHAPaymentDetails npd
INNER JOIN oe.NACHAGenerations ng ON ng.NACHAId = npd.NACHAId
WHERE npd.RecipientEntityType = N'Vendor'
  AND npd.RecipientEntityId = @VendorId
  AND (
        ng.StartDate >= '2026-01-01' AND ng.StartDate < '2026-03-01'
        OR EXISTS (
            SELECT 1
            FROM oe.Payments px
            WHERE px.PaymentId = npd.PaymentId
              AND px.PaymentDate >= '2026-01-01'
              AND px.PaymentDate < '2026-03-01'
        )
  )
GROUP BY ng.NACHAId, ng.StartDate, ng.EndDate, ng.SentDate, ng.GeneratedDate
ORDER BY NachaSentDate DESC, NachaGeneratedDate DESC;

-- ========== E) Optional — compare one batch: sum of NACHA vendor lines vs sum of Payment NetRate on linked payments ==========
/*
DECLARE @NachaId UNIQUEIDENTIFIER = NULL; -- set to inspect one batch
IF @NachaId IS NOT NULL
SELECT
    ( SELECT CAST(SUM(npd.Amount) AS DECIMAL(18,2))
      FROM oe.NACHAPaymentDetails npd
      WHERE npd.NACHAId = @NachaId AND npd.RecipientEntityType = N'Vendor' AND npd.RecipientEntityId = @VendorId
    ) AS NachaVendorDetailSum,
    ( SELECT CAST(SUM(p.NetRate) AS DECIMAL(18,2))
      FROM oe.NACHAPaymentDetails npd
      INNER JOIN oe.Payments p ON p.PaymentId = npd.PaymentId
      WHERE npd.NACHAId = @NachaId AND npd.RecipientEntityType = N'Vendor' AND npd.RecipientEntityId = @VendorId
    ) AS SumPaymentNetRateOnSameLines;
*/
