-- ============================================================================
-- OVERDUE INVOICE REMINDER LOG: per-send audit + idempotency
-- ============================================================================
-- One row per (TenantId, InvoiceId, AttemptNumber, Channel) reminder send.
-- Drives cadence (next reminder = LastSentDate + cadenceDays) and prevents
-- duplicate sends if the nightly orchestrator is double-invoked. Read by
-- backend/services/overdueInvoiceReminder.service.js (selection + recordSend).
-- ============================================================================

PRINT 'Creating oe.InvoiceReminderLog if not exists...';

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = N'oe' AND TABLE_NAME = N'InvoiceReminderLog')
BEGIN
    CREATE TABLE oe.InvoiceReminderLog (
        TenantId             UNIQUEIDENTIFIER NOT NULL,
        InvoiceReminderLogId BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        InvoiceId            UNIQUEIDENTIFIER NOT NULL,
        AttemptNumber        INT              NOT NULL,
        Channel              NVARCHAR(20)     NOT NULL,
        RecipientType        NVARCHAR(40)     NOT NULL,
        RecipientAddress     NVARCHAR(320)    NOT NULL,
        QueuedMessageId      UNIQUEIDENTIFIER NULL,
        Status               NVARCHAR(20)     NOT NULL,
        SkipReason           NVARCHAR(200)    NULL,
        DaysOverdueAtSend    INT              NOT NULL,
        CreatedDate          DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CreatedBy            UNIQUEIDENTIFIER NULL,
        CONSTRAINT FK_InvoiceReminderLog_Invoice
            FOREIGN KEY (InvoiceId) REFERENCES oe.Invoices(InvoiceId),
        CONSTRAINT CK_InvoiceReminderLog_Channel
            CHECK (Channel IN (N'Email', N'SMS')),
        CONSTRAINT CK_InvoiceReminderLog_Status
            CHECK (Status IN (N'Queued', N'Skipped', N'Failed')),
        CONSTRAINT CK_InvoiceReminderLog_RecipientType
            CHECK (RecipientType IN (N'MemberPrimary', N'GroupBilling'))
    );

    -- Idempotency guard: re-runs hit this and skip cleanly.
    CREATE UNIQUE INDEX UQ_InvoiceReminderLog_Tenant_Invoice_Attempt_Channel
        ON oe.InvoiceReminderLog (TenantId, InvoiceId, AttemptNumber, Channel);

    -- Cadence-count + support lookups ("did Stan get reminder #2?").
    CREATE INDEX IX_InvoiceReminderLog_Tenant_Invoice
        ON oe.InvoiceReminderLog (TenantId, InvoiceId, CreatedDate DESC);

    PRINT 'Created oe.InvoiceReminderLog';
END
ELSE
BEGIN
    PRINT 'oe.InvoiceReminderLog already exists';
END
GO
