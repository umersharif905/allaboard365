-- Migration: Prospects CRM phases 2–5 (communications, quotes, agent API keys)
-- Date: 2026-05-26
-- Description: Combined follow-up to 2026-05-25-add-prospects.sql. Adds:
--   1. ProspectId on oe.MessageQueue + oe.MessageHistory  (Phase 2 — communications)
--   2. oe.Quotes + oe.QuoteLineItems and oe.ProposalSends.ProspectId (Phase 3 — proposals/quotes)
--   3. oe.TenantApiKeys schema + AgentId/Scope columns (Phase 4 — agent-scoped lead ingest)
--
-- All sections are idempotent and additive (create-if-missing / add-column-if-missing);
-- no existing data is modified or backfilled.

-------------------------------------------------------------------------------
-- PHASE 2: ProspectId on the message tables
-- Lets a queued/sent message be threaded back to a prospect (mirrors the existing
-- CaseId/ShareRequestId columns). Communications also match by recipient email/phone,
-- so this column is additive and changes nothing for members.
-------------------------------------------------------------------------------
IF NOT EXISTS (
  SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MessageQueue') AND name = 'ProspectId'
)
BEGIN
  ALTER TABLE oe.MessageQueue ADD ProspectId UNIQUEIDENTIFIER NULL;
  PRINT 'Added ProspectId to oe.MessageQueue';
END
ELSE
  PRINT 'oe.MessageQueue.ProspectId already exists';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MessageHistory') AND name = 'ProspectId'
)
BEGIN
  ALTER TABLE oe.MessageHistory ADD ProspectId UNIQUEIDENTIFIER NULL;
  PRINT 'Added ProspectId to oe.MessageHistory';
END
ELSE
  PRINT 'oe.MessageHistory.ProspectId already exists';
GO

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MessageHistory') AND name = 'ProspectId')
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MessageHistory_ProspectId' AND object_id = OBJECT_ID('oe.MessageHistory'))
BEGIN
  CREATE INDEX IX_MessageHistory_ProspectId ON oe.MessageHistory (ProspectId) WHERE ProspectId IS NOT NULL;
  PRINT 'Created IX_MessageHistory_ProspectId';
END
GO

-------------------------------------------------------------------------------
-- PHASE 3: Quotes + link ProposalSends to a prospect
-------------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.Quotes') AND type = 'U')
BEGIN
    CREATE TABLE oe.Quotes (
        QuoteId         UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        TenantId        UNIQUEIDENTIFIER NOT NULL,
        AgentId         UNIQUEIDENTIFIER NULL,
        ProspectId      UNIQUEIDENTIFIER NULL,
        ProspectName    NVARCHAR(200) NULL,
        ProspectEmail   NVARCHAR(256) NULL,
        ProspectPhone   NVARCHAR(40) NULL,
        Status          NVARCHAR(40) NOT NULL DEFAULT 'Draft',  -- Draft / Sent / Accepted / Declined
        TotalPremium    DECIMAL(18,2) NULL,
        Notes           NVARCHAR(MAX) NULL,
        CreatedBy       UNIQUEIDENTIFIER NULL,
        CreatedDate     DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate    DATETIME2 NOT NULL DEFAULT GETUTCDATE(),

        CONSTRAINT PK_Quotes PRIMARY KEY (QuoteId),
        CONSTRAINT FK_Quotes_Tenants FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId),
        CONSTRAINT FK_Quotes_Agents FOREIGN KEY (AgentId) REFERENCES oe.Agents(AgentId),
        CONSTRAINT FK_Quotes_Prospects FOREIGN KEY (ProspectId) REFERENCES oe.Prospects(ProspectId)
    );
    PRINT 'oe.Quotes table created';
END
ELSE
    PRINT 'oe.Quotes table already exists';
GO

IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.Quotes') AND type = 'U')
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Quotes_Tenant_Prospect' AND object_id = OBJECT_ID('oe.Quotes'))
    CREATE INDEX IX_Quotes_Tenant_Prospect ON oe.Quotes (TenantId, ProspectId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.QuoteLineItems') AND type = 'U')
BEGIN
    CREATE TABLE oe.QuoteLineItems (
        QuoteLineItemId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        QuoteId         UNIQUEIDENTIFIER NOT NULL,
        ProductId       UNIQUEIDENTIFIER NULL,
        ProductName     NVARCHAR(255) NULL,
        Premium         DECIMAL(18,2) NULL,
        Tier            NVARCHAR(20) NULL,
        CreatedDate     DATETIME2 NOT NULL DEFAULT GETUTCDATE(),

        CONSTRAINT PK_QuoteLineItems PRIMARY KEY (QuoteLineItemId),
        CONSTRAINT FK_QuoteLineItems_Quotes FOREIGN KEY (QuoteId) REFERENCES oe.Quotes(QuoteId)
    );
    PRINT 'oe.QuoteLineItems table created';
END
ELSE
    PRINT 'oe.QuoteLineItems table already exists';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.ProposalSends') AND name = 'ProspectId'
)
BEGIN
    ALTER TABLE oe.ProposalSends ADD ProspectId UNIQUEIDENTIFIER NULL;
    PRINT 'Added ProspectId to oe.ProposalSends';
END
ELSE
    PRINT 'oe.ProposalSends.ProspectId already exists';
GO

-------------------------------------------------------------------------------
-- PHASE 4: Agent-scoped API keys for lead ingestion
-- oe.TenantApiKeys is used by middleware/auth.js but had no creation script in source
-- control, so this captures its schema (create-if-missing) and adds:
--   AgentId : when set, the key authenticates AS that agent (real UserId + Agent role)
--   Scope   : optional capability tag, e.g. 'lead-ingest'
-------------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.TenantApiKeys') AND type = 'U')
BEGIN
    CREATE TABLE oe.TenantApiKeys (
        ApiKeyId      UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        TenantId      UNIQUEIDENTIFIER NOT NULL,
        KeyName       NVARCHAR(255) NOT NULL,
        KeyHash       NVARCHAR(128) NOT NULL,        -- SHA-256 hex of the full key
        PartialKey    NVARCHAR(20) NOT NULL,         -- last chars, for display
        Status        NVARCHAR(20) NOT NULL DEFAULT 'active',  -- active / revoked
        ExpiresAt     DATETIME2 NULL,
        CreatedBy     UNIQUEIDENTIFIER NULL,
        CreatedDate   DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        LastUsedDate  DATETIME2 NULL,

        CONSTRAINT PK_TenantApiKeys PRIMARY KEY (ApiKeyId),
        CONSTRAINT FK_TenantApiKeys_Tenants FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId)
    );
    PRINT 'oe.TenantApiKeys table created';
END
ELSE
    PRINT 'oe.TenantApiKeys table already exists';
GO

IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.TenantApiKeys') AND type = 'U')
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TenantApiKeys_KeyHash' AND object_id = OBJECT_ID('oe.TenantApiKeys'))
    CREATE INDEX IX_TenantApiKeys_KeyHash ON oe.TenantApiKeys (KeyHash);
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.TenantApiKeys') AND name = 'AgentId')
BEGIN
    ALTER TABLE oe.TenantApiKeys ADD AgentId UNIQUEIDENTIFIER NULL;
    PRINT 'Added AgentId to oe.TenantApiKeys';
END
ELSE
    PRINT 'oe.TenantApiKeys.AgentId already exists';
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.TenantApiKeys') AND name = 'Scope')
BEGIN
    ALTER TABLE oe.TenantApiKeys ADD Scope NVARCHAR(40) NULL;
    PRINT 'Added Scope to oe.TenantApiKeys';
END
ELSE
    PRINT 'oe.TenantApiKeys.Scope already exists';
GO
