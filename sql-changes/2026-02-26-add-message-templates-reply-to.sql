-- Add optional ReplyTo to MessageTemplates (supports variables e.g. {[agent.Email]})
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.MessageTemplates') AND name = 'ReplyTo'
)
BEGIN
  ALTER TABLE oe.MessageTemplates
  ADD ReplyTo NVARCHAR(500) NULL;
  PRINT 'Added ReplyTo to oe.MessageTemplates';
END
GO
