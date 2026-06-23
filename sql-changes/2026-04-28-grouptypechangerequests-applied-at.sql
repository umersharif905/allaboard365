-- 2026-04-28-grouptypechangerequests-applied-at.sql
--
-- Adds AppliedAt to oe.GroupTypeChangeRequests so the wizard's apply step
-- can definitively mark a request as "consumed". Without this, the
-- pending-action banner (and yellow group-row dot) used a heuristic
-- (CurrentType = current GroupType) that produces false positives when a
-- group is flipped twice and ends back at the original type.
--
-- Idempotent.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = 'AppliedAt'
    AND Object_ID = Object_ID('oe.GroupTypeChangeRequests')
)
BEGIN
  ALTER TABLE oe.GroupTypeChangeRequests
    ADD AppliedAt DATETIME2 NULL;
END
;

-- Backfill: any Approved request whose CurrentType no longer matches its
-- group's GroupType has definitely been applied (the wizard's apply step is
-- the only thing that flips the group's type). Mark those with AppliedAt =
-- COALESCE(ReviewedAt, CreatedDate). This preserves the audit timeline and
-- prevents the banner from flagging stale post-apply Approved rows.
--
-- Requests where CurrentType still matches the group's GroupType are LEFT
-- with AppliedAt = NULL — they may legitimately be pending action.

UPDATE r
SET r.AppliedAt = ISNULL(r.ReviewedAt, r.CreatedDate)
FROM oe.GroupTypeChangeRequests r
INNER JOIN oe.Groups g ON g.GroupId = r.GroupId
WHERE r.Status = 'Approved'
  AND r.AppliedAt IS NULL
  AND r.CurrentType <> g.GroupType;
;
