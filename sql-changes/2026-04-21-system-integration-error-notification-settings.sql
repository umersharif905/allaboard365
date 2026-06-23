-- 2026-04-21-system-integration-error-notification-settings.sql
--
-- Seed the SystemSettings row that controls who receives the 15-minute
-- SystemIntegrationErrors digest email. Value is a comma-separated list
-- of addresses; empty string disables the digest.
--
-- Idempotent: safe to re-run.

IF NOT EXISTS (
    SELECT 1 FROM oe.SystemSettings WHERE SettingKey = N'system.integration_error_notification_emails'
)
BEGIN
    INSERT INTO oe.SystemSettings
        (SettingKey, SettingValue, SettingType, Category, Description, IsReadOnly, DefaultValue, CreatedDate, ModifiedDate)
    VALUES
        (
            N'system.integration_error_notification_emails',
            N'improve@allaboard365.com',
            N'text',
            N'notifications',
            N'Comma-separated list of email addresses that receive the 15-minute SystemIntegrationErrors digest (high and critical priority only). Leave blank to disable the digest.',
            0,
            N'improve@allaboard365.com',
            GETDATE(),
            GETDATE()
        );
END
GO
