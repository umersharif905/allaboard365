-- =============================================================================
-- Migration: Zoom Call Center — transcripts, AI summaries & agent attribution
-- Date:      2026-05-20
-- Branch:    zoom-integration
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Extends the existing Zoom Phone integration (oe.VendorCallLogs /
--   oe.VendorActiveCalls / oe.Vendors.Zoom*) to support:
--     * Call recording transcripts (captured from Zoom's
--       phone.recording_transcript_completed webhook)
--     * AI-generated call summaries (OpenAI / gpt-4o) on top of transcripts
--     * Reliable per-agent attribution by mapping Zoom Phone users to
--       internal vendor-agent user accounts
--
--   Columns added to oe.VendorCallLogs:
--     TranscriptText        NVARCHAR(MAX)  full call transcript text
--     TranscriptStatus      NVARCHAR(20)   None|Pending|Available|Failed|Unavailable
--     TranscriptSource      NVARCHAR(20)   Zoom|Whisper|Manual
--     TranscriptFetchedAt   DATETIME2      when the transcript was stored
--     AISummary             NVARCHAR(MAX)  2-3 paragraph GPT summary (CallSummary
--                                          is only NVARCHAR(500) — too small)
--     AISummaryStatus       NVARCHAR(20)   None|Pending|Available|Failed
--     AISummaryGeneratedAt  DATETIME2      when the summary was generated
--     AISummaryModel        NVARCHAR(60)   model id used (e.g. gpt-4o)
--     ZoomUserId            NVARCHAR(64)   Zoom Phone user id that handled the call
--     AgentEmail            NVARCHAR(255)  Zoom user email (attribution aid)
--
--   Table created:
--     oe.VendorPhoneAgentMap
--       Maps a vendor's Zoom Phone users (by id / email / extension) to an
--       internal oe.Users account so call logs and live calls can be
--       attributed to the right vendor agent for stats & reports.
--
--   Indexes added to oe.VendorCallLogs to support history/stats/reports queries.
--
--   NOTHING is dropped. CallSummary (NVARCHAR(500)) is left in place; the new
--   AISummary column supersedes it.
--
-- HOW TO RUN
-- ----------
--   Per repo DB policy this script is DRY-RUN by default: it only PREVIEWS the
--   changes and prints current state. To actually apply, set @DryRun = 0 at the
--   top and re-run. The script is idempotent (IF NOT EXISTS guards) so it is
--   safe to run more than once.
-- =============================================================================

SET NOCOUNT ON;

DECLARE @DryRun BIT = 1;   -- <<< set to 0 to APPLY changes >>>

PRINT '============================================================';
PRINT 'Zoom Call Center migration  |  DryRun = ' + CAST(@DryRun AS VARCHAR(1));
PRINT '============================================================';

-- ---------------------------------------------------------------------------
-- 1. New columns on oe.VendorCallLogs
-- ---------------------------------------------------------------------------
DECLARE @colsToAdd TABLE (ColName SYSNAME, DdlType NVARCHAR(100));
INSERT INTO @colsToAdd (ColName, DdlType) VALUES
    ('TranscriptText',       'NVARCHAR(MAX) NULL'),
    ('TranscriptStatus',     'NVARCHAR(20) NULL'),
    ('TranscriptSource',     'NVARCHAR(20) NULL'),
    ('TranscriptFetchedAt',  'DATETIME2 NULL'),
    ('AISummary',            'NVARCHAR(MAX) NULL'),
    ('AISummaryStatus',      'NVARCHAR(20) NULL'),
    ('AISummaryGeneratedAt', 'DATETIME2 NULL'),
    ('AISummaryModel',       'NVARCHAR(60) NULL'),
    ('ZoomUserId',           'NVARCHAR(64) NULL'),
    ('AgentEmail',           'NVARCHAR(255) NULL');

-- Preview / apply each column
DECLARE @col SYSNAME, @ddl NVARCHAR(100), @sql NVARCHAR(MAX);
DECLARE col_cursor CURSOR LOCAL FAST_FORWARD FOR
    SELECT ColName, DdlType FROM @colsToAdd;
OPEN col_cursor;
FETCH NEXT FROM col_cursor INTO @col, @ddl;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID('oe.VendorCallLogs') AND name = @col
    )
    BEGIN
        IF @DryRun = 1
            PRINT '  [WOULD ADD] oe.VendorCallLogs.' + @col + ' ' + @ddl;
        ELSE
        BEGIN
            SET @sql = 'ALTER TABLE oe.VendorCallLogs ADD ' + QUOTENAME(@col) + ' ' + @ddl;
            EXEC sp_executesql @sql;
            PRINT '  [ADDED] oe.VendorCallLogs.' + @col;
        END
    END
    ELSE
        PRINT '  [SKIP - exists] oe.VendorCallLogs.' + @col;
    FETCH NEXT FROM col_cursor INTO @col, @ddl;
END
CLOSE col_cursor;
DEALLOCATE col_cursor;

