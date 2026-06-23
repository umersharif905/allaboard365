/*
  Align Health (AllAboard) — terminate Jett Crass and Tye Lommasson.
  Matches ShareWELL term dates from 2026-05-30-sharewell-align-term-jett-tye.sql.

  Jett (SWAH HT0041):  2026-02-28
  Tye (SWAHAHP0011):   2024-12-31

  Run preview (default):
    ./ai_scripts/db-execute.sh sql-changes/2026-06-11-align-term-jett-tye-allaboard.sql

  Apply: set @DryRun = 0 and re-run.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  /* 1 = preview, 0 = apply */
DECLARE @AsOf DATE = '2026-05-01';

DECLARE @AlignTenantId UNIQUEIDENTIFIER = N'7D5040ED-1105-4940-A352-FF85483B2C3C';
DECLARE @SharewellVendorId UNIQUEIDENTIFIER = N'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

DECLARE @Targets TABLE (
    HouseholdMemberID NVARCHAR(50) NOT NULL PRIMARY KEY,
    FirstName NVARCHAR(100) NOT NULL,
    LastName NVARCHAR(100) NOT NULL,
    NewTerminationDate DATE NOT NULL
);

INSERT INTO @Targets (HouseholdMemberID, FirstName, LastName, NewTerminationDate) VALUES
    (N'SWAH HT0041', N'Jett', N'Crass', '2026-02-28'),
    (N'SWAHAHP0011', N'Tye', N'Lommasson', '2024-12-31');

PRINT CONCAT(N'@DryRun = ', @DryRun, N' (1=preview, 0=apply)');
PRINT '';

PRINT '=== BEFORE: active ShareWELL vendor enrollments ===';
SELECT
    m.HouseholdMemberID,
    u.FirstName,
    u.LastName,
    e.EnrollmentId,
    e.Status,
    CONVERT(VARCHAR(10), e.EffectiveDate, 23) AS EffectiveDate,
    CONVERT(VARCHAR(10), e.TerminationDate, 23) AS TerminationDate,
    p.Name AS ProductName,
    pp.TierType,
    pp.ConfigValue1 AS UA,
    pp.NetRate
FROM oe.Members m
INNER JOIN oe.Users u ON u.UserId = m.UserId
INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
INNER JOIN oe.Products p ON p.ProductId = e.ProductId
LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
INNER JOIN @Targets t ON t.HouseholdMemberID = m.HouseholdMemberID
WHERE m.TenantId = @AlignTenantId
  AND p.VendorId = @SharewellVendorId
  AND e.Status = N'Active'
  AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) > @AsOf)
ORDER BY m.HouseholdMemberID, e.EffectiveDate DESC;

PRINT '';
PRINT '=== ROWS TO UPDATE ===';
SELECT
    m.HouseholdMemberID,
    u.FirstName,
    u.LastName,
    e.EnrollmentId,
    e.Status AS CurrentStatus,
    CONVERT(VARCHAR(10), e.EffectiveDate, 23) AS EffectiveDate,
    CONVERT(VARCHAR(10), e.TerminationDate, 23) AS CurrentTerminationDate,
    t.NewTerminationDate,
    p.Name AS ProductName,
    pp.NetRate
FROM oe.Members m
INNER JOIN oe.Users u ON u.UserId = m.UserId
INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
INNER JOIN oe.Products p ON p.ProductId = e.ProductId
LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
INNER JOIN @Targets t ON t.HouseholdMemberID = m.HouseholdMemberID
WHERE m.TenantId = @AlignTenantId
  AND p.VendorId = @SharewellVendorId
  AND e.Status = N'Active'
  AND (
        e.TerminationDate IS NULL
     OR CAST(e.TerminationDate AS DATE) <> t.NewTerminationDate
  )
ORDER BY m.HouseholdMemberID, e.EffectiveDate DESC;

