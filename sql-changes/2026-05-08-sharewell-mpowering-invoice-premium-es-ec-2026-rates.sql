/*
  ShareWELLPartners (swp-sql-srvr) — partner_invoice_pricing

  Align MPowering Benefits ES / EC premiums with Jan 2026 ESSENTIAL flyer:
    UA 1500: ES / EC → 383
    UA 3000: ES / EC → 288
    UA 6000: ES / EC → 223

  (EE and EF rows were already correct; unchanged here.)

  Run with: ./ai_scripts/db-execute-sharewell.sh sql-changes/2026-05-08-sharewell-mpowering-invoice-premium-es-ec-2026-rates.sql
*/

SET NOCOUNT ON;

DECLARE @partner_id UNIQUEIDENTIFIER = (
  SELECT TOP 1 id
  FROM dbo.partners
  WHERE LTRIM(RTRIM(partner_name)) = N'MPowering Benefits'
);

IF @partner_id IS NULL
BEGIN
  RAISERROR('Partner ''MPowering Benefits'' not found in dbo.partners.', 16, 1);
  RETURN;
END;

-- Rows that will change (preview)
SELECT ua, tier, premium AS premium_before,
       CASE ua
         WHEN 1500 THEN 383
         WHEN 3000 THEN 288
         WHEN 6000 THEN 223
       END AS premium_after
FROM dbo.partner_invoice_pricing
WHERE partner_id = @partner_id
  AND tier IN (N'ES', N'EC')
  AND ua IN (1500, 3000, 6000);

UPDATE dbo.partner_invoice_pricing
SET premium = CASE ua
                WHEN 1500 THEN 383
                WHEN 3000 THEN 288
                WHEN 6000 THEN 223
              END
WHERE partner_id = @partner_id
  AND tier IN (N'ES', N'EC')
  AND ua IN (1500, 3000, 6000);

DECLARE @upd INT = @@ROWCOUNT;
PRINT CONCAT(N'partner_invoice_pricing ES/EC rows updated: ', @upd, N' (expected 6)');

SELECT ua, tier, premium, commission, tobacco_surcharge, effective_from, effective_to
FROM dbo.partner_invoice_pricing
WHERE partner_id = @partner_id
  AND ua IN (1500, 3000, 6000)
ORDER BY ua, tier;
