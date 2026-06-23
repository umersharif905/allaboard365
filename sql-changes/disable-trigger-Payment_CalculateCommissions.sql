-- Disable trigger that runs on oe.Payments UPDATE (Status -> Completed) and calls sp_CalculateCommissions.
-- sp_CalculateCommissions currently fails (Invalid column name 'Percentage' on oe.Commissions).
-- The "Generate commissions" button in SysAdmin/TenantAdmin accounting uses the backend API (CommissionCalculatorService),
-- not this trigger, so disabling is safe.
-- Re-enable with: sql-changes/enable-trigger-Payment_CalculateCommissions.sql

IF OBJECT_ID('oe.tr_Payment_CalculateCommissions', 'TR') IS NOT NULL
BEGIN
  DISABLE TRIGGER [oe].[tr_Payment_CalculateCommissions] ON [oe].[Payments];
  PRINT 'Disabled trigger oe.tr_Payment_CalculateCommissions on oe.Payments.';
END
ELSE
  PRINT 'Trigger oe.tr_Payment_CalculateCommissions not found.';
