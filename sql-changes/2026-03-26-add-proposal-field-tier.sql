-- Add per-field Tier column to ProposalFields
-- Allows each price field to specify its own tier instead of using the global document tier.
-- NULL or 'document' means "use the document-level tier" (backward compatible).
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.ProposalFields') AND name = 'Tier'
)
BEGIN
  ALTER TABLE oe.ProposalFields ADD Tier NVARCHAR(10) NULL;
END
