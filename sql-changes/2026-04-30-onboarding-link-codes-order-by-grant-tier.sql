-- Order onboarding-link commission codes by grant tier (lowest first), then code name.
-- Aligns API consumers with UI (AgentsPage + CommissionCodesManager).

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
    olcc.[CommissionGroupId],
    cg.[Name] AS [CommissionGroupName],
    olcc.[IsActive],
    olcc.[GrantTierLevel],
    olcc.[CreatedDate],
    olcc.[ModifiedDate]
  FROM oe.OnboardingLinkCommissionCodes olcc
  LEFT JOIN oe.CommissionRules cr ON olcc.[CommissionRuleId] = cr.[RuleId]
  LEFT JOIN oe.CommissionGroups cg ON olcc.[CommissionGroupId] = cg.[CommissionGroupId]
  WHERE olcc.[LinkId] = @LinkId
  ORDER BY ISNULL(olcc.[GrantTierLevel], 999) ASC, olcc.[CommissionCode] ASC, olcc.[CreatedDate] ASC;
END;
GO
