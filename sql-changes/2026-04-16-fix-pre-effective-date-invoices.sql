-- ============================================================================
-- Fix invoices created before member effective date by backfill script
--
-- Problem: The backfill script created March invoices for members who enrolled
-- in March but whose benefits don't start until April 1. Payments made in
-- March (for the April period) were incorrectly linked to these March invoices.
--
-- Affected households:
--   1. Anna Lachkaya (42D15FD0) — March invoice INV-202604-1089
--   2. Olivia Mondy   (A2DABA6B) — March invoice INV-202604-1116
--
-- Fix:
--   1. Re-link payments from the bogus March invoice to the April invoice
--   2. Update April invoice PaidAmount to include the re-linked payment
--   3. Cancel the March invoice (set Status='Cancelled', PaidAmount=0)
-- ============================================================================

BEGIN TRANSACTION;

-- ===== Household 1: Anna Lachkaya =====
-- March invoice: 7903FC80-3FDF-43AA-BF00-DACCB37E85DF (bogus)
-- April invoice: 1013ADDA-AD93-4990-96F7-20B1E3B03D14 (real, currently Overdue)
-- Payment:       4F4575BA-5DF4-49A7-A4CF-48E000744E78 ($940.64, currently on March inv)

-- Re-link Anna's payment to the April invoice
UPDATE oe.Payments
SET InvoiceId = '1013ADDA-AD93-4990-96F7-20B1E3B03D14',
    ModifiedDate = GETUTCDATE()
WHERE PaymentId = '4F4575BA-5DF4-49A7-A4CF-48E000744E78'
  AND InvoiceId = '7903FC80-3FDF-43AA-BF00-DACCB37E85DF';

-- Mark April invoice as Paid
UPDATE oe.Invoices
SET PaidAmount = 940.64,
    Status = 'Paid',
    ModifiedDate = GETUTCDATE()
WHERE InvoiceId = '1013ADDA-AD93-4990-96F7-20B1E3B03D14';

-- Cancel the bogus March invoice
UPDATE oe.Invoices
SET Status = 'Cancelled',
    PaidAmount = 0,
    ModifiedDate = GETUTCDATE()
WHERE InvoiceId = '7903FC80-3FDF-43AA-BF00-DACCB37E85DF';


-- ===== Household 2: Olivia Mondy =====
-- March invoice: CDAD7FB9-886A-4E1A-BF5C-F48D47D69921 (bogus)
-- April invoice: 18F8BA87-9A38-47BD-BAD2-2D8639F3FC26 (real)
-- Payment:       AD0BEBF0-231A-4960-A8F5-F44B919E6A0B ($48.93, currently on March inv)

-- Re-link Mondy's payment to the April invoice
UPDATE oe.Payments
SET InvoiceId = '18F8BA87-9A38-47BD-BAD2-2D8639F3FC26',
    ModifiedDate = GETUTCDATE()
WHERE PaymentId = 'AD0BEBF0-231A-4960-A8F5-F44B919E6A0B'
  AND InvoiceId = 'CDAD7FB9-886A-4E1A-BF5C-F48D47D69921';

-- Update April invoice PaidAmount (existing 439.09 + 48.93 = 488.02)
UPDATE oe.Invoices
SET PaidAmount = 488.02,
    ModifiedDate = GETUTCDATE()
WHERE InvoiceId = '18F8BA87-9A38-47BD-BAD2-2D8639F3FC26';

-- Cancel the bogus March invoice
UPDATE oe.Invoices
SET Status = 'Cancelled',
    PaidAmount = 0,
    ModifiedDate = GETUTCDATE()
WHERE InvoiceId = 'CDAD7FB9-886A-4E1A-BF5C-F48D47D69921';


-- ===== Verify results =====

-- Anna's invoices
SELECT 'Anna Lachkaya' AS Household, i.InvoiceNumber, i.Status, i.TotalAmount, i.PaidAmount,
       i.BillingPeriodStart, i.BillingPeriodEnd
FROM oe.Invoices i
WHERE i.HouseholdId = '42D15FD0-C6DA-4C3F-80C5-389394167732'
ORDER BY i.BillingPeriodStart;

-- Anna's payment linkage
SELECT 'Anna Payment' AS Label, p.PaymentId, p.Amount, p.Status, p.InvoiceId
FROM oe.Payments p
WHERE p.PaymentId = '4F4575BA-5DF4-49A7-A4CF-48E000744E78';

-- Mondy's invoices
SELECT 'Olivia Mondy' AS Household, i.InvoiceNumber, i.Status, i.TotalAmount, i.PaidAmount,
       i.BillingPeriodStart, i.BillingPeriodEnd
FROM oe.Invoices i
WHERE i.HouseholdId = 'A2DABA6B-36F7-47F5-9149-9E511F6B3DD4'
ORDER BY i.BillingPeriodStart;

-- Mondy's payment linkage
SELECT 'Mondy Payment' AS Label, p.PaymentId, p.Amount, p.Status, p.InvoiceId
FROM oe.Payments p
WHERE p.PaymentId = 'AD0BEBF0-231A-4960-A8F5-F44B919E6A0B';

-- Review before committing
-- COMMIT;
ROLLBACK;
