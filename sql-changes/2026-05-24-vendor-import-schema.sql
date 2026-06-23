-- Vendor import schema: member source keys, share request legacy map, import jobs, product map, pending queue
-- Also Phase 5 hook: Tenants.IsExternal

IF NOT EXISTS (
  SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Tenants') AND name = 'IsExternal'
)
BEGIN
  ALTER TABLE oe.Tenants ADD IsExternal BIT NOT NULL CONSTRAINT DF_Tenants_IsExternal DEFAULT 0;
  PRINT 'Added oe.Tenants.IsExternal';
END
GO

-- No inline FK to oe.Members (lock timeout on busy prod). Optional FK:
--   sql-changes/2026-05-24-vendor-import-member-source-keys-fk-optional.sql
IF OBJECT_ID('oe.MemberSourceKeys', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MemberSourceKeys (
    MemberSourceKeyId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MemberSourceKeys PRIMARY KEY DEFAULT NEWID(),
    VendorId           UNIQUEIDENTIFIER NOT NULL,
    SourceSystem       NVARCHAR(50)     NOT NULL,
    SourceKey          NVARCHAR(200)    NOT NULL,
    MemberId           UNIQUEIDENTIFIER NOT NULL,
    CreatedDate        DATETIME2        NOT NULL CONSTRAINT DF_MemberSourceKeys_CreatedDate DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_MemberSourceKeys_Vendor_Source UNIQUE (VendorId, SourceSystem, SourceKey)
  );
  CREATE INDEX IX_MemberSourceKeys_MemberId ON oe.MemberSourceKeys (MemberId);
  PRINT 'Created oe.MemberSourceKeys';
END
GO

-- No inline FK to oe.ShareRequests (lock timeout on busy prod). Optional FK:
--   sql-changes/2026-05-24-vendor-import-share-request-legacy-map-fk-optional.sql
IF OBJECT_ID('oe.ShareRequestLegacyMap', 'U') IS NULL
BEGIN
  CREATE TABLE oe.ShareRequestLegacyMap (
    LegacyMapId          UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_ShareRequestLegacyMap PRIMARY KEY DEFAULT NEWID(),
    VendorId             UNIQUEIDENTIFIER NOT NULL,
    LegacyShareRequestId NVARCHAR(100)    NOT NULL,
    ShareRequestId       UNIQUEIDENTIFIER NOT NULL,
    CreatedDate          DATETIME2        NOT NULL CONSTRAINT DF_ShareRequestLegacyMap_Created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_ShareRequestLegacyMap_Vendor_Legacy UNIQUE (VendorId, LegacyShareRequestId)
  );
  PRINT 'Created oe.ShareRequestLegacyMap';
END
GO

IF OBJECT_ID('oe.VendorImportJobs', 'U') IS NULL
BEGIN
  CREATE TABLE oe.VendorImportJobs (
    JobId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_VendorImportJobs PRIMARY KEY DEFAULT NEWID(),
    VendorId     UNIQUEIDENTIFIER NOT NULL,
    TenantId     UNIQUEIDENTIFIER NULL,
    JobType      NVARCHAR(50)     NOT NULL,
    Status       NVARCHAR(30)     NOT NULL CONSTRAINT DF_VendorImportJobs_Status DEFAULT N'draft',
    FileName     NVARCHAR(500)    NULL,
    SummaryJson  NVARCHAR(MAX)    NULL,
    CreatedBy    UNIQUEIDENTIFIER NULL,
    CreatedDate  DATETIME2        NOT NULL CONSTRAINT DF_VendorImportJobs_Created DEFAULT SYSUTCDATETIME(),
    ModifiedDate DATETIME2        NULL,
    CompletedDate DATETIME2       NULL
  );
  CREATE INDEX IX_VendorImportJobs_Vendor_Status ON oe.VendorImportJobs (VendorId, Status);
  PRINT 'Created oe.VendorImportJobs';
END
GO

IF OBJECT_ID('oe.VendorImportJobRows', 'U') IS NULL
BEGIN
  CREATE TABLE oe.VendorImportJobRows (
    RowId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_VendorImportJobRows PRIMARY KEY DEFAULT NEWID(),
    JobId       UNIQUEIDENTIFIER NOT NULL,
    RowIndex    INT              NOT NULL,
    Action      NVARCHAR(30)     NOT NULL,
    LegacyKey   NVARCHAR(200)    NULL,
    MemberId    UNIQUEIDENTIFIER NULL,
    EntityId    UNIQUEIDENTIFIER NULL,
    PayloadJson NVARCHAR(MAX)    NULL,
    ErrorsJson  NVARCHAR(MAX)    NULL,
    CONSTRAINT FK_VendorImportJobRows_Job FOREIGN KEY (JobId) REFERENCES oe.VendorImportJobs (JobId) ON DELETE CASCADE
  );
  CREATE INDEX IX_VendorImportJobRows_JobId ON oe.VendorImportJobRows (JobId);
  PRINT 'Created oe.VendorImportJobRows';
END
GO

IF OBJECT_ID('oe.VendorImportProductMap', 'U') IS NULL
BEGIN
  CREATE TABLE oe.VendorImportProductMap (
    MapId           UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_VendorImportProductMap PRIMARY KEY DEFAULT NEWID(),
    VendorId        UNIQUEIDENTIFIER NOT NULL,
    SourceProductKey NVARCHAR(500)   NOT NULL,
    ProductId       UNIQUEIDENTIFIER NOT NULL,
    ProductPricingId UNIQUEIDENTIFIER NULL,
    CreatedDate     DATETIME2        NOT NULL CONSTRAINT DF_VendorImportProductMap_Created DEFAULT SYSUTCDATETIME(),
    ModifiedDate    DATETIME2        NULL,
    CONSTRAINT UQ_VendorImportProductMap_Vendor_Source UNIQUE (VendorId, SourceProductKey)
  );
  PRINT 'Created oe.VendorImportProductMap';
END
GO

IF OBJECT_ID('oe.ShareRequestImportPending', 'U') IS NULL
BEGIN
  CREATE TABLE oe.ShareRequestImportPending (
    PendingId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_ShareRequestImportPending PRIMARY KEY DEFAULT NEWID(),
    VendorId     UNIQUEIDENTIFIER NOT NULL,
    JobId        UNIQUEIDENTIFIER NULL,
    LegacyShareRequestId NVARCHAR(100) NOT NULL,
    PayloadJson  NVARCHAR(MAX)    NOT NULL,
    MemberLinkKeysJson NVARCHAR(MAX) NULL,
    CreatedDate  DATETIME2        NOT NULL CONSTRAINT DF_ShareRequestImportPending_Created DEFAULT SYSUTCDATETIME(),
    ResolvedDate DATETIME2        NULL,
    ShareRequestId UNIQUEIDENTIFIER NULL
  );
  CREATE INDEX IX_ShareRequestImportPending_Vendor ON oe.ShareRequestImportPending (VendorId, ResolvedDate);
  PRINT 'Created oe.ShareRequestImportPending';
END
GO

PRINT 'Vendor import schema complete.';
