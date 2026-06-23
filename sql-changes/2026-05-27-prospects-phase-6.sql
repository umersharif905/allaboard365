-- Migration: Prospects CRM phase 6 (group prospects, tags, follow-up/last-contacted)
-- Date: 2026-05-27
-- Description: Follow-up to 2026-05-26-prospects-phases-2-5.sql. Adds:
--   1. oe.GroupProspects + oe.Prospects.GroupProspectId  (group/company tracking)
--   2. oe.ProspectTags + oe.ProspectTagAssignments        (agency-shared, multi-tag, colored)
--   3. oe.Prospects.NextFollowUpDate + LastContactedDate  (follow-up + auto last-contact)
--
-- All sections are idempotent and additive (create-if-missing / add-column-if-missing);
-- no existing data is modified or backfilled. Not auto-applied — run per DB policy.

-------------------------------------------------------------------------------
-- SECTION 1: Group prospects
-- A business/group proposal (oe.business-proposal-sends) find-or-creates one
-- oe.GroupProspects row for the company. Individual employees who later receive a
-- proposal can be linked back via oe.Prospects.GroupProspectId.
-------------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.GroupProspects') AND type = 'U')
BEGIN
    CREATE TABLE oe.GroupProspects (
        GroupProspectId       UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        TenantId              UNIQUEIDENTIFIER NOT NULL,
        AgentId               UNIQUEIDENTIFIER NULL,
        CompanyName           NVARCHAR(255) NOT NULL,
        CompanyNameNormalized NVARCHAR(255) NULL,   -- lower/trim, for dedupe within tenant+agent
        ContactName           NVARCHAR(200) NULL,
        ContactEmail          NVARCHAR(256) NULL,
        EmailNormalized       NVARCHAR(256) NULL,   -- dedupe key 1
        ContactPhone          NVARCHAR(40) NULL,
        PhoneNormalized       NVARCHAR(20) NULL,    -- dedupe key 2 (last 10 digits)
        TotalEmployees        INT NULL,
        Status                NVARCHAR(40) NOT NULL DEFAULT 'New',  -- New / Contacted / Proposal Sent / Closed / Lost
        Notes                 NVARCHAR(MAX) NULL,
        CreatedBy             UNIQUEIDENTIFIER NULL,
        CreatedDate           DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate          DATETIME2 NOT NULL DEFAULT GETUTCDATE(),

        CONSTRAINT PK_GroupProspects PRIMARY KEY (GroupProspectId),
        CONSTRAINT FK_GroupProspects_Tenants FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId),
        CONSTRAINT FK_GroupProspects_Agents FOREIGN KEY (AgentId) REFERENCES oe.Agents(AgentId)
    );
    PRINT 'oe.GroupProspects table created';
END
ELSE
    PRINT 'oe.GroupProspects table already exists';
GO

IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.GroupProspects') AND type = 'U')
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_GroupProspects_Tenant_Email' AND object_id = OBJECT_ID('oe.GroupProspects'))
    CREATE INDEX IX_GroupProspects_Tenant_Email ON oe.GroupProspects (TenantId, EmailNormalized);
GO

IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.GroupProspects') AND type = 'U')
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_GroupProspects_Tenant_Agent' AND object_id = OBJECT_ID('oe.GroupProspects'))
    CREATE INDEX IX_GroupProspects_Tenant_Agent ON oe.GroupProspects (TenantId, AgentId);
GO

IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.GroupProspects') AND type = 'U')
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_GroupProspects_Tenant_Company' AND object_id = OBJECT_ID('oe.GroupProspects'))
    CREATE INDEX IX_GroupProspects_Tenant_Company ON oe.GroupProspects (TenantId, CompanyNameNormalized);
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Prospects') AND name = 'GroupProspectId')
BEGIN
    ALTER TABLE oe.Prospects ADD GroupProspectId UNIQUEIDENTIFIER NULL;
    PRINT 'Added GroupProspectId to oe.Prospects';
END
ELSE
    PRINT 'oe.Prospects.GroupProspectId already exists';
GO

-- FK added in a separate batch so the column exists first.
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Prospects') AND name = 'GroupProspectId')
   AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Prospects_GroupProspects')
    ALTER TABLE oe.Prospects ADD CONSTRAINT FK_Prospects_GroupProspects
        FOREIGN KEY (GroupProspectId) REFERENCES oe.GroupProspects(GroupProspectId);
GO

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Prospects') AND name = 'GroupProspectId')
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Prospects_GroupProspect' AND object_id = OBJECT_ID('oe.Prospects'))
    CREATE INDEX IX_Prospects_GroupProspect ON oe.Prospects (GroupProspectId) WHERE GroupProspectId IS NOT NULL;
GO

