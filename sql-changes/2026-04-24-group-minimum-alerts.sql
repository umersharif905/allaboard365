-- 2026-04-24-group-minimum-alerts.sql
IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE Name = 'GroupMinimumAlerts' AND schema_id = SCHEMA_ID('oe')
)
BEGIN
  CREATE TABLE oe.GroupMinimumAlerts (
    AlertId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_GroupMinimumAlerts PRIMARY KEY DEFAULT NEWID(),
    GroupId        UNIQUEIDENTIFIER NOT NULL,
    TenantId       UNIQUEIDENTIFIER NOT NULL,
    EffectiveDate  DATE             NOT NULL,
    AlertType      NVARCHAR(20)     NOT NULL, -- 'Warning' | 'Lock'
    SentAt         DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_GroupMinimumAlerts_Unique
      UNIQUE (GroupId, EffectiveDate, AlertType),
    CONSTRAINT CK_GroupMinimumAlerts_AlertType
      CHECK (AlertType IN ('Warning','Lock'))
  );
END
GO
