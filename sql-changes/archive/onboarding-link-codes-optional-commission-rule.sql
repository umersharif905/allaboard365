-- ============================================================================
-- Optional Commission Rule (None) for Onboarding Link Commission Codes
-- ============================================================================
--
-- WHAT THIS DOES (plain English):
--   When you add a commission code (e.g. APPLE, PEACH) to an onboarding link,
--   you can now choose "None" instead of a commission rule. Before, every code
--   had to have a rule.
--
--   - Code WITH a rule: Agent who onboard with that code get that rule assigned
--     (and the code's GrantTierLevel for their tier).
--   - Code with "None": Agent who onboard with that code do NOT get a commission
--     rule from the code; we still use the code's GrantTierLevel for their tier.
--
--   So: commission codes can optionally set a commission rule for the new agent
--   or not. "None" = don't assign a rule from this code.
--
-- REVERT: See onboarding-link-codes-optional-commission-rule-REVERT.sql
--         Run that to undo this migration (after resolving any codes with None).
--
-- ============================================================================

-- 1. Add CommissionCode to AgentOnboardingSessions (for GrantTierLevel lookup when rule is null)
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.AgentOnboardingSessions') AND name = 'CommissionCode'
)
BEGIN
    ALTER TABLE oe.AgentOnboardingSessions ADD CommissionCode NVARCHAR(50) NULL;
    PRINT '✅ Added oe.AgentOnboardingSessions.CommissionCode';
END
GO

-- 2. Drop FK on OnboardingLinkCommissionCodes.CommissionRuleId, make nullable
IF EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_OnboardingLinkCommissionCodes_CommissionRuleId'
      AND parent_object_id = OBJECT_ID('oe.OnboardingLinkCommissionCodes')
)
BEGIN
    ALTER TABLE oe.OnboardingLinkCommissionCodes
    DROP CONSTRAINT FK_OnboardingLinkCommissionCodes_CommissionRuleId;
    PRINT '✅ Dropped FK_OnboardingLinkCommissionCodes_CommissionRuleId';
END
GO

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.OnboardingLinkCommissionCodes') AND name = 'CommissionRuleId'
)
BEGIN
    ALTER TABLE oe.OnboardingLinkCommissionCodes ALTER COLUMN CommissionRuleId UNIQUEIDENTIFIER NULL;
    PRINT '✅ CommissionRuleId nullable';
END
GO

-- 3. sp_AddOnboardingLinkCommissionCode: @CommissionRuleId optional (NULL = None)
CREATE OR ALTER PROCEDURE [oe].[sp_AddOnboardingLinkCommissionCode]
    @LinkId UNIQUEIDENTIFIER,
    @CommissionCode NVARCHAR(50),
    @CommissionRuleId UNIQUEIDENTIFIER = NULL,
    @CreatedBy UNIQUEIDENTIFIER,
    @GrantTierLevel INT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRY
        IF NOT EXISTS (SELECT 1 FROM oe.AgentOnboardingLinks WHERE LinkId = @LinkId)
        BEGIN
            RAISERROR('Onboarding link not found', 16, 1);
            RETURN;
        END

        IF @CommissionRuleId IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM oe.CommissionRules WHERE RuleId = @CommissionRuleId)
        BEGIN
            RAISERROR('Commission rule not found', 16, 1);
            RETURN;
        END

        IF EXISTS (SELECT 1 FROM oe.OnboardingLinkCommissionCodes
                   WHERE LinkId = @LinkId AND CommissionCode = UPPER(TRIM(@CommissionCode)))
        BEGIN
            RAISERROR('Commission code already exists for this link', 16, 1);
            RETURN;
        END

        INSERT INTO oe.OnboardingLinkCommissionCodes (
            LinkId, CommissionCode, CommissionRuleId, CreatedBy, GrantTierLevel
        ) VALUES (
            @LinkId, UPPER(TRIM(@CommissionCode)), @CommissionRuleId, @CreatedBy, @GrantTierLevel
        );

        SELECT 'Success' AS Status, 'Commission code added successfully' AS Message;
    END TRY
    BEGIN CATCH
        SELECT 'Error' AS Status, ERROR_MESSAGE() AS Message;
    END CATCH
END;
GO

-- 4. sp_GetOnboardingLinkCommissionCodes: LEFT JOIN rules, handle NULL rule
CREATE OR ALTER PROCEDURE [oe].[sp_GetOnboardingLinkCommissionCodes]
    @LinkId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT
        olcc.[CodeId],
        olcc.[CommissionCode],
        olcc.[CommissionRuleId],
        cr.[RuleName] AS [CommissionRuleName],
        cr.[CommissionType],
        cr.[CommissionRate],
        cr.[FlatAmount],
        olcc.[IsActive],
        olcc.[GrantTierLevel],
        olcc.[CreatedDate],
        olcc.[ModifiedDate]
    FROM oe.OnboardingLinkCommissionCodes olcc
    LEFT JOIN oe.CommissionRules cr ON olcc.[CommissionRuleId] = cr.[RuleId]
    WHERE olcc.[LinkId] = @LinkId
    ORDER BY olcc.[CreatedDate] ASC;
END;
GO

PRINT '✅ Optional commission rule (None) support added';
