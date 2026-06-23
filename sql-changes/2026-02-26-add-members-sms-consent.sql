-- Add SMS consent to oe.Members (set when user opts in/out during enrollment)
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Members') AND name = 'SmsConsent'
)
BEGIN
  ALTER TABLE oe.Members
  ADD SmsConsent BIT NULL;
  PRINT 'Added SmsConsent to oe.Members';
END
GO
