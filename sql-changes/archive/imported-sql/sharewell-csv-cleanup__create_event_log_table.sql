-- ============================================================================
-- Event Log Table for Process Tracking and Auditing
-- ============================================================================
-- This table provides a flexible event logging system that can be used for
-- any process, not just E123 imports. It tracks all operations with full
-- audit trail capabilities.
-- ============================================================================

-- Drop table if exists (for development)
-- DROP TABLE IF EXISTS [dbo].[event_log];

CREATE TABLE [dbo].[event_log](
    -- Primary identification
    [id] [uniqueidentifier] NOT NULL DEFAULT NEWID(),
    [event_timestamp] [datetime2](7) NOT NULL DEFAULT GETDATE(),
    
    -- Event classification
    [event_type] [nvarchar](50) NOT NULL,           -- 'E123_IMPORT', 'MEMBER_ADD', 'MEMBER_UPDATE', etc.
    [event_category] [nvarchar](50) NOT NULL,       -- 'MEMBER', 'PRODUCT', 'ACCOUNT', 'IMPORT', 'SYSTEM'
    [event_status] [nvarchar](20) NOT NULL,         -- 'SUCCESS', 'ERROR', 'WARNING', 'INFO'
    
    -- Process tracking
    [source_file] [nvarchar](256) NULL,             -- E.g., 'MemberFile_20251018.csv'
    [process_batch_id] [uniqueidentifier] NULL,     -- Groups all events from single run
    [process_name] [nvarchar](100) NULL,            -- E.g., 'E123_Daily_Import', 'Manual_Update'
    
    -- Entity tracking (what was affected)
    [entity_type] [nvarchar](50) NULL,              -- 'member', 'account', 'member_product', 'product', etc.
    [entity_id] [uniqueidentifier] NULL,            -- FK to the affected record (if applicable)
    [entity_key] [nvarchar](256) NULL,              -- Business key (e.g., member_id, account_id)
    
    -- Action details
    [action] [nvarchar](50) NULL,                   -- 'INSERT', 'UPDATE', 'DELETE', 'SKIP', 'ERROR', 'VALIDATE'
    [old_values] [nvarchar](max) NULL,              -- JSON of old values (for updates)
    [new_values] [nvarchar](max) NULL,              -- JSON of new values
    [changes_detected] [nvarchar](max) NULL,        -- JSON array of changed field names
    
    -- Messaging
    [message] [nvarchar](max) NULL,                 -- Human-readable message
    [error_message] [nvarchar](max) NULL,           -- Error details if status='ERROR'
    [stack_trace] [nvarchar](max) NULL,             -- Stack trace for errors
    
    -- Metadata
    [user_name] [nvarchar](100) NULL,               -- System/user who triggered (e.g., 'SYSTEM', 'admin@company.com')
    [ip_address] [nvarchar](50) NULL,               -- IP address if applicable
    [duration_ms] [int] NULL,                       -- Processing time in milliseconds
    [record_count] [int] NULL,                      -- Number of records affected
    
    -- Additional context (flexible JSON field)
    [additional_data] [nvarchar](max) NULL,         -- Any other data as JSON
    
    CONSTRAINT [PK_event_log] PRIMARY KEY CLUSTERED ([id] ASC)
        WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY];
GO

-- ============================================================================
-- Indexes for Performance
-- ============================================================================

-- Index for querying by timestamp (most common query)
CREATE NONCLUSTERED INDEX [IX_event_log_timestamp] 
ON [dbo].[event_log]([event_timestamp] DESC)
INCLUDE ([event_type], [event_status], [process_batch_id]);
GO

-- Index for querying by batch (view all events in a process run)
CREATE NONCLUSTERED INDEX [IX_event_log_batch] 
ON [dbo].[event_log]([process_batch_id])
INCLUDE ([event_timestamp], [event_type], [event_status], [entity_type]);
GO

-- Index for querying by entity (view history of a specific record)
CREATE NONCLUSTERED INDEX [IX_event_log_entity] 
ON [dbo].[event_log]([entity_type], [entity_id])
INCLUDE ([event_timestamp], [action], [event_status]);
GO

-- Index for querying errors and warnings
CREATE NONCLUSTERED INDEX [IX_event_log_status] 
ON [dbo].[event_log]([event_status], [event_type])
WHERE [event_status] IN ('ERROR', 'WARNING')
INCLUDE ([event_timestamp], [process_batch_id], [message]);
GO

