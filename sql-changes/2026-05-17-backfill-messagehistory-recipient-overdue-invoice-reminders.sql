-- Backfill oe.MessageHistory.RecipientId for overdue invoice reminder emails that used the
-- null-recipient sentinel (00000000-...), so they show on the member Communications tab.
--
-- Why this is scoped and safe:
-- 1) Only oe.InvoiceReminderLog is the audit table for overdue reminders (see invoice-reminder-log-table.sql).
-- 2) We only touch rows where log.QueuedMessageId = mh.MessageId — i.e. this MessageHistory row is exactly
--    the one recorded for that reminder attempt, not "any" sentinel email.
-- 3) Filters: Email, MemberPrimary, Status = Queued (actual send path — Skipped/Failed usually have no/wrong QueuedMessageId).
-- 4) TenantId is matched on both mh and irl so we never cross tenants.
-- 5) Group reminders (GroupBilling) are excluded by RecipientType.
-- 6) If bad data created two primary (P) members for one household, ROW_NUMBER picks one deterministically
--    (oldest by CreatedDate, then MemberId).
--
-- Safe to re-run: only updates mh rows still on the sentinel.
--
-- Optional preview (run first):
/*
SELECT mh.HistoryId, mh.MessageId, mh.RecipientAddress, mh.Subject, t.RecipientUserId
FROM oe.MessageHistory mh
INNER JOIN (
  SELECT mh2.HistoryId, pm.UserId AS RecipientUserId,
    ROW_NUMBER() OVER (
      PARTITION BY mh2.HistoryId
      ORDER BY pm.CreatedDate ASC, pm.MemberId ASC
    ) AS pick
  FROM oe.MessageHistory mh2
  INNER JOIN oe.InvoiceReminderLog irl
    ON irl.QueuedMessageId = mh2.MessageId
   AND irl.TenantId = mh2.TenantId
  INNER JOIN oe.Invoices i ON i.InvoiceId = irl.InvoiceId AND i.TenantId = irl.TenantId
  INNER JOIN oe.Members pm
    ON i.HouseholdId IS NOT NULL
   AND pm.HouseholdId = i.HouseholdId
   AND pm.RelationshipType = N'P'
   AND pm.UserId IS NOT NULL
  WHERE mh2.RecipientId = '00000000-0000-0000-0000-000000000000'
    AND mh2.MessageType = N'Email'
    AND irl.Channel = N'Email'
    AND irl.RecipientType = N'MemberPrimary'
    AND irl.Status = N'Queued'
    AND pm.UserId <> '00000000-0000-0000-0000-000000000000'
) t ON t.HistoryId = mh.HistoryId AND t.pick = 1;
*/

;WITH targeted AS (
  SELECT
    mh.HistoryId,
    pm.UserId AS RecipientUserId,
    ROW_NUMBER() OVER (
      PARTITION BY mh.HistoryId
      ORDER BY pm.CreatedDate ASC, pm.MemberId ASC
    ) AS pick
  FROM oe.MessageHistory mh
  INNER JOIN oe.InvoiceReminderLog irl
    ON irl.QueuedMessageId = mh.MessageId
   AND irl.TenantId = mh.TenantId
  INNER JOIN oe.Invoices i ON i.InvoiceId = irl.InvoiceId AND i.TenantId = irl.TenantId
  INNER JOIN oe.Members pm
    ON i.HouseholdId IS NOT NULL
   AND pm.HouseholdId = i.HouseholdId
   AND pm.RelationshipType = N'P'
   AND pm.UserId IS NOT NULL
  WHERE mh.RecipientId = '00000000-0000-0000-0000-000000000000'
    AND mh.MessageType = N'Email'
    AND irl.Channel = N'Email'
    AND irl.RecipientType = N'MemberPrimary'
    AND irl.Status = N'Queued'
    AND pm.UserId <> '00000000-0000-0000-0000-000000000000'
)
UPDATE mh
SET mh.RecipientId = t.RecipientUserId
FROM oe.MessageHistory mh
INNER JOIN targeted t ON t.HistoryId = mh.HistoryId AND t.pick = 1;
