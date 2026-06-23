-- ============================================================================
-- REVERT: Optional Commission Rule (None) for Onboarding Link Commission Codes
-- ============================================================================
-- Run this to undo onboarding-link-codes-optional-commission-rule.sql
--
-- PREREQUISITE: No commission codes can have CommissionRuleId = NULL.
--   If any do, delete them or assign a rule first, then run this revert.
-- ============================================================================

SET NOCOUNT ON;

-- 0. Check for codes with NULL rule — must fix before reverting
IF EXISTS (SELECT 1 FROM oe.OnboardingLinkCommissionCodes WHERE CommissionRuleId IS NULL)
BEGIN
    RAISERROR(
        'REVERT BLOCKED: Found commission codes with CommissionRuleId NULL. '
        + 'Delete those codes or assign a rule, then re-run this script.',
        16, 1
    );
    RETURN;
END
GO

-- 1. Restore sp_AddOnboardingLinkCommissionCode (require CommissionRuleId again)
CREATE OR ALTER PROCEDURE [oe].[sp_AddOnboardingLinkCommissionCode]
    @LinkId UNIQUEIDENTIFIER,
    @CommissionCode NVARCHAR(50),
    @CommissionRuleId UNIQUEIDENTIFIER,
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

        IF NOT EXISTS (SELECT 1 FROM oe.CommissionRules WHERE RuleId = @CommissionRuleId)
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

-- 2. Restore sp_GetOnboardingLinkCommissionCodes (INNER JOIN rules again)
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
    INNER JOIN oe.CommissionRules cr ON olcc.[CommissionRuleId] = cr.[RuleId]
    WHERE olcc.[LinkId] = @LinkId
    ORDER BY olcc.[CreatedDate] ASC;
END;
GO

-- 3. Make CommissionRuleId NOT NULL again
ALTER TABLE oe.OnboardingLinkCommissionCodes
    ALTER COLUMN CommissionRuleId UNIQUEIDENTIFIER NOT NULL;
PRINT '✅ CommissionRuleId NOT NULL restored';

-- 4. Re-add FK to CommissionRules
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_OnboardingLinkCommissionCodes_CommissionRuleId'
      AND parent_object_id = OBJECT_ID('oe.OnboardingLinkCommissionCodes')
)
BEGIN
    ALTER TABLE oe.OnboardingLinkCommissionCodes
    ADD CONSTRAINT FK_OnboardingLinkCommissionCodes_CommissionRuleId
        FOREIGN KEY (CommissionRuleId) REFERENCES oe.CommissionRules(RuleId);
    PRINT '✅ FK_OnboardingLinkCommissionCodes_CommissionRuleId restored';
END
GO

-- 5. Drop CommissionCode from AgentOnboardingSessions
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.AgentOnboardingSessions') AND name = 'CommissionCode'
)
BEGIN
    ALTER TABLE oe.AgentOnboardingSessions DROP COLUMN CommissionCode;
    PRINT '✅ Dropped oe.AgentOnboardingSessions.CommissionCode';
END
GO

PRINT '✅ Revert complete. Optional commission rule (None) support removed.';
