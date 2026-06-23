-- =============================================================================
-- DATA FIX: reclassify care-team replies mis-filed as inbound  (NOT a schema change)
-- Date:    2026-06-04
-- Branch:  feat/backoffice/email
-- Spec:    docs/superpowers/specs/2026-06-02-back-office-email/design.md
-- =============================================================================
--
-- WHAT: Care-team members reply to members from their own mailbox; an Outlook
--       rule copies those sends into the shared Inbox, where the ingest recorded
--       them as INBOUND (customer) mail. Going forward, recordInboundMessage now
--       reclassifies these via the roster (matchCareTeamSender). This script does
--       the same for messages already ingested: any inbound message whose sender
--       matches an active VendorAdmin/VendorAgent of the same vendor is flipped to
--       OUTBOUND, attributed to that user, and its thread aggregates recomputed
--       (mirrors emailThreadService.recomputeThread).
--
-- ROSTER-ONLY: only addresses present in oe.Users (active, VendorAdmin/Agent for
--       that vendor) flip. Add missing senders as vendor users, then re-run — this
--       script is idempotent and safe to run repeatedly.
--
-- DOES NOT create encounters for the flipped messages — that's the separate
--       share-request encounter backfill.
--
-- SAFETY: @DryRun defaults to 1 (preview only). Review the preview counts, then
--       set @DryRun = 0 to apply. Wrapped in a transaction.
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @DryRun   BIT = 1;                       -- 1 = preview only (default). Set 0 to apply.
DECLARE @VendorId UNIQUEIDENTIFIER = NULL;       -- optional: scope to one vendor (NULL = all).

IF OBJECT_ID('tempdb..#flip') IS NOT NULL DROP TABLE #flip;

SELECT m.EmailMessageId, m.ThreadId, m.VendorId, u.UserId AS SenderUserId,
       m.FromAddress, (u.FirstName + ' ' + u.LastName) AS MatchedUser
INTO #flip
FROM oe.EmailMessages m
JOIN oe.Users u
    ON LOWER(u.Email) = LOWER(m.FromAddress)
   AND u.VendorId = m.VendorId
   AND u.Status = 'Active'
JOIN oe.UserRoles ur ON ur.UserId = u.UserId
JOIN oe.Roles r ON r.RoleId = ur.RoleId AND r.Name IN ('VendorAdmin', 'VendorAgent')
WHERE m.Direction = 'inbound'
  AND (@VendorId IS NULL OR m.VendorId = @VendorId);

-- Preview: what would flip, by sender.
SELECT FromAddress, MatchedUser, COUNT(*) AS MessagesToFlip,
       COUNT(DISTINCT ThreadId) AS ThreadsAffected
FROM #flip
GROUP BY FromAddress, MatchedUser
ORDER BY COUNT(*) DESC;

SELECT (SELECT COUNT(*) FROM #flip) AS TotalMessagesToFlip,
       (SELECT COUNT(DISTINCT ThreadId) FROM #flip) AS TotalThreadsAffected,
       @DryRun AS DryRun;

IF @DryRun = 0
BEGIN
    BEGIN TRANSACTION;

    -- Flip direction + attribute to the care-team member.
    UPDATE m SET
        m.Direction    = 'outbound',
        m.SentByUserId  = f.SenderUserId,
        m.SentAt        = COALESCE(m.SentAt, m.ReceivedAt),
        m.ReceivedAt    = NULL,
        m.IsRead        = 1,
        m.SendStatus    = 'sent',
        m.ModifiedDate  = SYSUTCDATETIME()
    FROM oe.EmailMessages m
    JOIN #flip f ON f.EmailMessageId = m.EmailMessageId;

    -- Recompute denormalised thread fields for affected threads.
    ;WITH agg AS (
        SELECT em.ThreadId,
               COUNT(*) AS MessageCount,
               SUM(CASE WHEN em.Direction = 'inbound' AND em.IsRead = 0 THEN 1 ELSE 0 END) AS UnreadCount,
               MAX(COALESCE(em.SentAt, em.ReceivedAt)) AS LastMessageAt
        FROM oe.EmailMessages em
        WHERE em.ThreadId IN (SELECT DISTINCT ThreadId FROM #flip)
        GROUP BY em.ThreadId
    ),
    lastdir AS (
        SELECT t.ThreadId,
               (SELECT TOP 1 e2.Direction FROM oe.EmailMessages e2
                 WHERE e2.ThreadId = t.ThreadId
                 ORDER BY COALESCE(e2.SentAt, e2.ReceivedAt) DESC) AS LastDirection
        FROM (SELECT DISTINCT ThreadId FROM #flip) t
    )
    UPDATE th SET
        th.MessageCount  = agg.MessageCount,
        th.UnreadCount   = ISNULL(agg.UnreadCount, 0),
        th.LastMessageAt = agg.LastMessageAt,
        th.LastDirection = lastdir.LastDirection,
        th.NeedsReply    = CASE WHEN lastdir.LastDirection = 'inbound' THEN 1 ELSE 0 END,
        th.ModifiedDate  = SYSUTCDATETIME()
    FROM oe.EmailThreads th
    JOIN agg ON agg.ThreadId = th.ThreadId
    JOIN lastdir ON lastdir.ThreadId = th.ThreadId;

    COMMIT TRANSACTION;
    SELECT 'APPLIED' AS Status;
END

IF OBJECT_ID('tempdb..#flip') IS NOT NULL DROP TABLE #flip;
