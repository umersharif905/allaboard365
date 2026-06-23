/*
  Align Health — fix six members on partner invoices (Steve 2026-05-26).

  Scope: ONLY these member_id values (Align Health primary):
    SWAHFIR0141  Ronald Moaton   — 4/30 term; orphan Nov row still active
    SWAH HT0041  Jett Crass      — termed 2/28; duplicate 2026-01-01 row from SFTP
    SWAHAHP0011  Tye Lommasson   — termed 12/2024 (never in DB)
    SWAHAHP0094  Timothy Dugan   — keep 6000 EF @ 385; term addon 1500 rows
    SWAHCBS0124  Nicole Twigger  — keep 6000 EE @ 125; term addon 1500 rows
    SWAHCLO0003  Olivia Danielson — keep 3000 EF; term addon 1500 rows

  Does NOT touch other members. Updates only listed member_products.id values.

  Optional (OFF by default): @UpdateAlign3000EfPremium = 1
    Sets Align partner_invoice_pricing 3000/EF premium 455 -> 575 for ALL Align
    3000 EF invoices, not Olivia only. Enable only if billing confirms.

  Run preview (default):
    ./ai_scripts/db-execute-sharewell.sh sql-changes/2026-05-26-sharewell-align-invoice-six-members-fix.sql

  Apply changes: set @DryRun = 0 below, re-run same command.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  /* 1 = preview only, 0 = apply */
DECLARE @UpdateAlign3000EfPremium BIT = 0;  /* optional global rate card; see header */

DECLARE @AlignPartnerId UNIQUEIDENTIFIER = N'9C8CE3A0-8B88-4072-95C4-BD71E6C5AA7E';

/* Explicit member_products to terminate (verified 2026-05-26) */
DECLARE @Targets TABLE (
    mp_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    member_id NVARCHAR(50) NOT NULL,
    label NVARCHAR(120) NOT NULL,
    new_termination_date DATE NOT NULL
);

INSERT INTO @Targets (mp_id, member_id, label, new_termination_date) VALUES
    /* Jett Crass — SFTP duplicate row (eff 2026-01-01); keep termed row 76327BC8 unchanged */
    (N'4D3C7EAF-ED7B-4AA3-AAAB-709B717B4A92', N'SWAH HT0041', N'Jett: term duplicate 2026-01-01 row', '2026-02-28'),

    /* Tye Lommasson — addon rows only; no main 11321 product in DB */
    (N'779A4257-288E-47AA-91B3-49D5F1FE3D98', N'SWAHAHP0011', N'Tye: term addon 46520', '2024-12-31'),
    (N'B9E64E89-006F-447A-8ECD-0FCA332A949D', N'SWAHAHP0011', N'Tye: term addon 46521', '2024-12-31'),

    /* Timothy Dugan — term 1500 addon rows; KEEP 8BAB124E (6000 EF / 385) */
    (N'BEE972E0-7642-4590-AE21-CADF0D218BE3', N'SWAHAHP0094', N'Dugan: term addon 46521', '2026-01-01'),
    (N'F8C54172-4E15-4021-BE02-4B092BF285AB', N'SWAHAHP0094', N'Dugan: term addon 46520', '2026-01-01'),

    /* Nicole Twigger — KEEP 8576EEC8 (6000 EE / 125) */
    (N'CD4DD8B7-0E30-4C4A-9E04-DCE86784E4FB', N'SWAHCBS0124', N'Twigger: term addon 46520', '2025-11-01'),
    (N'B7B2B9CF-04EA-476C-A1C0-8D47DD5B9035', N'SWAHCBS0124', N'Twigger: term addon 46521', '2025-11-01'),

    /* Olivia Danielson — KEEP 7B0404EC (3000 EF); EBAC6896 already termed 2026-01-01 */
    (N'2F0B7437-66FF-49BA-A8EB-585ACCB6A1D9', N'SWAHCLO0003', N'Danielson: term addon 1500 Family', '2025-01-01'),

    /* Ronald Moaton — KEEP 301770E7 (already term 2026-04-30); term orphan rows */
    (N'AED9AF25-CEFC-4467-85D1-D3919328071D', N'SWAHFIR0141', N'Moaton: term orphan Nov 2025 ES row', '2026-04-30'),
    (N'BDA4AD4D-2E4B-4A5C-AB68-05EA8B507FA0', N'SWAHFIR0141', N'Moaton: term orphan EF row', '2026-04-30');

PRINT '=== CONFIG ===';
PRINT CONCAT(N'@DryRun = ', @DryRun, N' (1=preview, 0=apply)');
PRINT CONCAT(N'@UpdateAlign3000EfPremium = ', @UpdateAlign3000EfPremium);
PRINT '';

