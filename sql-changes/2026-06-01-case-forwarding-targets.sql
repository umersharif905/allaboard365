-- =============================================================================
-- Migration: create oe.CaseForwardingTargets
-- Date:      2026-06-01
-- Branch:    fix/backoffice/combining-communications-and-encounters
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Adds oe.CaseForwardingTargets: per-(care-team-vendor) routing config that
--   maps a member's PLAN vendor (e.g. ARM, Tall Tree) to a comma-separated
--   list of forwarding email addresses and an email template. Used to detect
--   which reimbursement cases can be forwarded to a TPA and to build the email.
--
-- WHY (BUSINESS CONTEXT)
-- ----------------------
--   Preventative reimbursement requests arrive as cases; verified cases must be
--   emailed to the appropriate TPA. Config lives here so VendorAdmins manage the
--   recipient list/template per environment without code changes.
--
-- IDEMPOTENCY
-- -----------
--   The CREATE is guarded by an existence check; safe to re-run.
--
-- ROLLBACK
-- --------
--   DROP TABLE oe.CaseForwardingTargets;
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'CaseForwardingTargets'
)
BEGIN
    CREATE TABLE oe.CaseForwardingTargets (
        TargetId         UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_CFT_TargetId DEFAULT NEWID(),
        VendorId         UNIQUEIDENTIFIER NOT NULL,   -- operating care-team vendor (tenant isolation)
        PlanVendorId     UNIQUEIDENTIFIER NOT NULL,   -- the TPA whose plans trigger forwarding
        Label            NVARCHAR(100)    NOT NULL,
        ForwardingEmails NVARCHAR(1000)   NOT NULL,   -- comma-separated list
        TemplateId       UNIQUEIDENTIFIER NULL,       -- FK -> oe.MessageTemplates
        IsActive         BIT              NOT NULL CONSTRAINT DF_CFT_IsActive DEFAULT 1,
        CreatedDate      DATETIME2        NOT NULL CONSTRAINT DF_CFT_Created DEFAULT SYSUTCDATETIME(),
        CreatedBy        UNIQUEIDENTIFIER NULL,
        ModifiedDate     DATETIME2        NULL,
        ModifiedBy       UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_CaseForwardingTargets PRIMARY KEY (TargetId)
    );

    CREATE UNIQUE INDEX UX_CFT_Vendor_PlanVendor
        ON oe.CaseForwardingTargets (VendorId, PlanVendorId);
    CREATE INDEX IX_CFT_Vendor_Active
        ON oe.CaseForwardingTargets (VendorId, IsActive);

    PRINT 'Created table oe.CaseForwardingTargets.';
END
ELSE
BEGIN
    PRINT 'Table oe.CaseForwardingTargets already exists — skipping.';
END
GO
