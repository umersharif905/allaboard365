-- Compare ShareWELL/MightyWELL product pricing in our DB to invoice "Plan Price" (e.g. 385, 505).
-- Run with: ./ai_scripts/db-query.sh "$(cat ai_scripts/compare-sharewell-invoice-to-db-pricing.sql)"
--
-- Invoice example: Plan Price 385 (EF 3000), 505 (EF 1500). If these match NetRate = invoicing net only;
-- if they match (NetRate + OverrideRate + VendorCommission + SystemFees) = invoicing full premium.

SELECT
  pr.Name AS ProductName,
  pp.TierType,
  pp.Label,
  pp.ConfigValue1 AS UA_Config,
  pp.NetRate,
  pp.OverrideRate,
  pp.VendorCommission,
  pp.SystemFees,
  (ISNULL(pp.NetRate, 0) + ISNULL(pp.OverrideRate, 0) + ISNULL(pp.VendorCommission, 0) + ISNULL(pp.SystemFees, 0)) AS FullPremium,
  pp.MSRPRate
FROM oe.Products pr
JOIN oe.ProductPricing pp ON pp.ProductId = pr.ProductId
WHERE pr.Status = 'Active'
  AND pp.Status = 'Active'
  AND (
    pr.Name LIKE N'%Essential%Sharewell%'
    OR pr.Name LIKE N'%Essential (Sharewell)%'
    OR pr.Name LIKE N'%Essential(Sharewell)%'
    OR pr.Name LIKE N'%Summit%Essential%'
  )
ORDER BY pr.Name, pp.TierType, pp.ConfigValue1, pp.MinAge;
