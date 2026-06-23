-- ============================================================================
-- WEBSITE FORM SUBMISSIONS: log + attribution for public-site lead capture
-- ============================================================================
-- Stores one row per quote/contact submission received from a tenant's
-- public website. Used for:
--   * Daily per-tenant digest emails (counts, by-agent breakdown, anomalies)
--   * Future lead-tracking dashboards
--   * Audit of attribution lookup outcomes
--
-- Inserted by POST /api/website-form-submissions (called from each tenant's
-- website server using a tenant API key). TenantId derives from the API key,
-- never the request body, so cross-tenant writes are not possible.
--
-- PII boundary: stores submitter contact info (name, email, phone, state,
-- companyName) only. Does NOT store age/DOB/coverage type/free-text messages
-- — those stay in the email itself.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'WebsiteFormSubmissions' AND schema_id = SCHEMA_ID('oe'))
BEGIN
  CREATE TABLE oe.WebsiteFormSubmissions (
    SubmissionId        UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    TenantId            UNIQUEIDENTIFIER NOT NULL,

    -- Form metadata
    Source              NVARCHAR(20)  NOT NULL,           -- 'quote' | 'contact'
    FormType            NVARCHAR(20)  NULL,               -- 'employer' | 'individual' | NULL for contact
    Subject             NVARCHAR(300) NULL,               -- email subject (for reference)

    -- Attribution
    AttemptedAgentId    NVARCHAR(100) NULL,               -- raw ?id= from URL
    AttemptedAgentName  NVARCHAR(200) NULL,               -- raw ?name= from URL
    MatchStatus         NVARCHAR(30)  NOT NULL,           -- matched|not_found|ambiguous_id|ambiguous_name|error|unconfigured|no_attribution
    MatchedAgentId      UNIQUEIDENTIFIER NULL,            -- FK to oe.Agents.AgentId (nullable)
    MatchedAgentCode    NVARCHAR(50)  NULL,
    MatchedAgentEmail   NVARCHAR(200) NULL,

    -- Submitter contact (minimal PII for lead tracking)
    SubmitterName       NVARCHAR(200) NULL,
    SubmitterEmail      NVARCHAR(200) NULL,
    SubmitterPhone      NVARCHAR(50)  NULL,
    SubmitterState      NVARCHAR(50)  NULL,
    SubmitterCompany    NVARCHAR(200) NULL,

    -- Delivery + audit
    EmailSendStatus     NVARCHAR(20)  NULL,               -- sent|failed|skipped
    EmailFailureReason  NVARCHAR(500) NULL,
    IpAddress           NVARCHAR(64)  NULL,
    UserAgent           NVARCHAR(500) NULL,

    SubmittedAt         DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_WebsiteFormSubmissions_Tenant FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId),
    CONSTRAINT FK_WebsiteFormSubmissions_Agent  FOREIGN KEY (MatchedAgentId) REFERENCES oe.Agents(AgentId)
  );

  CREATE INDEX IX_WebsiteFormSubmissions_Tenant_Date ON oe.WebsiteFormSubmissions (TenantId, SubmittedAt DESC);
  CREATE INDEX IX_WebsiteFormSubmissions_MatchedAgent ON oe.WebsiteFormSubmissions (MatchedAgentId) WHERE MatchedAgentId IS NOT NULL;
  CREATE INDEX IX_WebsiteFormSubmissions_MatchStatus ON oe.WebsiteFormSubmissions (TenantId, MatchStatus, SubmittedAt DESC);
END;
