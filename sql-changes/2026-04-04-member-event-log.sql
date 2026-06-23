-- Member audit trail for administrative actions (e.g. group assignment changes)
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'MemberEventLog'
)
BEGIN
    CREATE TABLE oe.MemberEventLog (
        EventId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MemberEventLog PRIMARY KEY DEFAULT NEWID(),
        MemberId UNIQUEIDENTIFIER NOT NULL,
        EventType NVARCHAR(64) NOT NULL,
        OldGroupId UNIQUEIDENTIFIER NULL,
        NewGroupId UNIQUEIDENTIFIER NULL,
        OldGroupName NVARCHAR(500) NULL,
        NewGroupName NVARCHAR(500) NULL,
        EventDetails NVARCHAR(MAX) NULL,
        CreatedBy UNIQUEIDENTIFIER NULL,
        CreatedDate DATETIME2 NOT NULL CONSTRAINT DF_MemberEventLog_CreatedDate DEFAULT SYSUTCDATETIME()
    );
    CREATE INDEX IX_MemberEventLog_MemberId_CreatedDate ON oe.MemberEventLog (MemberId, CreatedDate DESC);
END
GO
