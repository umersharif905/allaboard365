-- ============================================================================
-- Add GrantTierLevel to OnboardingLinkCommissionCodes
-- ============================================================================
-- Optional: when an agent completes onboarding with this commission code,
-- set oe.Agents.CommissionTierLevel to this value (e.g. 0 = Agent, 1 = Agency).
-- ============================================================================

-- Add column if not present
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.OnboardingLinkCommissionCodes')
    AND name = 'GrantTierLevel'
)
BEGIN
    ALTER TABLE oe.OnboardingLinkCommissionCodes
    ADD GrantTierLevel INT NULL;

    PRINT '✅ Added column oe.OnboardingLinkCommissionCodes.GrantTierLevel';
END
ELSE
BEGIN
    PRINT '⚠️  Column GrantTierLevel already exists on oe.OnboardingLinkCommissionCodes';
END
GO

-- Update sp_AddOnboardingLinkCommissionCode to accept @GrantTierLevel
CREATE OR ALTER PROCEDURE [oe].[sp_AddOnboardingLinkCommissionCode]
    @LinkId uniqueidentifier,
    @CommissionCode nvarchar(50),
    @CommissionRuleId uniqueidentifier,
    @CreatedBy uniqueidentifier,
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

-- Update sp_GetOnboardingLinkCommissionCodes to return GrantTierLevel
CREATE OR ALTER PROCEDURE [oe].[sp_GetOnboardingLinkCommissionCodes]
    @LinkId uniqueidentifier
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

PRINT '✅ GrantTierLevel support added for onboarding link commission codes';
