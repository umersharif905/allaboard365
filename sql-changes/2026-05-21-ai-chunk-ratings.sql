-- 2026-05-21-ai-chunk-ratings.sql
-- Columbus feedback/ranking system: store per-answer 1-5 ratings, attributed to
-- the AI chunks that fed the rated answer. Ratings flow in from Columbus
-- (member portal + website + future mobile) via POST /api/ai/chunk-ratings.
--
-- Non-destructive, additive. Safe to run multiple times.
-- AIChunkId is intentionally NOT a hard FK: ratings ingest from an external
-- service may reference chunk ids that were since regenerated/removed, and we
-- never want a stale id to reject a rating. A NULL AIChunkId = an overall
-- "how's Columbus doing" rating not tied to a specific chunk.

BEGIN TRANSACTION;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'AIChunkRatings' AND schema_id = SCHEMA_ID('oe'))
BEGIN
    CREATE TABLE oe.AIChunkRatings (
        RatingId      uniqueidentifier NOT NULL CONSTRAINT DF_AIChunkRatings_RatingId DEFAULT NEWID(),
        AIChunkId     uniqueidentifier NULL,         -- which chunk fed the rated answer (NULL = overall)
        Rating        int              NOT NULL,     -- 1..5
        ClientApp     nvarchar(64)     NULL,         -- 'aab-member-portal' | 'mightywell-site' | 'mightywell-mobile'
        MessageId     nvarchar(64)     NULL,         -- Columbus answer id (for dedupe/trace)
        UserLevel     nvarchar(32)     NULL,         -- 'anonymous' | 'authenticated' | 'admin'
        TenantId      uniqueidentifier NULL,
        CreatedDate   datetime2        NOT NULL CONSTRAINT DF_AIChunkRatings_CreatedDate DEFAULT GETUTCDATE(),
        CONSTRAINT PK_AIChunkRatings PRIMARY KEY (RatingId),
        CONSTRAINT CK_AIChunkRatings_Rating CHECK (Rating BETWEEN 1 AND 5)
    );
END

-- Aggregation index: summary endpoint groups by AIChunkId.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AIChunkRatings_AIChunkId')
    CREATE INDEX IX_AIChunkRatings_AIChunkId
      ON oe.AIChunkRatings(AIChunkId)
      INCLUDE (Rating);

COMMIT TRANSACTION;
