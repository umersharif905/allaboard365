-- Fix Tamara Nicklas's April invoice billing period.
--
-- Background:
--   HouseholdId 8690FB6F-0FD7-4246-BD1F-BB055E364258
--   InvoiceId   F86029AF-5992-48CC-9B0D-16673C4AA074  (INV-202604-1164)
--
-- Today the invoice is recorded as covering 2026-04-28 through 2026-04-30 (3 days),
-- but the dollar amounts on it are full-month values:
--    TotalAmount = $261.00
--    NetRate     = $218.00 (ShareWELL vendor share)
--    Commission  = $32.00
--    PaidAmount  = $261.00 (paid via household credit)
--    Status      = 'Paid'
--
-- That mislabeling makes vendor breakdown's "Covered but Unpaid" panel report
-- Tamara as "Covered, no invoice" for any window before 4/28, even though we
-- already collected her April money via credit.
--
-- Fix: shift BillingPeriodStart from 2026-04-28 to 2026-04-01. Leave all dollar
-- amounts and Status untouched — the invoice was always priced as a full month.
-- After this:
--   * Vendor breakdown will count her April invoice as covering 4/1-4/30.
--   * Once the invoice-anchored NACHA code ships, ShareWELL will get paid the
--     $218 vendor share for Tamara's April coverage on the next vendor NACHA.
--
-- Idempotent: only updates if BillingPeriodStart still equals 2026-04-28.

PRINT '=== Pre-update state ===';
SELECT
  InvoiceId,
  InvoiceNumber,
  BillingPeriodStart,
  BillingPeriodEnd,
  TotalAmount,
  NetRate,
  Status,
  PaidAmount,
  BalanceDue
FROM oe.Invoices
WHERE InvoiceId = 'F86029AF-5992-48CC-9B0D-16673C4AA074';

UPDATE oe.Invoices
SET
  BillingPeriodStart = '2026-04-01',
  ModifiedDate       = SYSUTCDATETIME()
WHERE InvoiceId = 'F86029AF-5992-48CC-9B0D-16673C4AA074'
  AND BillingPeriodStart = '2026-04-28';

PRINT '=== Post-update state ===';
SELECT
  InvoiceId,
  InvoiceNumber,
  BillingPeriodStart,
  BillingPeriodEnd,
  TotalAmount,
  NetRate,
  Status,
  PaidAmount,
  BalanceDue
FROM oe.Invoices
WHERE InvoiceId = 'F86029AF-5992-48CC-9B0D-16673C4AA074';

PRINT '=== Tamara full April picture ===';
SELECT
  InvoiceId,
  InvoiceNumber,
  BillingPeriodStart,
  BillingPeriodEnd,
  TotalAmount,
  NetRate,
  Status
FROM oe.Invoices
WHERE HouseholdId = '8690FB6F-0FD7-4246-BD1F-BB055E364258'
  AND BillingPeriodStart >= '2026-03-01'
ORDER BY BillingPeriodStart;
