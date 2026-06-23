-- =============================================================================
-- Agent notification / communication preferences
-- Lets an agent subscribe / unsubscribe from specific kinds of notifications.
-- Categories (each a per-agent opt-out bit):
--   * EnrollmentNotificationsOptOut — new enrollment / member-assigned alerts
--     (sending hooks live in the separate enrollment-notifications task)
--   * PaymentAlertsOptOut          — "member payment declined" agent copy
--     (enforced today in queuePaymentFailureNotifications)
--   * MarketingOptOut              — promotional / product-update messages
-- Mirrors oe.MemberCommunicationPreferences. Idempotent (safe to re-run).
-- =============================================================================
SET NOCOUNT ON;

IF OBJECT_ID('oe.AgentCommunicationPreferences', 'U') IS NULL
BEGIN
  CREATE TABLE oe.AgentCommunicationPreferences (
    PreferenceId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    AgentId UNIQUEIDENTIFIER NOT NULL,
    TenantId UNIQUEIDENTIFIER NOT NULL,
    EnrollmentNotificationsOptOut BIT NOT NULL DEFAULT 0,
    PaymentAlertsOptOut BIT NOT NULL DEFAULT 0,
    MarketingOptOut BIT NOT NULL DEFAULT 0,
    OptOutDate DATETIME2 NULL,
    OptOutSource NVARCHAR(50) NULL,
    CreatedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    ModifiedDate DATETIME2 NULL,
    CONSTRAINT PK_AgentCommunicationPreferences PRIMARY KEY CLUSTERED (PreferenceId),
    CONSTRAINT FK_AgentCommunicationPreferences_Agent FOREIGN KEY (AgentId) REFERENCES oe.Agents(AgentId),
    CONSTRAINT FK_AgentCommunicationPreferences_Tenant FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId)
  );
  CREATE UNIQUE INDEX UQ_AgentCommunicationPreferences_AgentId
    ON oe.AgentCommunicationPreferences (AgentId);
  PRINT 'Created oe.AgentCommunicationPreferences';
END
ELSE
BEGIN
  PRINT 'oe.AgentCommunicationPreferences already exists — no change';
END
GO

PRINT 'Done agent communication preferences migration.';