PRINT '';
PRINT '=== INVOICE SIMULATION (billable on 2026-05-01 after apply) ===';
;WITH VendorProducts AS (
    SELECT p.ProductId
    FROM oe.Products p
    WHERE p.VendorId = @SharewellVendorId
      AND p.Status NOT IN (N'Deleted')
      AND ISNULL(p.IsBundle, 0) = 0
),
Projected AS (
    SELECT
        m.HouseholdMemberID,
        u.FirstName,
        u.LastName,
        e.EnrollmentId,
        e.EffectiveDate,
        CASE
            WHEN e.Status = N'Active'
                 AND (
                      e.TerminationDate IS NULL
                   OR CAST(e.TerminationDate AS DATE) <> t.NewTerminationDate
                 )
            THEN t.NewTerminationDate
            ELSE e.TerminationDate
        END AS TerminationDate,
        pp.NetRate
    FROM oe.Members m
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
    INNER JOIN VendorProducts vp ON vp.ProductId = e.ProductId
    INNER JOIN @Targets t ON t.HouseholdMemberID = m.HouseholdMemberID
    LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
    WHERE m.TenantId = @AlignTenantId
      AND e.Status = N'Active'
      AND ISNULL(e.IsPendingMigration, 0) = 0
),
Billable AS (
    SELECT *
    FROM Projected
    WHERE CAST(EffectiveDate AS DATE) <= @AsOf
      AND (TerminationDate IS NULL OR CAST(TerminationDate AS DATE) > @AsOf)
)
SELECT
    HouseholdMemberID,
    FirstName,
    LastName,
    CONVERT(VARCHAR(10), EffectiveDate, 23) AS EffectiveDate,
    CONVERT(VARCHAR(10), TerminationDate, 23) AS TerminationDate,
    NetRate
FROM Billable
ORDER BY LastName;

DECLARE @WouldUpdate INT = (
    SELECT COUNT(*)
    FROM oe.Members m
    INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
    INNER JOIN oe.Products p ON p.ProductId = e.ProductId
    INNER JOIN @Targets t ON t.HouseholdMemberID = m.HouseholdMemberID
    WHERE m.TenantId = @AlignTenantId
      AND p.VendorId = @SharewellVendorId
      AND e.Status = N'Active'
      AND (
            e.TerminationDate IS NULL
         OR CAST(e.TerminationDate AS DATE) <> t.NewTerminationDate
      )
);

IF @WouldUpdate = 0
BEGIN
    PRINT '';
    PRINT 'No rows need updating — already terminated with matching dates.';
    RETURN;
END

IF @WouldUpdate > 20
BEGIN
    RAISERROR('Abort: more than 20 enrollments matched — review scope.', 16, 1);
    RETURN;
END

IF @DryRun = 1
BEGIN
    PRINT '';
    PRINT CONCAT('*** DRY RUN — would update ', @WouldUpdate, N' enrollment(s). Set @DryRun = 0 to apply. ***');
    RETURN;
END

BEGIN TRY
    BEGIN TRANSACTION;

    UPDATE e
    SET
        e.TerminationDate = t.NewTerminationDate,
        e.Status = N'Inactive',
        e.ModifiedDate = SYSUTCDATETIME()
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON m.MemberId = e.MemberId
    INNER JOIN oe.Products p ON p.ProductId = e.ProductId
    INNER JOIN @Targets t ON t.HouseholdMemberID = m.HouseholdMemberID
    WHERE m.TenantId = @AlignTenantId
      AND p.VendorId = @SharewellVendorId
      AND e.Status = N'Active'
      AND (
            e.TerminationDate IS NULL
         OR CAST(e.TerminationDate AS DATE) <> t.NewTerminationDate
      );

    DECLARE @Updated INT = @@ROWCOUNT;

    IF @Updated > 20
    BEGIN
        ROLLBACK TRANSACTION;
        RAISERROR('Abort: updated more rows than expected (>20). Rolled back.', 16, 1);
        RETURN;
    END

    COMMIT TRANSACTION;
    PRINT CONCAT(N'Updated ', @Updated, N' enrollment(s).');
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS Error, ERROR_LINE() AS Line;
END CATCH;

PRINT '';
PRINT '=== AFTER ===';
SELECT
    m.HouseholdMemberID,
    u.FirstName,
    u.LastName,
    e.EnrollmentId,
    e.Status,
    CONVERT(VARCHAR(10), e.EffectiveDate, 23) AS EffectiveDate,
    CONVERT(VARCHAR(10), e.TerminationDate, 23) AS TerminationDate,
    p.Name AS ProductName,
    pp.NetRate
FROM oe.Members m
INNER JOIN oe.Users u ON u.UserId = m.UserId
INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
INNER JOIN oe.Products p ON p.ProductId = e.ProductId
LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
INNER JOIN @Targets t ON t.HouseholdMemberID = m.HouseholdMemberID
WHERE m.TenantId = @AlignTenantId
  AND p.VendorId = @SharewellVendorId
ORDER BY m.HouseholdMemberID, e.EffectiveDate DESC;