-------------------------------------------------------------------------------
-- SECTION 2: Tags (agency-shared, colored, many-to-many)
-- A tag belongs to a tenant and (optionally) an agency: AgencyId = NULL means the
-- tag is visible tenant-wide; otherwise it is shared among agents in that agency.
-- Agents create their own tags; a prospect may carry many tags.
-------------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.ProspectTags') AND type = 'U')
BEGIN
    CREATE TABLE oe.ProspectTags (
        ProspectTagId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        TenantId      UNIQUEIDENTIFIER NOT NULL,
        AgencyId      UNIQUEIDENTIFIER NULL,    -- shared within this agency; NULL = tenant-wide
        Name          NVARCHAR(60) NOT NULL,
        Color         NVARCHAR(20) NOT NULL DEFAULT 'gray',  -- palette key (gray/red/orange/amber/green/teal/blue/indigo/purple/pink)
        CreatedBy     UNIQUEIDENTIFIER NULL,
        CreatedDate   DATETIME2 NOT NULL DEFAULT GETUTCDATE(),

        CONSTRAINT PK_ProspectTags PRIMARY KEY (ProspectTagId),
        CONSTRAINT FK_ProspectTags_Tenants FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId)
    );
    PRINT 'oe.ProspectTags table created';
END
ELSE
    PRINT 'oe.ProspectTags table already exists';
GO

IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.ProspectTags') AND type = 'U')
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ProspectTags_Tenant_Agency' AND object_id = OBJECT_ID('oe.ProspectTags'))
    CREATE INDEX IX_ProspectTags_Tenant_Agency ON oe.ProspectTags (TenantId, AgencyId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.ProspectTagAssignments') AND type = 'U')
BEGIN
    CREATE TABLE oe.ProspectTagAssignments (
        ProspectTagAssignmentId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        TenantId      UNIQUEIDENTIFIER NOT NULL,
        ProspectId    UNIQUEIDENTIFIER NOT NULL,
        ProspectTagId UNIQUEIDENTIFIER NOT NULL,
        CreatedBy     UNIQUEIDENTIFIER NULL,
        CreatedDate   DATETIME2 NOT NULL DEFAULT GETUTCDATE(),

        CONSTRAINT PK_ProspectTagAssignments PRIMARY KEY (ProspectTagAssignmentId),
        CONSTRAINT FK_PTA_Prospects FOREIGN KEY (ProspectId) REFERENCES oe.Prospects(ProspectId),
        CONSTRAINT FK_PTA_Tags FOREIGN KEY (ProspectTagId) REFERENCES oe.ProspectTags(ProspectTagId),
        CONSTRAINT UQ_PTA_Prospect_Tag UNIQUE (ProspectId, ProspectTagId)
    );
    PRINT 'oe.ProspectTagAssignments table created';
END
ELSE
    PRINT 'oe.ProspectTagAssignments table already exists';
GO

IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.ProspectTagAssignments') AND type = 'U')
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PTA_Tag' AND object_id = OBJECT_ID('oe.ProspectTagAssignments'))
    CREATE INDEX IX_PTA_Tag ON oe.ProspectTagAssignments (ProspectTagId);
GO

IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.ProspectTagAssignments') AND type = 'U')
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PTA_Prospect' AND object_id = OBJECT_ID('oe.ProspectTagAssignments'))
    CREATE INDEX IX_PTA_Prospect ON oe.ProspectTagAssignments (ProspectId);
GO

-------------------------------------------------------------------------------
-- SECTION 3: Follow-up + last-contacted on prospects
--   NextFollowUpDate  : agent-set reminder date (drives "due/overdue" filter)
--   LastContactedDate : auto-stamped when a communication / proposal / quote goes out
-------------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Prospects') AND name = 'NextFollowUpDate')
BEGIN
    ALTER TABLE oe.Prospects ADD NextFollowUpDate DATETIME2 NULL;
    PRINT 'Added NextFollowUpDate to oe.Prospects';
END
ELSE
    PRINT 'oe.Prospects.NextFollowUpDate already exists';
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Prospects') AND name = 'LastContactedDate')
BEGIN
    ALTER TABLE oe.Prospects ADD LastContactedDate DATETIME2 NULL;
    PRINT 'Added LastContactedDate to oe.Prospects';
END
ELSE
    PRINT 'oe.Prospects.LastContactedDate already exists';
GO

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Prospects') AND name = 'NextFollowUpDate')
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Prospects_Tenant_FollowUp' AND object_id = OBJECT_ID('oe.Prospects'))
    CREATE INDEX IX_Prospects_Tenant_FollowUp ON oe.Prospects (TenantId, NextFollowUpDate) WHERE NextFollowUpDate IS NOT NULL;
GO
