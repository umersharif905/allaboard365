/*
  Align Health — terminate Jett Crass and Tye Lommasson (off Thru-5-1 invoice).

  *** DATABASE: ShareWELLPartners on swp-sql-srvr (NOT OpenEnroll) ***

  Run:
    ./ai_scripts/db-execute-sharewell.sh sql-changes/2026-05-30-sharewell-align-term-jett-tye.sql

  Jett (SWAH HT0041): all primary rows active on 2026-05-01 -> term 2026-02-28
  Tye (SWAHAHP0011): all primary rows active on 2026-05-01 -> term 2024-12-31
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 0;  /* 1 = preview, 0 = apply */
DECLARE @AsOf DATE = '2026-05-01';

DECLARE @Targets TABLE (
    mp_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    member_id NVARCHAR(50) NOT NULL,
    label NVARCHAR(120) NOT NULL,
    new_termination_date DATE NOT NULL
);

/* Known rows (Steve 2026-05-26) */
INSERT INTO @Targets (mp_id, member_id, label, new_termination_date) VALUES
    (N'4D3C7EAF-ED7B-4AA3-AAAB-709B717B4A92', N'SWAH HT0041', N'Jett: duplicate 2026-01-01 row', '2026-02-28'),
    (N'779A4257-288E-47AA-91B3-49D5F1FE3D98', N'SWAHAHP0011', N'Tye: addon 46520', '2024-12-31'),
    (N'B9E64E89-006F-447A-8ECD-0FCA332A949D', N'SWAHAHP0011', N'Tye: addon 46521', '2024-12-31');

/* Catch-all: any other primary product still billable on @AsOf */
INSERT INTO @Targets (mp_id, member_id, label, new_termination_date)
SELECT
    mp.id,
    m.member_id,
    CONCAT(N'Catch-all: ', p.product_id, N' eff ', CONVERT(VARCHAR(10), mp.effective_date, 23)),
    CASE
        WHEN m.member_id = N'SWAH HT0041' THEN CAST('2026-02-28' AS DATE)
        WHEN m.member_id = N'SWAHAHP0011' THEN CAST('2024-12-31' AS DATE)
    END
FROM dbo.members m
INNER JOIN dbo.member_products mp ON mp.member_id = m.id
INNER JOIN dbo.products p ON p.id = mp.product_id
WHERE m.member_id IN (N'SWAH HT0041', N'SWAHAHP0011')
  AND m.relationship = N'P'
  AND mp.effective_date <= @AsOf
  AND (mp.termination_date IS NULL OR mp.termination_date > @AsOf)
  AND NOT EXISTS (SELECT 1 FROM @Targets t WHERE t.mp_id = mp.id);

PRINT CONCAT(N'@DryRun = ', @DryRun, N' (1=preview, 0=apply)');
PRINT '';

PRINT '=== BEFORE ===';
SELECT
    m.member_id,
    m.first_name,
    m.last_name,
    mp.id AS member_product_id,
    p.product_id AS product_code,
    pb.benefit_id,
    CONVERT(VARCHAR(10), mp.effective_date, 23) AS effective_date,
    CONVERT(VARCHAR(10), mp.termination_date, 23) AS termination_date
FROM dbo.members m
INNER JOIN dbo.member_products mp ON mp.member_id = m.id
INNER JOIN dbo.products p ON p.id = mp.product_id
LEFT JOIN dbo.product_benefits pb ON pb.id = mp.benefit_id
WHERE m.member_id IN (N'SWAH HT0041', N'SWAHAHP0011')
  AND m.relationship = N'P'
ORDER BY m.member_id, mp.effective_date DESC, p.product_id;

PRINT '';
PRINT '=== ROWS TO UPDATE ===';
SELECT
    t.member_id,
    t.label,
    t.mp_id,
    t.new_termination_date,
    mp.termination_date AS current_termination_date,
    p.product_id AS product_code
FROM @Targets t
INNER JOIN dbo.member_products mp ON mp.id = t.mp_id
INNER JOIN dbo.members m ON m.id = mp.member_id
INNER JOIN dbo.products p ON p.id = mp.product_id
WHERE m.member_id = t.member_id
  AND (
        mp.termination_date IS NULL
     OR CONVERT(DATE, mp.termination_date) <> t.new_termination_date
  );

IF EXISTS (
    SELECT 1
    FROM @Targets t
    LEFT JOIN dbo.member_products mp ON mp.id = t.mp_id
    LEFT JOIN dbo.members m ON m.id = mp.member_id
    WHERE mp.id IS NULL OR m.member_id IS NULL OR m.member_id <> t.member_id
)
BEGIN
    RAISERROR('Safety check failed: member_products.id does not match expected member_id.', 16, 1);
    RETURN;
END

PRINT '';
PRINT '=== INVOICE SIMULATION (active on 2026-05-01 after apply) ===';
;WITH projected AS (
    SELECT
        m.member_id,
        m.first_name,
        m.last_name,
        mp.id AS mp_id,
        mp.effective_date,
        COALESCE(tgt.new_termination_date, mp.termination_date) AS termination_date
    FROM dbo.members m
    INNER JOIN dbo.member_products mp ON mp.member_id = m.id
    LEFT JOIN @Targets tgt ON tgt.mp_id = mp.id
    WHERE m.member_id IN (N'SWAH HT0041', N'SWAHAHP0011')
      AND m.relationship = N'P'
),
active AS (
    SELECT *
    FROM projected
    WHERE effective_date <= @AsOf
      AND (termination_date IS NULL OR termination_date > @AsOf)
)
SELECT member_id, first_name, last_name,
       CONVERT(VARCHAR(10), effective_date, 23) AS effective_date,
       CONVERT(VARCHAR(10), termination_date, 23) AS termination_date,
       mp_id
FROM active
ORDER BY last_name;

IF NOT EXISTS (
    SELECT 1 FROM @Targets t
    INNER JOIN dbo.member_products mp ON mp.id = t.mp_id
    WHERE mp.termination_date IS NULL OR CONVERT(DATE, mp.termination_date) <> t.new_termination_date
)
BEGIN
    PRINT '';
    PRINT 'No rows need updating — already terminated.';
    RETURN;
END

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
IF @Updated > 10
BEGIN
    ROLLBACK TRANSACTION;
    RAISERROR('Abort: updated more rows than expected (>10). Rolled back.', 16, 1);
    RETURN;
END

PRINT CONCAT(N'Updated ', @Updated, N' row(s).');

COMMIT TRANSACTION;

PRINT '';
PRINT '=== AFTER ===';
SELECT
    m.member_id,
    m.first_name,
    m.last_name,
    mp.id AS member_product_id,
    p.product_id AS product_code,
    CONVERT(VARCHAR(10), mp.effective_date, 23) AS effective_date,
    CONVERT(VARCHAR(10), mp.termination_date, 23) AS termination_date
FROM dbo.members m
INNER JOIN dbo.member_products mp ON mp.member_id = m.id
INNER JOIN dbo.products p ON p.id = mp.product_id
WHERE m.member_id IN (N'SWAH HT0041', N'SWAHAHP0011')
  AND m.relationship = N'P'
ORDER BY m.member_id, mp.effective_date DESC, p.product_id;
