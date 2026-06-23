-- Migration: Create oe.Prospects and oe.ProspectProducts
-- Date: 2026-05-25
-- Description: Prospects CRM (Phase 1). A prospect is a lead who is not yet an
--   enrolled member. Identity dedupe is email-primary, phone-fallback (normalized).
--   Member matching is "suggest, agent confirms": a detected match is stored in
--   SuggestedMemberId and surfaced in the UI; MemberId + Status='Closed' are only
--   set once an agent confirms the link (no auto-close).
--   Status lifecycle: New -> Contacted -> Proposal Sent -> Closed -> Lost.
--
-- Idempotent: safe to run multiple times. Read-only-by-default policy: this script
-- only creates new objects; it does not modify or backfill existing data.

-------------------------------------------------------------------------------
-- oe.Prospects
-------------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.objects
    WHERE object_id = OBJECT_ID('oe.Prospects') AND type = 'U'
)
BEGIN
    CREATE TABLE oe.Prospects (
        ProspectId          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        TenantId            UNIQUEIDENTIFIER NOT NULL,
        AgentId             UNIQUEIDENTIFIER NULL,        -- owning agent; drives visibility
        FirstName           NVARCHAR(100) NULL,
        LastName            NVARCHAR(100) NULL,
        Email               NVARCHAR(256) NULL,           -- raw, as entered
        EmailNormalized     NVARCHAR(256) NULL,           -- lower/trim; dedupe key 1
        Phone               NVARCHAR(40) NULL,            -- raw, as entered
        PhoneNormalized     NVARCHAR(20) NULL,            -- last 10 digits; dedupe key 2
        Status              NVARCHAR(40) NOT NULL DEFAULT 'New',  -- New/Contacted/Proposal Sent/Closed/Lost
        ReferralName        NVARCHAR(200) NULL,
        PremiumAmount       DECIMAL(18,2) NULL,           -- last quoted/estimated premium
        Notes               NVARCHAR(MAX) NULL,
        Source              NVARCHAR(40) NOT NULL DEFAULT 'Manual', -- Manual/Proposal/Quote/ApiIngest
        SuggestedMemberId   UNIQUEIDENTIFIER NULL,        -- auto-detected match, pending agent confirm
        MemberId            UNIQUEIDENTIFIER NULL,        -- confirmed link; set with Status='Closed'
        ClosedDate          DATETIME2 NULL,
        CreatedBy           UNIQUEIDENTIFIER NULL,
        CreatedDate         DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate        DATETIME2 NOT NULL DEFAULT GETUTCDATE(),

        CONSTRAINT PK_Prospects PRIMARY KEY (ProspectId),
        CONSTRAINT FK_Prospects_Tenants
            FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId),
        CONSTRAINT FK_Prospects_Agents
            FOREIGN KEY (AgentId) REFERENCES oe.Agents(AgentId),
        CONSTRAINT FK_Prospects_Members
            FOREIGN KEY (MemberId) REFERENCES oe.Members(MemberId),
        CONSTRAINT FK_Prospects_SuggestedMember
            FOREIGN KEY (SuggestedMemberId) REFERENCES oe.Members(MemberId)
    );

    PRINT 'oe.Prospects table created';
END
ELSE
BEGIN
    PRINT 'oe.Prospects table already exists';
END
GO

-- Indexes for dedupe lookups and visibility/status filtering
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.Prospects') AND type = 'U')
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Prospects_Tenant_Email' AND object_id = OBJECT_ID('oe.Prospects'))
        CREATE INDEX IX_Prospects_Tenant_Email ON oe.Prospects (TenantId, EmailNormalized);

    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Prospects_Tenant_Phone' AND object_id = OBJECT_ID('oe.Prospects'))
        CREATE INDEX IX_Prospects_Tenant_Phone ON oe.Prospects (TenantId, PhoneNormalized);

    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Prospects_Tenant_Agent' AND object_id = OBJECT_ID('oe.Prospects'))
        CREATE INDEX IX_Prospects_Tenant_Agent ON oe.Prospects (TenantId, AgentId);

    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Prospects_Tenant_Status' AND object_id = OBJECT_ID('oe.Prospects'))
        CREATE INDEX IX_Prospects_Tenant_Status ON oe.Prospects (TenantId, Status);

    PRINT 'oe.Prospects indexes ensured';
END
GO

-------------------------------------------------------------------------------
-- oe.ProspectProducts (products the prospect is interested in / subscribed to)
-------------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.objects
    WHERE object_id = OBJECT_ID('oe.ProspectProducts') AND type = 'U'
)
BEGIN
    CREATE TABLE oe.ProspectProducts (
        ProspectProductId   UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        ProspectId          UNIQUEIDENTIFIER NOT NULL,
        ProductId           UNIQUEIDENTIFIER NOT NULL,
        PremiumAmount       DECIMAL(18,2) NULL,
        Source              NVARCHAR(40) NOT NULL DEFAULT 'Manual',
        CreatedDate         DATETIME2 NOT NULL DEFAULT GETUTCDATE(),

        CONSTRAINT PK_ProspectProducts PRIMARY KEY (ProspectProductId),
        CONSTRAINT FK_ProspectProducts_Prospects
            FOREIGN KEY (ProspectId) REFERENCES oe.Prospects(ProspectId),
        CONSTRAINT FK_ProspectProducts_Products
            FOREIGN KEY (ProductId) REFERENCES oe.Products(ProductId),
        CONSTRAINT UQ_ProspectProducts UNIQUE (ProspectId, ProductId)
    );

    PRINT 'oe.ProspectProducts table created';
END
ELSE
BEGIN
    PRINT 'oe.ProspectProducts table already exists';
END
GO
