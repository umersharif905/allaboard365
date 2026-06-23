-- ============================================================================
-- PRODUCT API INTEGRATION: oe.ProductAPIConfigs + ExternalAPI columns on Enrollments
-- ============================================================================
-- Adds:
-- 1. oe.ProductAPIConfigs - per-product API config (enrollment + deactivation)
-- 2. oe.Enrollments.ExternalAPISyncedAt - when enrollment API last succeeded
-- 3. oe.Enrollments.ExternalAPIDeactivatedAt - when deactivation API last succeeded
-- 4. oe.Enrollments.ExternalAPIResponseJson - token, memberId, SSO data
-- ============================================================================

PRINT 'Product API integration: creating ProductAPIConfigs table and Enrollments columns...';

-- ============================================================================
-- 1. CREATE oe.ProductAPIConfigs
-- ============================================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'oe.ProductAPIConfigs') AND type = N'U')
BEGIN
    CREATE TABLE oe.ProductAPIConfigs (
        ProductAPIConfigId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        ProductId UNIQUEIDENTIFIER NOT NULL,
        ConfigJson NVARCHAR(MAX) NULL,
        LastRunAt DATETIME2 NULL,
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT FK_ProductAPIConfigs_Product FOREIGN KEY (ProductId) REFERENCES oe.Products(ProductId),
        CONSTRAINT UQ_ProductAPIConfigs_ProductId UNIQUE (ProductId)
    );
    CREATE INDEX IX_ProductAPIConfigs_ProductId ON oe.ProductAPIConfigs(ProductId);
    PRINT 'Created oe.ProductAPIConfigs';
END
ELSE
BEGIN
    PRINT 'oe.ProductAPIConfigs already exists';
END
GO

-- ============================================================================
-- 2. ADD ExternalAPISyncedAt TO oe.Enrollments
-- ============================================================================
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Enrollments' AND COLUMN_NAME = 'ExternalAPISyncedAt'
)
BEGIN
    ALTER TABLE oe.Enrollments ADD ExternalAPISyncedAt DATETIME2 NULL;
    PRINT 'Added oe.Enrollments.ExternalAPISyncedAt';
END
ELSE
BEGIN
    PRINT 'oe.Enrollments.ExternalAPISyncedAt already exists';
END
GO

-- ============================================================================
-- 3. ADD ExternalAPIDeactivatedAt TO oe.Enrollments
-- ============================================================================
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Enrollments' AND COLUMN_NAME = 'ExternalAPIDeactivatedAt'
)
BEGIN
    ALTER TABLE oe.Enrollments ADD ExternalAPIDeactivatedAt DATETIME2 NULL;
    PRINT 'Added oe.Enrollments.ExternalAPIDeactivatedAt';
END
ELSE
BEGIN
    PRINT 'oe.Enrollments.ExternalAPIDeactivatedAt already exists';
END
GO

-- ============================================================================
-- 4. ADD ExternalAPIResponseJson TO oe.Enrollments
-- ============================================================================
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Enrollments' AND COLUMN_NAME = 'ExternalAPIResponseJson'
)
BEGIN
    ALTER TABLE oe.Enrollments ADD ExternalAPIResponseJson NVARCHAR(2000) NULL;
    PRINT 'Added oe.Enrollments.ExternalAPIResponseJson';
END
ELSE
BEGIN
    PRINT 'oe.Enrollments.ExternalAPIResponseJson already exists';
END
GO

-- ============================================================================
-- 5. INDEX for "needs run" queries (ExternalAPISyncedAt IS NULL)
-- ============================================================================
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Enrollments_ProductId_ExternalAPISyncedAt' AND object_id = OBJECT_ID('oe.Enrollments'))
BEGIN
    CREATE INDEX IX_Enrollments_ProductId_ExternalAPISyncedAt ON oe.Enrollments(ProductId, ExternalAPISyncedAt) WHERE ExternalAPISyncedAt IS NULL;
    PRINT 'Created IX_Enrollments_ProductId_ExternalAPISyncedAt';
END
GO

PRINT 'Product API integration schema update complete.';
