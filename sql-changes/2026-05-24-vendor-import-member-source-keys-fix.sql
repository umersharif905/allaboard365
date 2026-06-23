-- Fix-up: oe.MemberSourceKeys (prod — FK to oe.Members omitted; add separately off-peak if desired)
--
-- Run this script only. Do NOT run the FK batch on a busy DB — it will lock oe.Members
-- and typically times out (Msg 1222). Import/member linking works without the FK.

IF OBJECT_ID('oe.MemberSourceKeys', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MemberSourceKeys (
    MemberSourceKeyId UNIQUEIDENTIFIER NOT NULL
      CONSTRAINT PK_MemberSourceKeys PRIMARY KEY DEFAULT NEWID(),
    VendorId           UNIQUEIDENTIFIER NOT NULL,
    SourceSystem       NVARCHAR(50)     NOT NULL,
    SourceKey          NVARCHAR(200)    NOT NULL,
    MemberId           UNIQUEIDENTIFIER NOT NULL,
    CreatedDate        DATETIME2        NOT NULL
      CONSTRAINT DF_MemberSourceKeys_CreatedDate DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_MemberSourceKeys_Vendor_Source UNIQUE (VendorId, SourceSystem, SourceKey)
  );
  PRINT 'Created oe.MemberSourceKeys (no FK to oe.Members).';
END
ELSE
  PRINT 'oe.MemberSourceKeys already exists.';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id = OBJECT_ID('oe.MemberSourceKeys') AND name = 'IX_MemberSourceKeys_MemberId'
)
BEGIN
  CREATE INDEX IX_MemberSourceKeys_MemberId ON oe.MemberSourceKeys (MemberId);
  PRINT 'Created IX_MemberSourceKeys_MemberId.';
END
GO

PRINT 'MemberSourceKeys fix-up complete. FK is optional — see 2026-05-24-vendor-import-member-source-keys-fk-optional.sql';
