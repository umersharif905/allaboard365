-- Add IsPrimary flag to ProposalDocumentProducts
-- Controls which products appear in the agent's product dropdown when generating proposals
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.ProposalDocumentProducts')
    AND name = 'IsPrimary'
)
BEGIN
  ALTER TABLE oe.ProposalDocumentProducts ADD IsPrimary BIT NOT NULL DEFAULT 0;
END
