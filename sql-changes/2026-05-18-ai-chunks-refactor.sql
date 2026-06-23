-- 2026-05-18-ai-chunks-refactor.sql
-- Extend oe.AIChunks with chunk type/source/document-link metadata;
-- extend oe.ProductDocuments with extraction-status columns.
-- Non-destructive: existing rows are backfilled as manual prose chunks.

BEGIN TRANSACTION;

-- 1. oe.AIChunks columns
IF COL_LENGTH('oe.AIChunks', 'ChunkType') IS NULL
    ALTER TABLE oe.AIChunks ADD ChunkType nvarchar(16) NULL;
IF COL_LENGTH('oe.AIChunks', 'Source') IS NULL
    ALTER TABLE oe.AIChunks ADD Source nvarchar(8) NULL;
IF COL_LENGTH('oe.AIChunks', 'SourceDocumentId') IS NULL
    ALTER TABLE oe.AIChunks ADD SourceDocumentId uniqueidentifier NULL;
IF COL_LENGTH('oe.AIChunks', 'Question') IS NULL
    ALTER TABLE oe.AIChunks ADD Question nvarchar(1000) NULL;
IF COL_LENGTH('oe.AIChunks', 'Title') IS NULL
    ALTER TABLE oe.AIChunks ADD Title nvarchar(200) NULL;

-- 2. Rename ChunkData → ChunkText (only if not already renamed)
IF COL_LENGTH('oe.AIChunks', 'ChunkData') IS NOT NULL
   AND COL_LENGTH('oe.AIChunks', 'ChunkText') IS NULL
BEGIN
    EXEC sp_rename 'oe.AIChunks.ChunkData', 'ChunkText', 'COLUMN';
END

-- 3. Backfill existing rows (dynamic SQL so parser doesn't reject new column names at batch-compile time)
EXEC sp_executesql N'UPDATE oe.AIChunks SET ChunkType = ''prose'' WHERE ChunkType IS NULL';
EXEC sp_executesql N'UPDATE oe.AIChunks SET Source = ''manual'' WHERE Source IS NULL';

-- 4. NOT NULL constraints (dynamic SQL — columns may be brand-new in this batch)
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.AIChunks') AND name = 'ChunkType' AND is_nullable = 1)
    EXEC sp_executesql N'ALTER TABLE oe.AIChunks ALTER COLUMN ChunkType nvarchar(16) NOT NULL';
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.AIChunks') AND name = 'Source' AND is_nullable = 1)
    EXEC sp_executesql N'ALTER TABLE oe.AIChunks ALTER COLUMN Source nvarchar(8) NOT NULL';

-- 5. CHECK constraints (only add if absent; dynamic SQL to avoid parse-time column resolution)
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_AIChunks_ChunkType')
    EXEC sp_executesql N'ALTER TABLE oe.AIChunks ADD CONSTRAINT CK_AIChunks_ChunkType CHECK (ChunkType IN (''prose'', ''faq''))';
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_AIChunks_Source')
    EXEC sp_executesql N'ALTER TABLE oe.AIChunks ADD CONSTRAINT CK_AIChunks_Source CHECK (Source IN (''ai'', ''manual''))';

-- 6. FK to oe.ProductDocuments (only if both exist and FK absent)
IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ProductDocuments' AND schema_id = SCHEMA_ID('oe'))
   AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_AIChunks_SourceDocument')
BEGIN
    ALTER TABLE oe.AIChunks
        ADD CONSTRAINT FK_AIChunks_SourceDocument
        FOREIGN KEY (SourceDocumentId) REFERENCES oe.ProductDocuments(ProductDocumentId);
END

-- 7. Lookup index (dynamic SQL — Source and ChunkType are new columns)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AIChunks_ProductId_Source_ChunkType')
    EXEC sp_executesql N'CREATE INDEX IX_AIChunks_ProductId_Source_ChunkType
      ON oe.AIChunks(ProductId, Source, ChunkType)
      INCLUDE (TenantId, IsActive, Status)';

-- 8. oe.ProductDocuments extraction-state columns
IF COL_LENGTH('oe.ProductDocuments', 'ExtractionStatus') IS NULL
    ALTER TABLE oe.ProductDocuments ADD ExtractionStatus nvarchar(16) NULL;
IF COL_LENGTH('oe.ProductDocuments', 'ExtractionStartedAt') IS NULL
    ALTER TABLE oe.ProductDocuments ADD ExtractionStartedAt datetime2 NULL;
IF COL_LENGTH('oe.ProductDocuments', 'ExtractionCompletedAt') IS NULL
    ALTER TABLE oe.ProductDocuments ADD ExtractionCompletedAt datetime2 NULL;
IF COL_LENGTH('oe.ProductDocuments', 'ExtractionError') IS NULL
    ALTER TABLE oe.ProductDocuments ADD ExtractionError nvarchar(max) NULL;
IF COL_LENGTH('oe.ProductDocuments', 'ExtractionChunkCount') IS NULL
    ALTER TABLE oe.ProductDocuments ADD ExtractionChunkCount int NULL;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_ProductDocuments_ExtractionStatus')
    EXEC sp_executesql N'ALTER TABLE oe.ProductDocuments
        ADD CONSTRAINT CK_ProductDocuments_ExtractionStatus
        CHECK (ExtractionStatus IS NULL OR ExtractionStatus IN (''queued'', ''running'', ''completed'', ''failed''))';

COMMIT TRANSACTION;
