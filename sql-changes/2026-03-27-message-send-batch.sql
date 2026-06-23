-- Message send batches (e.g. tenant message blast): one BatchId per blast, shared by all queued rows.
-- Run once against the AllAboard / OpenEnroll SQL database (shared by backend and Message Center).
-- Deploying the Azure Message Center Function App does not run this script; schema is applied on the DB only.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE schema_id = SCHEMA_ID('oe') AND name = 'MessageSendBatch')
BEGIN
  CREATE TABLE oe.MessageSendBatch (
    BatchId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MessageSendBatch PRIMARY KEY,
    TenantId UNIQUEIDENTIFIER NOT NULL,
    Label NVARCHAR(200) NULL,
    SmsTotal INT NOT NULL CONSTRAINT DF_MessageSendBatch_SmsTotal DEFAULT 0,
    EmailTotal INT NOT NULL CONSTRAINT DF_MessageSendBatch_EmailTotal DEFAULT 0,
    CreatedDate DATETIME2 NOT NULL CONSTRAINT DF_MessageSendBatch_CreatedDate DEFAULT GETUTCDATE(),
    CreatedBy UNIQUEIDENTIFIER NULL
  );
  CREATE INDEX IX_MessageSendBatch_TenantId_CreatedDate ON oe.MessageSendBatch (TenantId, CreatedDate DESC);
END
GO

-- ALTER + filtered index must be in separate batches: SQL Server parses the whole batch before
-- running ALTER, so CREATE INDEX ... (BatchId) in the same batch yields "Invalid column name 'BatchId'".

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MessageQueue') AND name = 'BatchId')
BEGIN
  ALTER TABLE oe.MessageQueue ADD BatchId UNIQUEIDENTIFIER NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('oe.MessageQueue') AND name = 'IX_MessageQueue_BatchId')
BEGIN
  CREATE INDEX IX_MessageQueue_BatchId ON oe.MessageQueue (BatchId) WHERE BatchId IS NOT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MessageHistory') AND name = 'BatchId')
BEGIN
  ALTER TABLE oe.MessageHistory ADD BatchId UNIQUEIDENTIFIER NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('oe.MessageHistory') AND name = 'IX_MessageHistory_BatchId')
BEGIN
  CREATE INDEX IX_MessageHistory_BatchId ON oe.MessageHistory (BatchId) WHERE BatchId IS NOT NULL;
END
GO