PRINT '=== BEFORE (six members only) ===';
SELECT
    m.member_id,
    m.first_name,
    m.last_name,
    mp.id AS member_product_id,
    p.product_id AS product_code,
    pb.benefit_id,
    pb.household_size,
    pb.ua,
    CONVERT(VARCHAR(10), mp.effective_date, 23) AS effective_date,
    CONVERT(VARCHAR(10), mp.termination_date, 23) AS termination_date,
    mp.partner_price
FROM dbo.members m
INNER JOIN dbo.accounts a ON a.id = m.account_id
INNER JOIN dbo.partners pr ON pr.id = a.partner_id
INNER JOIN dbo.member_products mp ON mp.member_id = m.id
INNER JOIN dbo.product_benefits pb ON pb.id = mp.benefit_id
INNER JOIN dbo.products p ON p.id = mp.product_id
WHERE m.member_id IN (
    N'SWAHFIR0141', N'SWAH HT0041', N'SWAHAHP0011',
    N'SWAHAHP0094', N'SWAHCBS0124', N'SWAHCLO0003'
)
AND pr.partner_name = N'Align Health'
ORDER BY m.member_id, mp.effective_date DESC, pb.ua DESC;

PRINT '';
PRINT '=== DRY-RUN: rows that WOULD be updated ===';
SELECT
    t.member_id,
    t.label,
    t.mp_id,
    t.new_termination_date,
    mp.effective_date AS current_effective_date,
    mp.termination_date AS current_termination_date,
    p.product_id AS product_code,
    pb.benefit_id,
    pb.ua
FROM @Targets t
INNER JOIN dbo.member_products mp ON mp.id = t.mp_id
INNER JOIN dbo.members m ON m.id = mp.member_id
INNER JOIN dbo.product_benefits pb ON pb.id = mp.benefit_id
INNER JOIN dbo.products p ON p.id = mp.product_id
WHERE m.member_id = t.member_id
  AND (
        mp.termination_date IS NULL
     OR CONVERT(DATE, mp.termination_date) <> t.new_termination_date
  );

PRINT '';
PRINT '=== DRY-RUN: safety — targets must belong to scoped member_ids ===';
SELECT t.mp_id, t.member_id, m.member_id AS actual_member_id
FROM @Targets t
LEFT JOIN dbo.member_products mp ON mp.id = t.mp_id
LEFT JOIN dbo.members m ON m.id = mp.member_id
WHERE m.member_id IS NULL OR m.member_id <> t.member_id;
IF @@ROWCOUNT > 0
BEGIN
    RAISERROR('Safety check failed: member_products.id does not match expected member_id.', 16, 1);
    RETURN;
END
PRINT N'Safety check passed: all mp_id rows match expected member_id.';

PRINT '';
PRINT '=== DRY-RUN: invoice pick simulation (Align logic: newest eff, active on as-of) ===';
DECLARE @AsOf DATE = '2026-05-01';
;WITH active AS (
    SELECT
        m.member_id,
        m.first_name,
        m.last_name,
        mp.id AS mp_id,
        pb.household_size,
        pb.ua,
        pb.benefit_id,
        mp.partner_price,
        mp.effective_date,
        mp.termination_date,
        ROW_NUMBER() OVER (
            PARTITION BY m.member_id
            ORDER BY mp.effective_date DESC, mp.created_dt DESC
        ) AS rn
    FROM dbo.members m
    INNER JOIN dbo.accounts ac ON ac.id = m.account_id
    INNER JOIN dbo.partners pr ON pr.id = ac.partner_id
    INNER JOIN dbo.member_products mp ON mp.member_id = m.id
    INNER JOIN dbo.product_benefits pb ON pb.id = mp.benefit_id
    WHERE m.member_id IN (
        N'SWAHFIR0141', N'SWAH HT0041', N'SWAHAHP0011',
        N'SWAHAHP0094', N'SWAHCBS0124', N'SWAHCLO0003'
    )
    AND pr.partner_name = N'Align Health'
    AND m.relationship = N'P'
    AND mp.effective_date <= @AsOf
    AND (mp.termination_date IS NULL OR mp.termination_date > @AsOf)
)
SELECT
    @AsOf AS as_of_date,
    member_id,
    first_name,
    last_name,
    household_size,
    ua,
    benefit_id,
    partner_price,
    CONVERT(VARCHAR(10), effective_date, 23) AS effective_date,
    CONVERT(VARCHAR(10), termination_date, 23) AS termination_date,
    mp_id AS picked_member_product_id
FROM active
WHERE rn = 1
ORDER BY last_name;

