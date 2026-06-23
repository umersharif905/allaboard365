-- Migration: Add ProcessingFeeAmount to oe.Payments
-- Stores the payment processing fee at time of payment; used by billing/fees APIs and reporting.
-- Backfill: existing rows keep NULL; APIs use COALESCE(p.ProcessingFeeAmount, <enrollment sum>) for display.
--
-- Utilization (verify after deploy):
--   WRITE: paymentDatabaseService.storePaymentRecord() - sets ProcessingFeeAmount (or computes from enrollments if missing)
--   WRITE: enrollment-links.js - INSERT into oe.Payments includes ProcessingFeeAmount when recording payment
--   WRITE: oe_payment_manager/DimeWebhookHandler - recurring success + failure INSERTs include ProcessingFeeAmount (from enrollments)
--   WRITE: oe_payment_manager/DimePaymentSync - INSERT includes ProcessingFeeAmount from calculatePricingFields()
--   READ:  tenant-admin/billing.js + sysadmin/billing.js - GET /payments, GET /fees, GET /payments/:id/processor-fee-detail use COALESCE(p.ProcessingFeeAmount, enrollment sum)

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.Payments') AND name = 'ProcessingFeeAmount'
)
BEGIN
    ALTER TABLE oe.Payments
    ADD ProcessingFeeAmount DECIMAL(10, 2) NULL;

    PRINT 'ProcessingFeeAmount column added to oe.Payments';
END
ELSE
BEGIN
    PRINT 'ProcessingFeeAmount column already exists on oe.Payments';
END
GO
