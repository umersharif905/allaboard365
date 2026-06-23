/*
 * Backfill: 2026-05-26 — Populate VendorCallLogs.AnsweredBy from RawEventData.
 *
 * Reads the stored Zoom webhook JSON and derives the AnsweredBy classification
 * for every row where AnsweredBy IS NULL.
 *
 * Classification logic (parallels services/zoomPhoneService.js classifyAnsweredBy):
 *   - inbound + callee.extension_type='user' (or 'extension')           → 'User'
 *   - inbound + callee.extension_type='autoReceptionist'/'auto_receptionist' → 'AutoReceptionist'
 *   - inbound + callee.extension_type='callQueue'/'call_queue'          → 'CallQueue'
 *   - inbound + callee.extension_type='commonArea'                      → 'CommonArea'
 *   - inbound + callee.extension_type='sharedLineGroup'                 → 'SharedLineGroup'
 *   - outbound mirrors caller.extension_type
 *   - voicemail flat shape: callee_user_id present → 'User'
 *
 * Idempotent. DRY-RUN default — shows row counts without writing.
 * Set @DryRun = 0 to apply.
 */

SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;

BEGIN TRY
    BEGIN TRANSACTION;

    ;WITH classified AS (
        SELECT
            cl.CallLogId,
            CASE
                WHEN cl.CallType = 'Outbound' THEN
                    CASE LOWER(REPLACE(COALESCE(
                        JSON_VALUE(cl.RawEventData, '$.object.caller.extension_type'),
                        JSON_VALUE(cl.RawEventData, '$.caller.extension_type'),
                        JSON_VALUE(cl.RawEventData, '$.caller_extension_type'),
                        JSON_VALUE(cl.RawEventData, '$.caller_ext_type'),
                        ''
                    ), '_', ''))
                        WHEN 'user' THEN 'User'
                        WHEN 'extension' THEN 'User'
                        WHEN 'autoreceptionist' THEN 'AutoReceptionist'
                        WHEN 'callqueue' THEN 'CallQueue'
                        WHEN 'commonarea' THEN 'CommonArea'
                        WHEN 'sharedlinegroup' THEN 'SharedLineGroup'
                        ELSE NULL
                    END
                ELSE
                    CASE LOWER(REPLACE(COALESCE(
                        JSON_VALUE(cl.RawEventData, '$.object.callee.extension_type'),
                        JSON_VALUE(cl.RawEventData, '$.callee.extension_type'),
                        JSON_VALUE(cl.RawEventData, '$.callee_extension_type'),
                        JSON_VALUE(cl.RawEventData, '$.callee_ext_type'),
                        ''
                    ), '_', ''))
                        WHEN 'user' THEN 'User'
                        WHEN 'extension' THEN 'User'
                        WHEN 'autoreceptionist' THEN 'AutoReceptionist'
                        WHEN 'callqueue' THEN 'CallQueue'
                        WHEN 'commonarea' THEN 'CommonArea'
                        WHEN 'sharedlinegroup' THEN 'SharedLineGroup'
                        ELSE
                            CASE
                                WHEN JSON_VALUE(cl.RawEventData, '$.object.callee_user_id') IS NOT NULL
                                  OR JSON_VALUE(cl.RawEventData, '$.callee_user_id') IS NOT NULL
                                THEN 'User'
                                ELSE NULL
                            END
                    END
            END AS DerivedAnsweredBy
        FROM oe.VendorCallLogs cl
        WHERE cl.AnsweredBy IS NULL
          AND cl.RawEventData IS NOT NULL
    )
    SELECT
        DerivedAnsweredBy,
        COUNT(*) AS WouldUpdate
    FROM classified
    WHERE DerivedAnsweredBy IS NOT NULL
    GROUP BY DerivedAnsweredBy
    ORDER BY WouldUpdate DESC;

    IF @DryRun = 0
    BEGIN
        UPDATE cl
        SET cl.AnsweredBy = c.DerivedAnsweredBy,
            cl.ModifiedDate = GETDATE()
        FROM oe.VendorCallLogs cl
        INNER JOIN (
            SELECT
                cl2.CallLogId,
                CASE
                    WHEN cl2.CallType = 'Outbound' THEN
                        CASE LOWER(REPLACE(COALESCE(
                            JSON_VALUE(cl2.RawEventData, '$.object.caller.extension_type'),
                            JSON_VALUE(cl2.RawEventData, '$.caller.extension_type'),
                            JSON_VALUE(cl2.RawEventData, '$.caller_extension_type'),
                            JSON_VALUE(cl2.RawEventData, '$.caller_ext_type'),
                            ''
                        ), '_', ''))
                            WHEN 'user' THEN 'User'
                            WHEN 'extension' THEN 'User'
                            WHEN 'autoreceptionist' THEN 'AutoReceptionist'
                            WHEN 'callqueue' THEN 'CallQueue'
                            WHEN 'commonarea' THEN 'CommonArea'
                            WHEN 'sharedlinegroup' THEN 'SharedLineGroup'
                            ELSE NULL
                        END
                    ELSE
                        CASE LOWER(REPLACE(COALESCE(
                            JSON_VALUE(cl2.RawEventData, '$.object.callee.extension_type'),
                            JSON_VALUE(cl2.RawEventData, '$.callee.extension_type'),
                            JSON_VALUE(cl2.RawEventData, '$.callee_extension_type'),
                            JSON_VALUE(cl2.RawEventData, '$.callee_ext_type'),
                            ''
                        ), '_', ''))
                            WHEN 'user' THEN 'User'
                            WHEN 'extension' THEN 'User'
                            WHEN 'autoreceptionist' THEN 'AutoReceptionist'
                            WHEN 'callqueue' THEN 'CallQueue'
                            WHEN 'commonarea' THEN 'CommonArea'
                            WHEN 'sharedlinegroup' THEN 'SharedLineGroup'
                            ELSE
                                CASE
                                    WHEN JSON_VALUE(cl2.RawEventData, '$.object.callee_user_id') IS NOT NULL
                                      OR JSON_VALUE(cl2.RawEventData, '$.callee_user_id') IS NOT NULL
                                    THEN 'User'
                                    ELSE NULL
                                END
                        END
                END AS DerivedAnsweredBy
            FROM oe.VendorCallLogs cl2
            WHERE cl2.AnsweredBy IS NULL
              AND cl2.RawEventData IS NOT NULL
        ) c ON c.CallLogId = cl.CallLogId
        WHERE c.DerivedAnsweredBy IS NOT NULL;

        PRINT 'APPLY — committing.';
        COMMIT TRANSACTION;
    END
    ELSE
    BEGIN
        PRINT 'DRY RUN — preview above. Set @DryRun = 0 to apply.';
        ROLLBACK TRANSACTION;
    END
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
