-- Migration: Remove orphan onboarding commission codes for Tyler Clackum (MightyWELL Enroll Link)
-- Date: 2026-06-02
-- Author: Jeremy Francis
-- Orphan GrantTierLevel values (-2, -1, -0.7, -0.5) are not in tenant oe.CommissionLevels SortOrder set.

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @LinkId UNIQUEIDENTIFIER = '25BF3CF4-DFEE-4275-9999-C188070B1331';
DECLARE @TenantId UNIQUEIDENTIFIER = '55EB7262-4DB6-4614-82A8-23FC2E91203B';
DECLARE @OwnerAgentId UNIQUEIDENTIFIER = 'A88E3E2B-41AD-44F9-9885-1E36BF2130F6';
DECLARE @OwnerEmail NVARCHAR(256) = 'tyler@mightywellhealth.com';

BEGIN TRY
    BEGIN TRANSACTION;

    -- Safety: confirm link owner
    IF NOT EXISTS (
        SELECT 1
        FROM oe.AgentOnboardingLinks l
        INNER JOIN oe.Agents a ON a.AgentId = l.AgentId
        INNER JOIN oe.Users u ON u.UserId = a.UserId
        WHERE l.LinkId = @LinkId
          AND l.TenantId = @TenantId
          AND l.AgentId = @OwnerAgentId
          AND LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(RTRIM(@OwnerEmail)))
    )
    BEGIN
        ROLLBACK TRANSACTION;
        RAISERROR('Safety check failed: link/owner/email mismatch.', 16, 1);
        RETURN;
    END;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Orphan codes to DELETE:' AS [Status];

        SELECT
            c.CodeId,
            c.CommissionCode,
            c.GrantTierLevel,
            c.IsActive,
            c.CreatedDate
        FROM oe.OnboardingLinkCommissionCodes c
        WHERE c.LinkId = @LinkId
          AND c.GrantTierLevel IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM oe.CommissionLevels cl
              WHERE cl.TenantId = @TenantId
                AND cl.IsActive = 1
                AND ABS(CAST(cl.SortOrder AS FLOAT) - CAST(c.GrantTierLevel AS FLOAT)) < 0.0001
          );

        SELECT 'DRY RUN - Codes that will REMAIN:' AS [Status];

        SELECT
            c.CodeId,
            c.CommissionCode,
            c.GrantTierLevel,
            c.IsActive
        FROM oe.OnboardingLinkCommissionCodes c
        WHERE c.LinkId = @LinkId
          AND (
              c.GrantTierLevel IS NULL
              OR EXISTS (
                  SELECT 1
                  FROM oe.CommissionLevels cl
                  WHERE cl.TenantId = @TenantId
                    AND cl.IsActive = 1
                    AND ABS(CAST(cl.SortOrder AS FLOAT) - CAST(c.GrantTierLevel AS FLOAT)) < 0.0001
              )
          );

        ROLLBACK TRANSACTION;
        RETURN;
    END

    DELETE c
    FROM oe.OnboardingLinkCommissionCodes c
    WHERE c.LinkId = @LinkId
      AND c.GrantTierLevel IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM oe.CommissionLevels cl
          WHERE cl.TenantId = @TenantId
            AND cl.IsActive = 1
            AND ABS(CAST(cl.SortOrder AS FLOAT) - CAST(c.GrantTierLevel AS FLOAT)) < 0.0001
      );

    SELECT @@ROWCOUNT AS DeletedOrphanCodeCount;

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
