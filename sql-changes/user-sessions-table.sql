-- ============================================================================
-- USER SESSIONS: Track refresh-token sessions for list/revoke (HIPAA)
-- ============================================================================
-- Used by /auth login and refresh; list/revoke via /api/me/tenant-admin/user-sessions.
-- ============================================================================

PRINT 'Creating oe.UserSessions if not exists...';

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = N'oe' AND TABLE_NAME = N'UserSessions')
BEGIN
    CREATE TABLE oe.UserSessions (
        SessionId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        UserId UNIQUEIDENTIFIER NOT NULL,
        CreatedAt DATETIME2(0) NOT NULL DEFAULT GETUTCDATE(),
        LastActivityAt DATETIME2(0) NOT NULL DEFAULT GETUTCDATE(),
        UserAgent NVARCHAR(500) NULL,
        RevokedAt DATETIME2(0) NULL,
        CONSTRAINT FK_UserSessions_Users FOREIGN KEY (UserId) REFERENCES oe.Users(UserId)
    );
    CREATE INDEX IX_UserSessions_UserId ON oe.UserSessions(UserId);
    CREATE INDEX IX_UserSessions_RevokedAt ON oe.UserSessions(RevokedAt) WHERE RevokedAt IS NULL;
    PRINT 'Created oe.UserSessions';
END
ELSE
BEGIN
    PRINT 'oe.UserSessions already exists';
END
GO
