-- Migration: Allow oe.EnrollmentLinks.AgentId to be NULL
-- Purpose: Support agency-only tenants (e.g. Alioup) where the agency has no OwnerAgentId.
--          create-marketing and create-static insert links with AgentId NULL for such agencies.
-- Run this if create-marketing/create-static fail with "cannot insert NULL into column AgentId".

IF EXISTS (SELECT * FROM sys.tables t
           INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
           WHERE s.name = 'oe' AND t.name = 'EnrollmentLinks')
BEGIN
    IF EXISTS (SELECT * FROM sys.columns c
               INNER JOIN sys.tables t ON c.object_id = t.object_id
               INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
               WHERE s.name = 'oe' AND t.name = 'EnrollmentLinks' AND c.name = 'AgentId')
    BEGIN
        PRINT 'Altering oe.EnrollmentLinks.AgentId to allow NULL...';
        ALTER TABLE oe.EnrollmentLinks
        ALTER COLUMN AgentId UNIQUEIDENTIFIER NULL;
        PRINT 'oe.EnrollmentLinks.AgentId is now nullable.';
    END
    ELSE
        PRINT 'Column oe.EnrollmentLinks.AgentId not found - skip.';
END
ELSE
    PRINT 'Table oe.EnrollmentLinks not found - skip.';
