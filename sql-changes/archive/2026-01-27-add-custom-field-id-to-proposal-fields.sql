-- Add CustomFieldId column to ProposalFields table
-- Date: 1-27-26
-- Description: Adds support for linking multiple fields to the same custom field value

ALTER TABLE oe.ProposalFields 
ADD CustomFieldId uniqueidentifier NULL;