-- ---------------------------------------------------------------------------
-- 2. oe.VendorPhoneAgentMap
-- ---------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('oe.VendorPhoneAgentMap') AND type = 'U')
BEGIN
    IF @DryRun = 1
        PRINT '  [WOULD CREATE] oe.VendorPhoneAgentMap';
    ELSE
    BEGIN
        CREATE TABLE oe.VendorPhoneAgentMap (
            MapId           UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_VendorPhoneAgentMap_MapId DEFAULT (NEWID()),
            VendorId        UNIQUEIDENTIFIER NOT NULL,
            ZoomUserId      NVARCHAR(64)     NULL,
            ZoomEmail       NVARCHAR(255)    NULL,
            ZoomExtension   NVARCHAR(20)     NULL,
            ZoomDisplayName NVARCHAR(255)    NULL,
            UserId          UNIQUEIDENTIFIER NULL,   -- internal vendor agent (oe.Users)
            IsActive        BIT              NOT NULL CONSTRAINT DF_VendorPhoneAgentMap_IsActive DEFAULT (1),
            CreatedDate     DATETIME2        NOT NULL CONSTRAINT DF_VendorPhoneAgentMap_Created DEFAULT (GETDATE()),
            CreatedBy       UNIQUEIDENTIFIER NULL,
            ModifiedDate    DATETIME2        NULL,
            ModifiedBy      UNIQUEIDENTIFIER NULL,
            CONSTRAINT PK_VendorPhoneAgentMap PRIMARY KEY CLUSTERED (MapId),
            CONSTRAINT FK_VendorPhoneAgentMap_Vendor FOREIGN KEY (VendorId) REFERENCES oe.Vendors (VendorId)
        );
        -- One mapping per (vendor, zoom user)
        CREATE UNIQUE INDEX UQ_VendorPhoneAgentMap_Vendor_ZoomUser
            ON oe.VendorPhoneAgentMap (VendorId, ZoomUserId)
            WHERE ZoomUserId IS NOT NULL;
        CREATE INDEX IX_VendorPhoneAgentMap_Vendor_User
            ON oe.VendorPhoneAgentMap (VendorId, UserId);
        PRINT '  [CREATED] oe.VendorPhoneAgentMap';
    END
END
ELSE
    PRINT '  [SKIP - exists] oe.VendorPhoneAgentMap';

-- ---------------------------------------------------------------------------
-- 3. Supporting indexes on oe.VendorCallLogs
-- ---------------------------------------------------------------------------
DECLARE @idx TABLE (IdxName SYSNAME, IdxDdl NVARCHAR(MAX));
INSERT INTO @idx (IdxName, IdxDdl) VALUES
    ('IX_VendorCallLogs_Vendor_Start',
     'CREATE INDEX IX_VendorCallLogs_Vendor_Start ON oe.VendorCallLogs (VendorId, CallStartTime DESC) WHERE IsActive = 1'),
    ('IX_VendorCallLogs_Vendor_Agent_Start',
     'CREATE INDEX IX_VendorCallLogs_Vendor_Agent_Start ON oe.VendorCallLogs (VendorId, AgentUserId, CallStartTime)'),
    ('IX_VendorCallLogs_Vendor_External',
     'CREATE INDEX IX_VendorCallLogs_Vendor_External ON oe.VendorCallLogs (VendorId, ExternalCallId)');

DECLARE @ixName SYSNAME, @ixDdl NVARCHAR(MAX);
DECLARE idx_cursor CURSOR LOCAL FAST_FORWARD FOR SELECT IdxName, IdxDdl FROM @idx;
OPEN idx_cursor;
FETCH NEXT FROM idx_cursor INTO @ixName, @ixDdl;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID('oe.VendorCallLogs') AND name = @ixName
    )
    BEGIN
        IF @DryRun = 1
            PRINT '  [WOULD CREATE INDEX] ' + @ixName;
        ELSE
        BEGIN
            EXEC sp_executesql @ixDdl;
            PRINT '  [CREATED INDEX] ' + @ixName;
        END
    END
    ELSE
        PRINT '  [SKIP - exists] index ' + @ixName;
    FETCH NEXT FROM idx_cursor INTO @ixName, @ixDdl;
END
CLOSE idx_cursor;
DEALLOCATE idx_cursor;

-- ---------------------------------------------------------------------------
-- 4. Dry-run summary of current state
-- ---------------------------------------------------------------------------
IF @DryRun = 1
BEGIN
    PRINT '';
    PRINT '--- DRY RUN: current oe.VendorCallLogs columns ---';
    SELECT name AS ExistingColumn, TYPE_NAME(system_type_id) AS Type, max_length AS MaxLen
    FROM sys.columns WHERE object_id = OBJECT_ID('oe.VendorCallLogs')
    ORDER BY column_id;

    PRINT '--- DRY RUN: nothing was changed. Set @DryRun = 0 to apply. ---';
END
ELSE
    PRINT 'Migration applied successfully.';
