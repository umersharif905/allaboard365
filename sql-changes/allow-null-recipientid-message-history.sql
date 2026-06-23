-- Allow NULL RecipientId in oe.MessageHistory so verification emails (no user yet) can be recorded.
-- Run once on allaboard-prod (and allaboard-testing if used).
-- Error fixed: "Cannot insert the value NULL into column 'RecipientId', table 'oe.MessageHistory'; column does not allow nulls."

ALTER TABLE oe.MessageHistory
  ALTER COLUMN RecipientId UNIQUEIDENTIFIER NULL;
