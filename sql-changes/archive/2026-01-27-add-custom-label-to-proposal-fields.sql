-- Add CustomLabel column to ProposalFields table
-- Date: 1-27-26
-- Description: Adds support for custom fields with custom labels in proposal documents

ALTER TABLE oe.ProposalFields 
ADD CustomLabel nvarchar(255) NULL;

