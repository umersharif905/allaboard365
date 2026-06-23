-- sql-changes/2026-04-16-add-message-event.sql
-- New events table for per-message provider event history.
-- Additive only. No FK to MessageHistory (events may arrive before MH insert completes).
-- Idempotency via UNIQUE(Provider, ProviderEventId).

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'MessageEvent' AND schema_id = SCHEMA_ID('oe'))
BEGIN
  CREATE TABLE oe.MessageEvent (
    EventId         UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    MessageId       UNIQUEIDENTIFIER NOT NULL,
    Provider        NVARCHAR(20)     NOT NULL,
    EventType       NVARCHAR(40)     NOT NULL,
    EventTime       DATETIME2        NOT NULL,
    Reason          NVARCHAR(1000)   NULL,
    MxServer        NVARCHAR(200)    NULL,
    ProviderEventId NVARCHAR(100)    NULL,
    RawPayload      NVARCHAR(MAX)    NULL,
    CreatedAt       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_MessageEvent PRIMARY KEY (EventId),
    CONSTRAINT UQ_MessageEvent_ProviderEventId UNIQUE (Provider, ProviderEventId)
  );
  CREATE INDEX IX_MessageEvent_MessageId ON oe.MessageEvent(MessageId);
  CREATE INDEX IX_MessageEvent_EventTime ON oe.MessageEvent(EventTime DESC);
  CREATE INDEX IX_MessageEvent_EventType ON oe.MessageEvent(EventType);
END
