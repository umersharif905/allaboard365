-- 2026-04-21-system-integration-errors-priority-notified.sql
--
-- Add Priority + NotificationSentAt to oe.SystemIntegrationErrors so we can:
--   1. Classify errors beyond the free-text Severity column.
--      - normal   : default; batched, low-urgency.
--      - high     : DIME vault transient, webhook replay exhausted, etc. — triggers digest.
--      - critical : reserved for hard outages; triggers digest immediately.
--   2. Track which rows have already been emailed out so the 15-min digest job doesn't
--      re-send the same error every run.
--
-- Idempotent: safe to re-run.

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.SystemIntegrationErrors')
      AND name = 'Priority'
)
BEGIN
    ALTER TABLE oe.SystemIntegrationErrors
        ADD Priority NVARCHAR(16) NOT NULL
            CONSTRAINT DF_SystemIntegrationErrors_Priority DEFAULT N'normal';
END
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.SystemIntegrationErrors')
      AND name = 'NotificationSentAt'
)
BEGIN
    ALTER TABLE oe.SystemIntegrationErrors
        ADD NotificationSentAt DATETIME2 NULL;
END
GO

-- Index so the digest job's "un-notified high/critical" scan stays cheap once the table grows.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_SystemIntegrationErrors_Priority_NotificationSentAt'
      AND object_id = OBJECT_ID('oe.SystemIntegrationErrors')
)
BEGIN
    CREATE INDEX IX_SystemIntegrationErrors_Priority_NotificationSentAt
        ON oe.SystemIntegrationErrors (Priority, NotificationSentAt)
        INCLUDE (CreatedDate, Category, Source, Severity, TenantId, Message);
END
GO

-- Backfill any existing rows to `normal` priority so the NOT NULL default applies cleanly.
UPDATE oe.SystemIntegrationErrors
    SET Priority = N'normal'
WHERE Priority IS NULL;
GO
