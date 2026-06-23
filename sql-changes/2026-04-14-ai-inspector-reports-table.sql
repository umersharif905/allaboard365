-- ============================================================================
-- AI Inspector Reports table
-- Stores findings from the hourly AI log inspector Azure Function.
-- Each row is one finding; RunId groups all findings from the same run.
-- ============================================================================

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'AiInspectorReports'
)
BEGIN
    CREATE TABLE oe.AiInspectorReports (
        ReportId        UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        AppServiceName  NVARCHAR(255)    NOT NULL,
        Priority        INT              NOT NULL,   -- 1=Critical, 2=Warning, 3=Info
        Category        NVARCHAR(100),               -- 'Error', 'Performance', 'Security', 'Inconsistency'
        Title           NVARCHAR(500)    NOT NULL,
        Summary         NVARCHAR(MAX)    NOT NULL,   -- AI-generated analysis
        RawLogExcerpt   NVARCHAR(MAX),               -- Relevant log lines
        Recommendation  NVARCHAR(MAX),               -- AI-suggested fix
        RunId           UNIQUEIDENTIFIER NOT NULL,   -- Groups findings from same run
        CreatedAt       DATETIME2        DEFAULT GETUTCDATE()
    );

    CREATE NONCLUSTERED INDEX IX_AiInspectorReports_RunId
        ON oe.AiInspectorReports (RunId);

    CREATE NONCLUSTERED INDEX IX_AiInspectorReports_Priority_CreatedAt
        ON oe.AiInspectorReports (Priority, CreatedAt DESC);

    CREATE NONCLUSTERED INDEX IX_AiInspectorReports_AppServiceName
        ON oe.AiInspectorReports (AppServiceName, CreatedAt DESC);

    PRINT 'Created oe.AiInspectorReports with indexes.';
END
ELSE
BEGIN
    PRINT 'oe.AiInspectorReports already exists — skipping.';
END
