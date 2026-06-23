-- Store Agent and Group Admin signatures for New Group Form certification (sign at different times).
-- One row per group. Used when generating the PDF to show signatures and dates.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupNewGroupFormCertification')
BEGIN
    CREATE TABLE oe.GroupNewGroupFormCertification (
        GroupId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        AgentSignatureData NVARCHAR(MAX) NULL,   -- base64 data URL or typed text
        AgentSignedAt DATETIME2(0) NULL,
        AgentSignedBy UNIQUEIDENTIFIER NULL,
        GroupAdminSignatureData NVARCHAR(MAX) NULL,
        GroupAdminSignedAt DATETIME2(0) NULL,
        GroupAdminSignedBy UNIQUEIDENTIFIER NULL,
        CreatedDate DATETIME2(0) NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2(0) NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT FK_GroupNewGroupFormCertification_Group FOREIGN KEY (GroupId) REFERENCES oe.Groups(GroupId)
    );
    PRINT 'Table oe.GroupNewGroupFormCertification created';
END
GO
