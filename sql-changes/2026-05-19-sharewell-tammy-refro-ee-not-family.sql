/*
  Tammy Refro (member_id SWFIR9016) — billed as Family (EF/FM) but should be Member Only (EE).

  Current state (ShareWELLPartners):
    - Align Health SHA primary: two active member_products (EE + EF), same eff 2025-10-01
    - Align Health primary: member row only, no member_products
    - No spouse/child rows in members

  Actions:
    1. Terminate erroneous EF (family) coverage on Align Health SHA
    2. Keep EE coverage on Align Health SHA
    3. Add EE coverage on Align Health if missing (for Align Health partner invoicing)

  Run:
    ./ai_scripts/db-execute-sharewell.sh sql-changes/2026-05-19-sharewell-tammy-refro-ee-not-family.sql
*/

SET NOCOUNT ON;

DECLARE @member_code NVARCHAR(50) = N'SWFIR9016';
DECLARE @ef_mp_id UNIQUEIDENTIFIER = N'E3B89EB1-B582-4681-AD5D-7BF92F60E561';
DECLARE @ee_mp_id UNIQUEIDENTIFIER = N'04FD3B9F-1858-4753-8CA3-A561D70533CF';
DECLARE @align_member_uuid UNIQUEIDENTIFIER = N'0ECEB5A7-7FE5-4AE6-9AD2-CCDE4E718669';
DECLARE @product_uuid UNIQUEIDENTIFIER = N'74BC7ADE-2261-4F1B-A3A0-CE6F5A1CB610';
DECLARE @benefit_ee_uuid UNIQUEIDENTIFIER = N'2476AE34-9C93-4D0A-90B7-8FBC8C8F71F5';
DECLARE @eff_date DATE = '2025-10-01';
DECLARE @ef_term_date DATE = '2025-10-01';

PRINT '=== BEFORE ===';
SELECT
    m.member_id,
    m.first_name,
    m.last_name,
    m.relationship,
    a.account_name,
    mp.id AS member_product_id,
    pb.household_size,
    pb.benefit_id,
    CONVERT(VARCHAR(10), mp.effective_date, 23) AS effective_date,
    CONVERT(VARCHAR(10), mp.termination_date, 23) AS termination_date,
    mp.partner_price
FROM members m
JOIN accounts a ON a.id = m.account_id
LEFT JOIN member_products mp ON mp.member_id = m.id
LEFT JOIN product_benefits pb ON pb.id = mp.benefit_id
WHERE m.member_id = @member_code
ORDER BY a.account_name, pb.household_size;

-- 1) End family (EF) slice so invoice logic only sees EE
UPDATE dbo.member_products
SET termination_date = @ef_term_date
WHERE id = @ef_mp_id;

PRINT CONCAT(N'EF member_products terminated: ', @@ROWCOUNT, N' row(s) (expected 1)');

-- 2) Align Health primary: ensure EE product exists (mirror SHA EE)
IF NOT EXISTS (
    SELECT 1
    FROM dbo.member_products mp
    WHERE mp.member_id = @align_member_uuid
      AND mp.benefit_id = @benefit_ee_uuid
      AND mp.effective_date = @eff_date
)
BEGIN
    INSERT INTO dbo.member_products (
        id, member_id, member_id_key, product_id, benefit_id,
        effective_date, termination_date, partner_price, tobacco, created_dt
    )
    SELECT
        NEWID(),
        @align_member_uuid,
        @align_member_uuid,
        @product_uuid,
        @benefit_ee_uuid,
        @eff_date,
        NULL,
        mp.partner_price,
        mp.tobacco,
        GETUTCDATE()
    FROM dbo.member_products mp
    WHERE mp.id = @ee_mp_id;

    PRINT CONCAT(N'Align Health EE member_products inserted: ', @@ROWCOUNT, N' row(s) (expected 1)');
END
ELSE
BEGIN
    PRINT N'Align Health EE member_products already exists — skipped insert.';
END;

PRINT '=== AFTER ===';
SELECT
    m.member_id,
    m.first_name,
    m.last_name,
    m.relationship,
    a.account_name,
    mp.id AS member_product_id,
    pb.household_size,
    pb.benefit_id,
    CONVERT(VARCHAR(10), mp.effective_date, 23) AS effective_date,
    CONVERT(VARCHAR(10), mp.termination_date, 23) AS termination_date,
    mp.partner_price
FROM members m
JOIN accounts a ON a.id = m.account_id
LEFT JOIN member_products mp ON mp.member_id = m.id
LEFT JOIN product_benefits pb ON pb.id = mp.benefit_id
WHERE m.member_id = @member_code
ORDER BY a.account_name, pb.household_size;