SET @AsOf = '2026-04-01';
;WITH active AS (
    SELECT
        m.member_id,
        m.first_name,
        m.last_name,
        mp.id AS mp_id,
        pb.household_size,
        pb.ua,
        pb.benefit_id,
        mp.partner_price,
        mp.effective_date,
        mp.termination_date,
        ROW_NUMBER() OVER (
            PARTITION BY m.member_id
            ORDER BY mp.effective_date DESC, mp.created_dt DESC
        ) AS rn
    FROM dbo.members m
    INNER JOIN dbo.accounts ac ON ac.id = m.account_id
    INNER JOIN dbo.partners pr ON pr.id = ac.partner_id
    INNER JOIN dbo.member_products mp ON mp.member_id = m.id
    INNER JOIN dbo.product_benefits pb ON pb.id = mp.benefit_id
    WHERE m.member_id IN (
        N'SWAHFIR0141', N'SWAH HT0041', N'SWAHAHP0011',
        N'SWAHAHP0094', N'SWAHCBS0124', N'SWAHCLO0003'
    )
    AND pr.partner_name = N'Align Health'
    AND m.relationship = N'P'
    AND mp.effective_date <= @AsOf
    AND (mp.termination_date IS NULL OR mp.termination_date > @AsOf)
)
SELECT
    @AsOf AS as_of_date,
    member_id,
    first_name,
    last_name,
    household_size,
    ua,
    benefit_id,
    partner_price,
    CONVERT(VARCHAR(10), effective_date, 23) AS effective_date,
    CONVERT(VARCHAR(10), termination_date, 23) AS termination_date,
    mp_id AS picked_member_product_id
FROM active
WHERE rn = 1
ORDER BY last_name;

IF @DryRun = 1
BEGIN
    PRINT '';
    PRINT '*** DRY RUN — no data changed. Set @DryRun = 0 and re-run to apply. ***';
    RETURN;
END

BEGIN TRANSACTION;

UPDATE mp
SET mp.termination_date = t.new_termination_date
FROM dbo.member_products mp
INNER JOIN @Targets t ON t.mp_id = mp.id
INNER JOIN dbo.members m ON m.id = mp.member_id
WHERE m.member_id = t.member_id
  AND (
        mp.termination_date IS NULL
     OR CONVERT(DATE, mp.termination_date) <> t.new_termination_date
  );

DECLARE @Updated INT = @@ROWCOUNT;
PRINT CONCAT(N'member_products terminated/updated: ', @Updated, N' row(s) (expected <= 10)');

IF @Updated > 10
BEGIN
    ROLLBACK TRANSACTION;
    RAISERROR('Abort: updated more rows than expected (>10). Rolled back.', 16, 1);
    RETURN;
END

IF @UpdateAlign3000EfPremium = 1
BEGIN
    UPDATE dbo.partner_invoice_pricing
    SET premium = 575
    WHERE partner_id = @AlignPartnerId
      AND ua = 3000
      AND tier = N'EF'
      AND premium = 455;

    PRINT CONCAT(N'partner_invoice_pricing 3000/EF premium -> 575: ', @@ROWCOUNT, N' row(s) (expected 1)');
END

COMMIT TRANSACTION;

PRINT '';
PRINT '=== AFTER (six members only) ===';
SELECT
    m.member_id,
    m.first_name,
    m.last_name,
    mp.id AS member_product_id,
    p.product_id AS product_code,
    pb.benefit_id,
    pb.household_size,
    pb.ua,
    CONVERT(VARCHAR(10), mp.effective_date, 23) AS effective_date,
    CONVERT(VARCHAR(10), mp.termination_date, 23) AS termination_date,
    mp.partner_price
FROM dbo.members m
INNER JOIN dbo.accounts a ON a.id = m.account_id
INNER JOIN dbo.partners pr ON pr.id = a.partner_id
INNER JOIN dbo.member_products mp ON mp.member_id = m.id
INNER JOIN dbo.product_benefits pb ON pb.id = mp.benefit_id
INNER JOIN dbo.products p ON p.id = mp.product_id
WHERE m.member_id IN (
    N'SWAHFIR0141', N'SWAH HT0041', N'SWAHAHP0011',
    N'SWAHAHP0094', N'SWAHCBS0124', N'SWAHCLO0003'
)
AND pr.partner_name = N'Align Health'
ORDER BY m.member_id, mp.effective_date DESC, pb.ua DESC;

PRINT '';
PRINT 'Done. Regenerate invoices:';
PRINT '  cd sharewell-csv-processor && ./scripts/generateAll.sh April && ./scripts/generateAll.sh May';
