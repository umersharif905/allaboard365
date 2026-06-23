/*
  Tammy Refro (SWFIR9016) — remove from Align Health list-bill; keep Align Health SHA only.

  Steve: on SHA invoice only; remove duplicate from Align Health invoice.

  *** DATABASE: ShareWELLPartners on swp-sql-srvr (NOT OpenEnroll) ***

  Terminates ONLY the Align Health member_products row (8594C0BB...).
  Does NOT touch Align Health SHA rows (04FD3B9F..., E3B89EB1...).

  Preview:
    ./ai_scripts/db-execute-sharewell.sh sql-changes/2026-06-05-sharewell-align-remove-tammy-refro-from-align.sql

  Apply: set @DryRun = 0 and re-run.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  /* 1 = preview, 0 = apply */

DECLARE @MemberId NVARCHAR(50) = N'SWFIR9016';
DECLARE @AlignPartnerName NVARCHAR(100) = N'Align Health';
/* Align Health list-bill row only (verified 2026-06-05) */
DECLARE @AlignMpId UNIQUEIDENTIFIER = N'8594C0BB-8921-4F3A-AE5C-92F2234A728B';
/* End Align enrollment at plan start — never bill on Align after SHA-only */
DECLARE @TerminationDate DATE = '2025-10-01';

PRINT CONCAT(N'@DryRun = ', @DryRun, N' (1=preview, 0=apply)');
PRINT '';

PRINT '=== BEFORE: all SWFIR9016 products ===';
SELECT
    m.member_id,
    m.first_name,
    m.last_name,
    pr.partner_name,
    mp.id AS member_product_id,
    p.product_id AS product_code,
    pb.benefit_id,
    pb.ua,
    pb.household_size,
    mp.partner_price,
    CONVERT(VARCHAR(10), mp.effective_date, 23) AS effective_date,
    CONVERT(VARCHAR(10), mp.termination_date, 23) AS termination_date
FROM dbo.members m
INNER JOIN dbo.accounts a ON a.id = m.account_id
INNER JOIN dbo.partners pr ON pr.id = a.partner_id
INNER JOIN dbo.member_products mp ON mp.member_id = m.id
INNER JOIN dbo.products p ON p.id = mp.product_id
INNER JOIN dbo.product_benefits pb ON pb.id = mp.benefit_id
WHERE m.member_id = @MemberId
ORDER BY pr.partner_name, mp.effective_date DESC;

PRINT '';
PRINT '=== ROW TO UPDATE (Align Health only) ===';
SELECT
    mp.id AS member_product_id,
    pr.partner_name,
    mp.effective_date,
    mp.termination_date AS current_termination,
    @TerminationDate AS new_termination
FROM dbo.member_products mp
INNER JOIN dbo.members m ON m.id = mp.member_id
INNER JOIN dbo.accounts a ON a.id = m.account_id
INNER JOIN dbo.partners pr ON pr.id = a.partner_id
WHERE mp.id = @AlignMpId
  AND m.member_id = @MemberId
  AND pr.partner_name = @AlignPartnerName;

IF @@ROWCOUNT = 0
BEGIN
    RAISERROR('Safety check failed: Align Health member_products row not found.', 16, 1);
    RETURN;
END

PRINT '';
PRINT '=== INVOICE SIMULATION (active on 2026-05-01) ===';
DECLARE @AsOf DATE = '2026-05-01';

SELECT
    pr.partner_name,
    m.member_id,
    m.first_name,
    m.last_name,
    pb.ua,
    pb.household_size,
    mp.partner_price,
    CONVERT(VARCHAR(10), mp.effective_date, 23) AS effective_date,
    CONVERT(VARCHAR(10), COALESCE(
        CASE WHEN mp.id = @AlignMpId THEN @TerminationDate END,
        mp.termination_date
    ), 23) AS termination_date
FROM dbo.members m
INNER JOIN dbo.accounts a ON a.id = m.account_id
INNER JOIN dbo.partners pr ON pr.id = a.partner_id
INNER JOIN dbo.member_products mp ON mp.member_id = m.id
INNER JOIN dbo.product_benefits pb ON pb.id = mp.benefit_id
WHERE m.member_id = @MemberId
  AND m.relationship = N'P'
  AND mp.effective_date <= @AsOf
  AND (
        COALESCE(CASE WHEN mp.id = @AlignMpId THEN @TerminationDate END, mp.termination_date) IS NULL
     OR COALESCE(CASE WHEN mp.id = @AlignMpId THEN @TerminationDate END, mp.termination_date) > @AsOf
  )
ORDER BY pr.partner_name;

IF @DryRun = 1
BEGIN
    PRINT '';
    PRINT 'Expected after apply: Tammy on Align Health SHA only (not Align Health).';
    PRINT '*** DRY RUN — no data changed. Set @DryRun = 0 and re-run to apply. ***';
    RETURN;
END

BEGIN TRANSACTION;

UPDATE mp
SET mp.termination_date = @TerminationDate
FROM dbo.member_products mp
INNER JOIN dbo.members m ON m.id = mp.member_id
INNER JOIN dbo.accounts a ON a.id = m.account_id
INNER JOIN dbo.partners pr ON pr.id = a.partner_id
WHERE mp.id = @AlignMpId
  AND m.member_id = @MemberId
  AND pr.partner_name = @AlignPartnerName
  AND (
        mp.termination_date IS NULL
     OR CONVERT(DATE, mp.termination_date) <> @TerminationDate
  );

IF @@ROWCOUNT <> 1
BEGIN
    ROLLBACK TRANSACTION;
    RAISERROR('Abort: expected exactly 1 row updated.', 16, 1);
    RETURN;
END

COMMIT TRANSACTION;

PRINT '';
PRINT CONCAT(N'Updated ', @@ROWCOUNT, N' row(s). Regenerate May Align invoice after apply.');

PRINT '';
PRINT '=== AFTER ===';
SELECT
    m.member_id,
    pr.partner_name,
    mp.id AS member_product_id,
    p.product_id AS product_code,
    CONVERT(VARCHAR(10), mp.effective_date, 23) AS effective_date,
    CONVERT(VARCHAR(10), mp.termination_date, 23) AS termination_date,
    mp.partner_price
FROM dbo.members m
INNER JOIN dbo.accounts a ON a.id = m.account_id
INNER JOIN dbo.partners pr ON pr.id = a.partner_id
INNER JOIN dbo.member_products mp ON mp.member_id = m.id
INNER JOIN dbo.products p ON p.id = mp.product_id
WHERE m.member_id = @MemberId
ORDER BY pr.partner_name;
