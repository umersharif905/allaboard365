/*
  Scott Boatman (SWAH HT0029) — keep 6000 ES @ $250; term duplicate 6000 EF row.

  Align feed: 11321 AH6000ES @ $250. Invoice was picking AH6000EF @ $315 (duplicate row).

  *** DATABASE: ShareWELLPartners on swp-sql-srvr (NOT OpenEnroll) ***

  Preview:
    ./ai_scripts/db-execute-sharewell.sh sql-changes/2026-06-06-sharewell-align-boatman-6000-es.sql

  Apply: set @DryRun = 0 and re-run.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
DECLARE @MemberId NVARCHAR(50) = N'SWAH HT0029';
DECLARE @EfMpId UNIQUEIDENTIFIER = N'944C546D-F473-469D-851B-154B4115BCCC';
DECLARE @TermDate DATE = '2025-01-01';

PRINT CONCAT(N'@DryRun = ', @DryRun, N' (1=preview, 0=apply)');
PRINT '';

PRINT '=== BEFORE: SWAH HT0029 products ===';
SELECT
    m.member_id,
    m.last_name,
    mp.id AS member_product_id,
    p.product_id AS product_code,
    pb.benefit_id,
    pb.ua,
    pb.household_size,
    mp.partner_price,
    CONVERT(VARCHAR(10), mp.effective_date, 23) AS effective_date,
    CONVERT(VARCHAR(10), mp.termination_date, 23) AS termination_date
FROM dbo.members m
INNER JOIN dbo.member_products mp ON mp.member_id = m.id
INNER JOIN dbo.products p ON p.id = mp.product_id
INNER JOIN dbo.product_benefits pb ON pb.id = mp.benefit_id
WHERE m.member_id = @MemberId
ORDER BY pb.benefit_id;

IF @DryRun = 1
BEGIN
    PRINT '';
    PRINT 'DRY RUN — set @DryRun = 0 to term EF duplicate (944C546D...).';
    RETURN;
END

UPDATE dbo.member_products
SET termination_date = @TermDate
WHERE id = @EfMpId;

PRINT CONCAT('Updated rows: ', @@ROWCOUNT);
