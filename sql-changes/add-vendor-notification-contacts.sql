-- Migration: Add oe.VendorNotificationContacts for additional notification recipients
-- Used for NACHA files, eligibility files, and new group form emails

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'VendorNotificationContacts' AND schema_id = SCHEMA_ID('oe'))
BEGIN
    CREATE TABLE oe.VendorNotificationContacts (
        VendorNotificationContactId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        VendorId UNIQUEIDENTIFIER NOT NULL,
        Name NVARCHAR(255) NULL,
        Email NVARCHAR(255) NOT NULL,
        SortOrder INT NULL,
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT PK_VendorNotificationContacts PRIMARY KEY (VendorNotificationContactId),
        CONSTRAINT FK_VendorNotificationContacts_Vendor FOREIGN KEY (VendorId) REFERENCES oe.Vendors (VendorId)
    );

    CREATE INDEX IX_VendorNotificationContacts_VendorId ON oe.VendorNotificationContacts (VendorId);

    PRINT 'oe.VendorNotificationContacts table created';
END
ELSE
BEGIN
    PRINT 'oe.VendorNotificationContacts table already exists';
END
GO