-- Index for querying by event category and type
CREATE NONCLUSTERED INDEX [IX_event_log_category_type] 
ON [dbo].[event_log]([event_category], [event_type], [event_timestamp] DESC);
GO

-- ============================================================================
-- Helpful Views for Common Queries
-- ============================================================================

-- View: Recent Process Runs Summary
CREATE VIEW [dbo].[v_event_log_process_summary] AS
SELECT 
    process_batch_id,
    MIN(event_timestamp) as start_time,
    MAX(event_timestamp) as end_time,
    DATEDIFF(SECOND, MIN(event_timestamp), MAX(event_timestamp)) as duration_seconds,
    process_name,
    source_file,
    COUNT(*) as total_events,
    SUM(CASE WHEN event_status = 'SUCCESS' THEN 1 ELSE 0 END) as success_count,
    SUM(CASE WHEN event_status = 'ERROR' THEN 1 ELSE 0 END) as error_count,
    SUM(CASE WHEN event_status = 'WARNING' THEN 1 ELSE 0 END) as warning_count,
    SUM(CASE WHEN action = 'INSERT' THEN 1 ELSE 0 END) as inserts,
    SUM(CASE WHEN action = 'UPDATE' THEN 1 ELSE 0 END) as updates,
    SUM(CASE WHEN action = 'SKIP' THEN 1 ELSE 0 END) as skipped
FROM event_log
WHERE process_batch_id IS NOT NULL
GROUP BY process_batch_id, process_name, source_file;
GO

-- View: Recent Errors
CREATE VIEW [dbo].[v_event_log_recent_errors] AS
SELECT TOP 1000
    event_timestamp,
    event_type,
    event_category,
    entity_type,
    entity_key,
    message,
    error_message,
    process_batch_id,
    source_file
FROM event_log
WHERE event_status = 'ERROR'
ORDER BY event_timestamp DESC;
GO

-- View: Member Change History
CREATE VIEW [dbo].[v_event_log_member_history] AS
SELECT 
    el.event_timestamp,
    el.action,
    el.entity_key as member_id,
    el.old_values,
    el.new_values,
    el.changes_detected,
    el.process_batch_id,
    el.source_file,
    el.user_name
FROM event_log el
WHERE el.entity_type = 'member'
    AND el.action IN ('INSERT', 'UPDATE', 'DELETE');
GO

-- ============================================================================
-- Sample Queries
-- ============================================================================

-- Query 1: Get summary of last 10 process runs
/*
SELECT TOP 10 *
FROM v_event_log_process_summary
ORDER BY start_time DESC;
*/

-- Query 2: Get all errors from a specific batch
/*
SELECT 
    event_timestamp,
    entity_type,
    entity_key,
    message,
    error_message
FROM event_log
WHERE process_batch_id = 'YOUR_BATCH_ID_HERE'
    AND event_status = 'ERROR'
ORDER BY event_timestamp;
*/

-- Query 3: Get all changes to a specific member
/*
SELECT 
    event_timestamp,
    action,
    old_values,
    new_values,
    changes_detected,
    source_file
FROM event_log
WHERE entity_type = 'member'
    AND entity_key = 'SW123456'
ORDER BY event_timestamp DESC;
*/

-- Query 4: Get daily processing statistics
/*
SELECT 
    CAST(event_timestamp AS DATE) as process_date,
    COUNT(DISTINCT process_batch_id) as batch_count,
    COUNT(*) as total_events,
    SUM(CASE WHEN event_status = 'SUCCESS' THEN 1 ELSE 0 END) as success_count,
    SUM(CASE WHEN event_status = 'ERROR' THEN 1 ELSE 0 END) as error_count
FROM event_log
WHERE event_category = 'E123_IMPORT'
GROUP BY CAST(event_timestamp AS DATE)
ORDER BY process_date DESC;
*/

-- ============================================================================
-- Cleanup/Archival Procedure (run monthly to prevent table bloat)
-- ============================================================================

/*
CREATE PROCEDURE [dbo].[sp_archive_old_event_logs]
    @days_to_keep INT = 90
AS
BEGIN
    SET NOCOUNT ON;
    
    -- Archive old logs to archive table (optional)
    -- DELETE FROM event_log WHERE event_timestamp < DATEADD(DAY, -@days_to_keep, GETDATE());
    
    PRINT 'Event log cleanup complete';
END;
GO
*/


