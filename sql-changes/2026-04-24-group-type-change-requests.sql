-- 2026-04-24-group-type-change-requests.sql
IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE Name = 'GroupTypeChangeRequests' AND schema_id = SCHEMA_ID('oe')
)
BEGIN
  CREATE TABLE oe.GroupTypeChangeRequests (
    RequestId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_GroupTypeChangeRequests PRIMARY KEY DEFAULT NEWID(),
    GroupId         UNIQUEIDENTIFIER NOT NULL,
    TenantId        UNIQUEIDENTIFIER NOT NULL,
    RequestedBy     UNIQUEIDENTIFIER NOT NULL,
    CurrentType     NVARCHAR(20)     NOT NULL,
    RequestedType   NVARCHAR(20)     NOT NULL,
    Status          NVARCHAR(20)     NOT NULL,
    Reason          NVARCHAR(MAX)    NULL,
    ReviewedBy      UNIQUEIDENTIFIER NULL,
    ReviewedAt      DATETIME2        NULL,
    ReviewNotes     NVARCHAR(MAX)    NULL,
    CreatedDate     DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    ModifiedDate    DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_GroupTypeChangeRequests_Status
      CHECK (Status IN ('Pending','Approved','Denied','Cancelled')),
    CONSTRAINT CK_GroupTypeChangeRequests_Types
      CHECK (CurrentType IN ('Standard','ListBill')
         AND RequestedType IN ('Standard','ListBill')
         AND CurrentType <> RequestedType)
  );

  CREATE INDEX IX_GroupTypeChangeRequests_Tenant_Status
    ON oe.GroupTypeChangeRequests(TenantId, Status);
  CREATE INDEX IX_GroupTypeChangeRequests_Group
    ON oe.GroupTypeChangeRequests(GroupId);
END
GO
