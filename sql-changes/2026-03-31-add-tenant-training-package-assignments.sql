-- Maps organization-scoped training packages to tenants.

IF NOT EXISTS (
    SELECT 1
    FROM sys.tables
    WHERE name = 'TenantTrainingPackageAssignments'
      AND schema_id = SCHEMA_ID('oe')
)
BEGIN
    CREATE TABLE oe.TenantTrainingPackageAssignments (
        TenantTrainingPackageAssignmentId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        TenantId UNIQUEIDENTIFIER NOT NULL,
        PackageId NVARCHAR(100) NOT NULL,
        IsActive BIT NOT NULL DEFAULT 1,
        EffectiveDate DATE NULL,
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CreatedBy UNIQUEIDENTIFIER NULL,
        ModifiedBy UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_TenantTrainingPackageAssignments PRIMARY KEY (TenantTrainingPackageAssignmentId),
        CONSTRAINT FK_TenantTrainingPackageAssignments_Tenant FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId)
    );

    CREATE UNIQUE NONCLUSTERED INDEX UX_TenantTrainingPackageAssignments_TenantPackage
        ON oe.TenantTrainingPackageAssignments(TenantId, PackageId);

    CREATE NONCLUSTERED INDEX IX_TenantTrainingPackageAssignments_PackageId
        ON oe.TenantTrainingPackageAssignments(PackageId)
        INCLUDE (TenantId, IsActive);
END;

