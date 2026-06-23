-- =============================================================================
-- Migration: trim Support Ticket status set to Open/In Progress/Pending/Closed
-- Date:      2026-05-19
-- Branch:    fix/backoffice/rename-cases-to-support-tickets
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   The earlier rename migration set the status universe to:
--     Open / In Progress / Waiting / Resolved / Closed
--
--   This migration trims it to:
--     Open / In Progress / Pending / Closed
--
--   Backfill mapping:
--     Waiting  -> Pending   (rename)
--     Resolved -> Closed    (collapsed; the "soft close" state goes away)
--
--   The DF_SupportTickets_Status default stays 'Open' (no change needed).
--   No CHECK constraint exists on Status (validation lives in app code), so
--   no DDL is required beyond the backfill.
--
-- WHY
-- ---
--   Care team feedback: Waiting and Resolved weren't pulling their weight.
--   Pending reads better than Waiting; "done" should just mean Closed.
--
-- IDEMPOTENCY
-- -----------
--   Re-running is a no-op (the UPDATE matches no rows once everyone is
--   migrated).
--
-- ROLLBACK
-- --------
--   See the commented block at the bottom. Note the Resolved->Closed map is
--   one-way; rollback can only restore the Closed bucket (no way to tell which
--   rows were originally Resolved vs already-Closed).
--
-- APPLICATION DEPLOYMENT ORDER
-- ----------------------------
--   1. Apply this migration.
--   2. Deploy backend + frontend (they only know the new 4-status set).
--
-- TEST-DB NOTES (allaboard-testing)
-- ---------------------------------
--   - Applied on: 2026-05-19 UTC
--   - Applied by: Claude, on behalf of Amar (via backend/scripts/run-support-ticket-statuses-trim-migration.js
--                 inside the allaboard365-backend container).
--   - Result:     SUCCESS. No-op on dev (no Waiting or Resolved rows existed —
--                 all 7 tickets were 'Open'). The UPDATEs matched zero rows;
--                 this confirms re-run safety. Prod will likely have actual
--                 Waiting/Resolved rows when applied.
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

UPDATE oe.SupportTickets SET Status = 'Pending' WHERE Status = 'Waiting';
UPDATE oe.SupportTickets SET Status = 'Closed'  WHERE Status = 'Resolved';
PRINT 'Backfilled Waiting -> Pending and Resolved -> Closed.';
GO

-- Verification
PRINT '----- Status distribution after backfill -----';
SELECT Status, COUNT(*) AS RowCount_
FROM oe.SupportTickets
GROUP BY Status
ORDER BY Status;
GO

-- =============================================================================
-- ROLLBACK (commented out — restore is lossy for the Resolved bucket)
-- =============================================================================
-- UPDATE oe.SupportTickets SET Status = 'Waiting' WHERE Status = 'Pending';
-- -- No way to recover original Resolved rows; they're now indistinguishable
-- -- from original Closed rows. Pick one policy:
-- --   (a) Leave everything as 'Closed' (lossy).
-- --   (b) Set all 'Closed' back to 'Resolved' (overcorrects — original Closed rows misclassified).
-- GO
