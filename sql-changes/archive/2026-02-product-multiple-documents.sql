-- =============================================
-- Product multiple documents support
-- =============================================
-- Products currently have a single ProductDocumentUrl (nvarchar(500)).
-- This migration adds a ProductDocuments table so a product can have
-- multiple documents, and keeps ProductDocumentUrl for backward
-- compatibility (e.g. first document URL for legacy consumers).
-- =============================================

-- 1. Create ProductDocuments table
IF NOT EXISTS (SELECT * FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE s.name = 'oe' AND t.name = 'ProductDocuments')
BEGIN
    CREATE TABLE [oe].[ProductDocuments] (
        [ProductDocumentId] [uniqueidentifier] NOT NULL DEFAULT (newid()),
        [ProductId] [uniqueidentifier] NOT NULL,
        [DocumentUrl] [nvarchar](500) NOT NULL,
        [DisplayName] [nvarchar](255) NULL,
        [SortOrder] [int] NOT NULL DEFAULT 0,
        [CreatedDate] [datetime2](7) NOT NULL DEFAULT (getutcdate()),
        [CreatedBy] [uniqueidentifier] NULL,
        [ModifiedDate] [datetime2](7) NOT NULL DEFAULT (getutcdate()),
        [ModifiedBy] [uniqueidentifier] NULL,
        PRIMARY KEY CLUSTERED ([ProductDocumentId] ASC),
        CONSTRAINT [FK_ProductDocuments_Products] FOREIGN KEY([ProductId]) REFERENCES [oe].[Products] ([ProductId]) ON DELETE CASCADE
    );

    CREATE NONCLUSTERED INDEX [IX_ProductDocuments_ProductId] ON [oe].[ProductDocuments] ([ProductId] ASC);
END
GO

-- 2. Migrate existing single document from Products into ProductDocuments
-- (Only insert if ProductDocumentUrl is not null and no rows exist yet for that product.)
INSERT INTO [oe].[ProductDocuments] (ProductDocumentId, ProductId, DocumentUrl, DisplayName, SortOrder, CreatedDate, ModifiedDate)
SELECT
    newid(),
    p.ProductId,
    p.ProductDocumentUrl,
    N'Document',
    0,
    getutcdate(),
    getutcdate()
FROM [oe].[Products] p
WHERE p.ProductDocumentUrl IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM [oe].[ProductDocuments] pd WHERE pd.ProductId = p.ProductId);
GO
