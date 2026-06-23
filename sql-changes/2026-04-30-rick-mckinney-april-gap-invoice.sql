-- Generate a missing-period invoice for Rick McKinney covering 4/1-4/24.
--
-- Background: Rick is enrolled effective 2026-03-25 on Essential (ShareWELL)
-- EE 5000 + bundled Lyric. The billing engine produced two existing invoices:
--   - 3/1-3/31  : INV-202604-1063 ($129.50, Paid)        -- calendar month, but he was only effective 3/25-3/31
--   - 4/25-4/30 : INV-202604-1163 ($129.50, Overdue)     -- anchored to enrollment day, leaves 4/1-4/24 uncovered
--
-- The gap 4/1-4/24 has no invoice -> NACHA never bills him for it and ShareWELL
-- isn't paid for that period. This script creates the missing invoice.
--
-- Amounts are prorated by days (24 / 30 of the monthly rate) so we don't
-- over-charge:
--   monthly $129.50 = $99 NetRate + $26 Commission + $3.50 SystemFees + $1 ProcessingFee
--   prorated 24/30  = $103.60 = $79.20 + $20.80 + $2.80 + $0.80
--
-- Status: Unpaid. The customer either pays this separately, has a credit applied,
-- or the system will treat it as a regular outstanding invoice on his account.
--
-- Member: 9C100BC0-C99E-4B22-A1A4-03A9F51CBD3D (Rick McKinney)
-- Household: F9FE2A1F-54B7-46A6-B4B0-0B591385DC0B
-- Tenant: AE8A82A9-632D-4655-AEDA-7CB563D3A8C6 (ShareWELL)
-- Product: F165AF93-8268-448D-9DD6-F02FB338EEAE (Essential ShareWELL EE 5000)

SET XACT_ABORT ON;
BEGIN TRY
BEGIN TRAN;

-- Idempotency guard: do not insert if an invoice already exists for this exact period.
IF EXISTS (
  SELECT 1 FROM oe.Invoices
  WHERE HouseholdId = 'F9FE2A1F-54B7-46A6-B4B0-0B591385DC0B'
    AND BillingPeriodStart = '2026-04-01'
    AND BillingPeriodEnd = '2026-04-24'
)
BEGIN
  PRINT 'Skipping: gap-fill invoice already exists for Rick McKinney 2026-04-01..2026-04-24.';
END
ELSE
BEGIN
  DECLARE @NewInvoiceId UNIQUEIDENTIFIER = NEWID();
  DECLARE @NextNum NVARCHAR(50);

  -- Compute next sequential InvoiceNumber for April 2026 (matches existing INV-202604-NNNN pattern).
  SELECT @NextNum = 'INV-202604-' + RIGHT('0000' + CAST(
    ISNULL(MAX(TRY_CAST(SUBSTRING(InvoiceNumber, 13, 10) AS INT)), 1000) + 1
    AS NVARCHAR(10)), 4)
  FROM oe.Invoices
  WHERE InvoiceNumber LIKE 'INV-202604-[0-9][0-9][0-9][0-9]';

  INSERT INTO oe.Invoices (
    InvoiceId, GroupId, InvoiceNumber,
    InvoiceDate, DueDate, BillingPeriodStart, BillingPeriodEnd,
    SubTotal, TaxAmount, TotalAmount, PaidAmount,
    Status, PaymentDueDate,
    CreatedDate, ModifiedDate,
    HouseholdId, InvoiceType, TenantId,
    NetRate, OverrideRate, Commission, SystemFees, ProcessingFeeAmount, SetupFee,
    ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts,
    CreditAmount
  )
  VALUES (
    @NewInvoiceId, NULL, @NextNum,
    '2026-04-01', '2026-04-01', '2026-04-01', '2026-04-24',
    103.60, 0, 103.60, 0,
    N'Unpaid', '2026-04-01',
    SYSUTCDATETIME(), SYSUTCDATETIME(),
    'F9FE2A1F-54B7-46A6-B4B0-0B591385DC0B', N'Individual', 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6',
    79.20, 0, 20.80, 2.80, 0.80, 0,
    N'{"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"commissionAmount":20.80}}',
    N'{"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"vendorAmount":79.20}}',
    N'{"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"overrideAmount":0}}',
    0
  );

  PRINT 'Inserted gap-fill invoice ' + @NextNum + ' (InvoiceId=' + CAST(@NewInvoiceId AS NVARCHAR(50)) + ') for Rick McKinney.';
END;

COMMIT TRAN;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  THROW;
END CATCH;

-- ============================================================
-- VERIFICATION
-- ============================================================
SELECT
  InvoiceId, InvoiceNumber, BillingPeriodStart, BillingPeriodEnd,
  TotalAmount, PaidAmount, BalanceDue, Status,
  NetRate, Commission, SystemFees, ProcessingFeeAmount,
  ProductVendorAmounts, ProductCommissions, ProductOwnerAmounts
FROM oe.Invoices
WHERE HouseholdId = 'F9FE2A1F-54B7-46A6-B4B0-0B591385DC0B'
ORDER BY BillingPeriodStart ASC;
-- Expect 3 rows now: 3/1-3/31 Paid, 4/1-4/24 Unpaid (new), 4/25-4/30 Overdue.
