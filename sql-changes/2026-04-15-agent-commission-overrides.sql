-- 2026-04-15 Agent Commission Overrides
-- Personal agent-to-agent override: redirect a fixed $ or % of Agent A's
-- per-payment commission to Agent B. Rare case, tenant-admin managed.

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'AgentCommissionOverrides'
)
BEGIN
    CREATE TABLE oe.AgentCommissionOverrides (
        OverrideId         UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        TenantId           UNIQUEIDENTIFIER NOT NULL,
        SourceAgentId      UNIQUEIDENTIFIER NOT NULL,
        RecipientAgentId   UNIQUEIDENTIFIER NOT NULL,
        OverrideType       NVARCHAR(20)     NOT NULL,
        OverrideAmount     DECIMAL(18,2)    NULL,
        OverridePercentage DECIMAL(9,6)     NULL,
        EffectiveDate      DATE             NULL,
        TerminationDate    DATE             NULL,
        Status             NVARCHAR(20)     NOT NULL DEFAULT 'Active',
        Notes              NVARCHAR(500)    NULL,
        CreatedDate        DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CreatedBy          UNIQUEIDENTIFIER NULL,
        ModifiedDate       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        ModifiedBy         UNIQUEIDENTIFIER NULL,
        CONSTRAINT CK_AgentOverride_NotSelf CHECK (SourceAgentId <> RecipientAgentId),
        CONSTRAINT CK_AgentOverride_HasAmount CHECK (
            (OverrideType = 'Fixed'      AND OverrideAmount     IS NOT NULL AND OverrideAmount     > 0) OR
            (OverrideType = 'Percentage' AND OverridePercentage IS NOT NULL AND OverridePercentage > 0 AND OverridePercentage <= 100)
        )
    );

    CREATE INDEX IX_AgentCommissionOverrides_Source
        ON oe.AgentCommissionOverrides(SourceAgentId, Status);

    CREATE INDEX IX_AgentCommissionOverrides_Tenant
        ON oe.AgentCommissionOverrides(TenantId, Status);

    PRINT 'Created oe.AgentCommissionOverrides table.';
END
ELSE
BEGIN
    PRINT 'oe.AgentCommissionOverrides already exists. Skipping.';
END
