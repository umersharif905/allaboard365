-- History of generated/sent new group forms per group+vendor for tracking and "mark as sent" option.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupNewGroupFormHistory')
BEGIN
    CREATE TABLE oe.GroupNewGroupFormHistory (
        Id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        GroupId UNIQUEIDENTIFIER NOT NULL,
        VendorId UNIQUEIDENTIFIER NOT NULL,
        ActionType NVARCHAR(20) NOT NULL, -- 'Download' | 'Email'
        OccurredAt DATETIME2(0) NOT NULL DEFAULT GETUTCDATE(),
        RecipientEmail NVARCHAR(255) NULL,
        MarkedAsSent BIT NOT NULL DEFAULT 0,
        CreatedBy UNIQUEIDENTIFIER NULL,
        CreatedDate DATETIME2(0) NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT FK_GroupNewGroupFormHistory_Group FOREIGN KEY (GroupId) REFERENCES oe.Groups(GroupId),
        CONSTRAINT FK_GroupNewGroupFormHistory_Vendor FOREIGN KEY (VendorId) REFERENCES oe.Vendors(VendorId)
    );
    CREATE INDEX IX_GroupNewGroupFormHistory_GroupId ON oe.GroupNewGroupFormHistory(GroupId);
    CREATE INDEX IX_GroupNewGroupFormHistory_OccurredAt ON oe.GroupNewGroupFormHistory(OccurredAt DESC);
    PRINT 'Table oe.GroupNewGroupFormHistory created';
END
GO
