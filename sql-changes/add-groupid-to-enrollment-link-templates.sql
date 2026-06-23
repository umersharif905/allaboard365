-- Migration: Add GroupId column to oe.EnrollmentLinkTemplates table
-- Date: 2025-01-XX
-- Description: Add optional GroupId column to support Group enrollment link templates

-- Check if column already exists before adding
IF NOT EXISTS (
    SELECT 1 
    FROM sys.columns 
    WHERE object_id = OBJECT_ID('oe.EnrollmentLinkTemplates') 
    AND name = 'GroupId'
)
BEGIN
    ALTER TABLE oe.EnrollmentLinkTemplates
    ADD GroupId UNIQUEIDENTIFIER NULL;
    
    -- Add foreign key constraint to oe.Groups
    ALTER TABLE oe.EnrollmentLinkTemplates
    ADD CONSTRAINT FK_EnrollmentLinkTemplates_Groups
    FOREIGN KEY (GroupId) REFERENCES oe.Groups(GroupId);
    
    PRINT 'GroupId column added to oe.EnrollmentLinkTemplates table';
END
ELSE
BEGIN
    PRINT 'GroupId column already exists in oe.EnrollmentLinkTemplates table';
END
GO

