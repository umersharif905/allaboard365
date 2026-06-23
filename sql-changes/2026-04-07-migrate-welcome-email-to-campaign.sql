-- =============================================
-- Migrate Welcome Email Template to Campaigns
-- For each tenant with a WelcomeEmailTemplateId in TenantSettings,
-- create an oe.Campaigns row (TriggerType='EnrollmentCompletion') and
-- a corresponding oe.CampaignSteps row (StepOrder=1, DelayDays=0).
-- =============================================

SET NOCOUNT ON;

DECLARE @TenantId         UNIQUEIDENTIFIER;
DECLARE @TemplateIdStr    NVARCHAR(200);
DECLARE @TemplateId       UNIQUEIDENTIFIER;
DECLARE @NewCampaignId    UNIQUEIDENTIFIER;
DECLARE @InsertedCampaigns INT = 0;
DECLARE @InsertedSteps     INT = 0;

-- Cursor over all tenants that have a non-empty WelcomeEmailTemplateId setting
DECLARE tenant_cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT TenantId, SettingValue
    FROM oe.TenantSettings
    WHERE SettingKey = 'WelcomeEmailTemplateId'
      AND SettingValue IS NOT NULL
      AND LTRIM(RTRIM(SettingValue)) <> '';

OPEN tenant_cur;
FETCH NEXT FROM tenant_cur INTO @TenantId, @TemplateIdStr;

WHILE @@FETCH_STATUS = 0
BEGIN
    -- Validate the stored value is a well-formed GUID
    IF TRY_CAST(@TemplateIdStr AS UNIQUEIDENTIFIER) IS NULL
    BEGIN
        PRINT 'WARNING: TenantId ' + CAST(@TenantId AS NVARCHAR(36))
              + ' has invalid WelcomeEmailTemplateId value: ' + @TemplateIdStr + ' — skipped.';
        FETCH NEXT FROM tenant_cur INTO @TenantId, @TemplateIdStr;
        CONTINUE;
    END;

    SET @TemplateId = CAST(@TemplateIdStr AS UNIQUEIDENTIFIER);

    -- Skip if a Welcome Campaign for this tenant already exists
    -- (idempotent: safe to re-run)
    IF EXISTS (
        SELECT 1 FROM oe.Campaigns
        WHERE TenantId = @TenantId
          AND CampaignName = 'Welcome Campaign'
          AND TriggerType  = 'EnrollmentCompletion'
    )
    BEGIN
        PRINT 'SKIP: TenantId ' + CAST(@TenantId AS NVARCHAR(36))
              + ' already has a Welcome Campaign — skipped.';
        FETCH NEXT FROM tenant_cur INTO @TenantId, @TemplateIdStr;
        CONTINUE;
    END;

    -- Insert Campaign
    SET @NewCampaignId = NEWID();

    INSERT INTO oe.Campaigns (CampaignId, TenantId, CampaignName, TriggerType, IsActive, CreatedDate, CreatedBy)
    VALUES (@NewCampaignId, @TenantId, 'Welcome Campaign', 'EnrollmentCompletion', 1, SYSUTCDATETIME(), NULL);

    SET @InsertedCampaigns = @InsertedCampaigns + 1;

    -- Insert CampaignStep
    INSERT INTO oe.CampaignSteps (StepId, CampaignId, StepOrder, DelayDays, EmailTemplateId, SmsTemplateId, IsActive, CreatedDate)
    VALUES (NEWID(), @NewCampaignId, 1, 0, @TemplateId, NULL, 1, SYSUTCDATETIME());

    SET @InsertedSteps = @InsertedSteps + 1;

    PRINT 'CREATED: TenantId ' + CAST(@TenantId AS NVARCHAR(36))
          + ' → CampaignId ' + CAST(@NewCampaignId AS NVARCHAR(36))
          + ' (EmailTemplateId=' + CAST(@TemplateId AS NVARCHAR(36)) + ')';

    FETCH NEXT FROM tenant_cur INTO @TenantId, @TemplateIdStr;
END;

CLOSE tenant_cur;
DEALLOCATE tenant_cur;

PRINT '';
PRINT 'Done. Campaigns inserted: ' + CAST(@InsertedCampaigns AS NVARCHAR(10))
      + ', CampaignSteps inserted: ' + CAST(@InsertedSteps AS NVARCHAR(10));

-- =============================================
-- SystemSettings notice
-- =============================================
DECLARE @DefaultTemplateId NVARCHAR(200);
SELECT @DefaultTemplateId = SettingValue
FROM oe.SystemSettings
WHERE SettingKey = 'DefaultWelcomeEmailTemplateId'
  AND SettingValue IS NOT NULL
  AND LTRIM(RTRIM(SettingValue)) <> '';

IF @DefaultTemplateId IS NOT NULL
BEGIN
    PRINT '';
    PRINT 'NOTICE: oe.SystemSettings contains DefaultWelcomeEmailTemplateId = '
          + @DefaultTemplateId + '.';
    PRINT '        This global fallback is NOT automatically migrated because it is not';
    PRINT '        tenant-scoped. Review whether any tenants rely on this default and';
    PRINT '        create a Campaign row for them manually if needed.';
END;
