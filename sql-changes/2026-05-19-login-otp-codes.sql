-- Login OTP challenges (passwordless mobile / web sign-in)
IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = 'oe' AND t.name = 'LoginOtpCodes'
)
BEGIN
  CREATE TABLE oe.LoginOtpCodes (
    ChallengeId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    UserId UNIQUEIDENTIFIER NOT NULL,
    CodeHash NVARCHAR(128) NOT NULL,
    Channel NVARCHAR(16) NOT NULL,
    Identifier NVARCHAR(256) NULL,
    ExpiresAt DATETIME2 NOT NULL,
    Verified BIT NOT NULL DEFAULT 0,
    Attempts INT NOT NULL DEFAULT 0,
    RequestIp NVARCHAR(64) NULL,
    UserAgent NVARCHAR(512) NULL,
    CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    ConsumedAt DATETIME2 NULL
  );
  CREATE INDEX IX_LoginOtpCodes_UserId_Created ON oe.LoginOtpCodes (UserId, CreatedDate DESC);
  PRINT 'Created oe.LoginOtpCodes';
END
GO
