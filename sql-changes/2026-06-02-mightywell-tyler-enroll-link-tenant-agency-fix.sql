-- Migration: Fix MightyWELL Enroll Link tenant/agency (was Pinnacle Life Group)
-- Date: 2026-06-02
-- Author: Jeremy Francis
--
-- Prod finding: Tyler Clackum (tyler@mightywellhealth.com) at MightyWELL Health LLC owns
-- link 25BF3CF4-DFEE-4275-9999-C188070B1331 ("MightyWELL Enroll Link") but Link.TenantId/AgencyId
-- pointed to Pinnacle Life Group / Pinnacle Wellness LLC. New downlines would enroll under wrong tenant.

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @LinkId UNIQUEIDENTIFIER = '25BF3CF4-DFEE-4275-9999-C188070B1331';
DECLARE @OwnerAgentId UNIQUEIDENTIFIER = 'A88E3E2B-41AD-44F9-9885-1E36BF2130F6';
DECLARE @OwnerEmail NVARCHAR(256) = 'tyler@mightywellhealth.com';

DECLARE @CorrectTenantId UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';  -- MightyWELL Health
DECLARE @CorrectAgencyId UNIQUEIDENTIFIER = '4532C6DC-1290-4A4A-A1A7-533497694265';  -- MightyWELL Health LLC

DECLARE @WrongTenantId UNIQUEIDENTIFIER = '55EB7262-4DB6-4614-82A8-23FC2E91203B';  -- Pinnacle Life Group
DECLARE @WrongAgencyId UNIQUEIDENTIFIER = '3BD2BE1C-EB7E-4D6A-93AA-3453C5809EF3';  -- Pinnacle Wellness LLC

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (
        SELECT 1
        FROM oe.AgentOnboardingLinks l
        INNER JOIN oe.Agents a ON a.AgentId = l.AgentId
        INNER JOIN oe.Users u ON u.UserId = a.UserId
        WHERE l.LinkId = @LinkId
          AND l.AgentId = @OwnerAgentId
          AND LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(RTRIM(@OwnerEmail)))
          AND l.TenantId = @WrongTenantId
          AND l.AgencyId = @WrongAgencyId
    )
    BEGIN
        ROLLBACK TRANSACTION;
        RAISERROR('Safety check failed: link not in expected wrong tenant/agency state (may already be fixed).', 16, 1);
        RETURN;
    END;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Current (wrong) link row:' AS [Status];

        SELECT
            l.LinkId,
            l.LinkName,
            l.LinkToken,
            l.IsActive,
            l.AgentId,
            l.TenantId,
            t.Name AS TenantName,
            l.AgencyId,
            ag.AgencyName,
            u.Email AS OwnerEmail
        FROM oe.AgentOnboardingLinks l
        INNER JOIN oe.Agents a ON a.AgentId = l.AgentId
        INNER JOIN oe.Users u ON u.UserId = a.UserId
        LEFT JOIN oe.Tenants t ON t.TenantId = l.TenantId
        LEFT JOIN oe.Agencies ag ON ag.AgencyId = l.AgencyId
        WHERE l.LinkId = @LinkId;

        SELECT 'DRY RUN - After fix (preview):' AS [Status];

        SELECT
            @LinkId AS LinkId,
            @CorrectTenantId AS TenantId,
            t.Name AS TenantName,
            @CorrectAgencyId AS AgencyId,
            ag.AgencyName
        FROM oe.Tenants t
        CROSS JOIN oe.Agencies ag
        WHERE t.TenantId = @CorrectTenantId
          AND ag.AgencyId = @CorrectAgencyId;

        SELECT 'DRY RUN - Commission codes on link (unchanged):' AS [Status];

        SELECT
            c.CodeId,
            c.CommissionCode,
            c.GrantTierLevel,
            c.IsActive
        FROM oe.OnboardingLinkCommissionCodes c
        WHERE c.LinkId = @LinkId;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    UPDATE oe.AgentOnboardingLinks
    SET
        TenantId = @CorrectTenantId,
        AgencyId = @CorrectAgencyId,
        ModifiedDate = GETUTCDATE()
    WHERE LinkId = @LinkId
      AND AgentId = @OwnerAgentId
      AND TenantId = @WrongTenantId
      AND AgencyId = @WrongAgencyId;

    SELECT @@ROWCOUNT AS UpdatedLinkCount;

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
