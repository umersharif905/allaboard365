-- Migration: Add manual onboarding completion flag to oe.Groups
-- Allows Agent/TenantAdmin/SysAdmin to mark group onboarding complete without a used link

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.Groups') AND name = 'OnboardingMarkedComplete'
)
BEGIN
    ALTER TABLE oe.Groups
    ADD OnboardingMarkedComplete BIT NOT NULL DEFAULT 0;

    ALTER TABLE oe.Groups
    ADD OnboardingMarkedCompleteAt DATETIME2 NULL;

    ALTER TABLE oe.Groups
    ADD OnboardingMarkedCompleteBy UNIQUEIDENTIFIER NULL;

    PRINT 'OnboardingMarkedComplete columns added to oe.Groups';
END
ELSE
BEGIN
    PRINT 'OnboardingMarkedComplete columns already exist on oe.Groups';
END
GO
