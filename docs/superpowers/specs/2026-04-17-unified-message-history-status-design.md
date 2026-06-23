# Unified Message History + Expanded Status — Design Spec

**Date:** 2026-04-17
**Status:** Draft — awaiting user review
**Author:** Claude (brainstormed with Joey)
**Problem context:** Yesterday's PR #210 ("Message Failure Visibility") shipped a SendGrid event webhook + `oe.MessageEvent` table + a flag-gated Failed Messages panel on the Analytics page. The webhook is now working (PR #212 fallback), but the Failed Messages panel on Analytics is a redundant surface — Message History already has the data, filters, and details modal. In parallel, `MessageHistory.Status` only reflects terminal webhook events (`Delivered`/`Failed`), so the list view can't distinguish "still trying" from "delivered" from "opened."

## 1. Goal

Make `MessageHistoryPage` the single place to see every client-facing outbound email with an accurate real-time status driven by SendGrid events.

Specifically:
- Expand `MessageHistory.Status` to reflect `Deferred` and `Opened` in addition to existing `Sent`/`Delivered`/`Failed`
- Surface the failure reason (bounce/dropped/blocked details) inside the existing details modal when `Status='Failed'`
- Remove the flag-gated Failed Messages panel from `MessageAnalyticsPage` (duplicative). Leave the rest of Analytics (charts, stats cards, tenant summaries) intact.
- Close one client-facing logging gap: `shareRequestESSService` sends ESS PDFs to members via Graph API without writing to `MessageHistory`. Add the insert.

SMS/Twilio, business proposals, admin/vendor/internal email paths are all **out of scope**.

## 2. What already exists (reuse; do not rewrite)

| Component | Path | Status |
|---|---|---|
| `MessageHistoryPage` (list, filters, search, pagination, batch progress) | `frontend/src/pages/message-center/MessageHistoryPage.tsx` | ✅ Full UI |
| Details modal with MessageEvent timeline | `MessageHistoryPage.tsx:179-203` + `/history/:id/details` endpoint | ✅ Already joins `MessageEvent` |
| `GET /api/message-center/history/:id/details` | `backend/routes/messageCenter.js:1749` | ✅ Returns real provider events |
| `MessageAnalyticsPage` (charts, tenant summaries, stats cards) | `frontend/src/pages/message-center/MessageAnalyticsPage.tsx` | ✅ Keep intact |
| SendGrid event webhook | `backend/routes/webhooks/sendgrid.js` | ✅ Running in prod, verified writing to `MessageEvent` |
| `oe.MessageEvent` table | Azure SQL | ✅ Populating correctly |
| `oe.MessageHistory.Body`/`FromAddress` columns | Azure SQL | ✅ Populated on new-path sends |
| Webhook → MessageHistory.Status update | `backend/services/sendGridEmailDeliveryTracking.service.js` | ⚠️ Only handles terminal events (`delivered`/`bounce`/`dropped`). Missing `deferred` and `open`. |
| `GET /api/message-center/failures` + frontend `getFailures()` | `backend/routes/messageCenter.js:1889` + `frontend/src/services/messageCenter.service.ts` | 🗑️ **Will be retired** with the panel |
| `VITE_FEATURE_FAILED_MESSAGES` flag | `MessageAnalyticsPage.tsx:34` | 🗑️ **Will be removed** |
| Failed Messages panel | `MessageAnalyticsPage.tsx:340-390` | 🗑️ **Will be removed** |
| `frontend/.env.production` (created yesterday) | `frontend/.env.production` | 🗑️ **Will be deleted** |

**No schema migrations, no table/column changes.** All data-model work is new string values in the existing `MessageHistory.Status` column.

## 3. Architecture

```
┌──────────────┐  send  ┌──────────┐  events  ┌────────────────────┐
│ Senders      │ ─────> │ SendGrid │ ───────> │ POST /api/webhooks/│
│ (unchanged)  │        └──────────┘          │ sendgrid/events    │
└──────┬───────┘                              └──────────┬─────────┘
       │ insert MessageHistory                           │
       │ (Status='Sent')                                 │ extend:
       ▼                                                 │  deferred → Status='Deferred'
 ┌──────────────────────┐                                │  delivered → Status='Delivered'
 │ oe.MessageHistory    │◄──── update Status ────────────┤  bounce/dropped → Status='Failed'
 │ (unchanged schema)   │       (state-machine: no       │  open → Status='Opened'
 └──────┬───────────────┘        downgrade)              │
        │                                                ▼
        │ FK MessageId                          ┌─────────────────┐
        └──────────────────────────────────────►│ oe.MessageEvent │
                                                │ (unchanged)     │
                                                └─────────────────┘
```

## 4. Status state machine

**Initial state:** `Sent` (at insert time, after SendGrid returns 202).

**Transitions** (applied by the webhook delivery-tracker):

| Current Status | Event = `deferred` | Event = `delivered` | Event = `bounce`/`dropped`/`blocked` | Event = `open` |
|---|---|---|---|---|
| `Sent` | → `Deferred` | → `Delivered` | → `Failed` | → `Opened` (treats as delivered+opened) |
| `Deferred` | (no change, still trying) | → `Delivered` | → `Failed` | → `Opened` |
| `Delivered` | (no change) | (no change) | (no change) | → `Opened` |
| `Opened` | (no change) | (no change) | (no change) | (no change) |
| `Failed` | (no change — terminal) | (no change) | (no change) | (no change, already terminal) |

**Invariant:** Status moves forward only along `Sent → Deferred → Delivered → Opened` OR `Sent → Failed`. `Failed` and `Opened` are terminal; no event can move them. This prevents event-order races from corrupting state.

**Non-updates (intentional):**
- `processed` event — transient, every message passes through this; no Status change
- `click` event — implies `open` already happened; no Status change (timeline shows it in the details modal)
- `spamreport`, `unsubscribe`, `group_unsubscribe`, `group_resubscribe` — not failure states; no Status change

## 5. Code changes

### Backend

1. **`backend/services/sendGridEmailDeliveryTracking.service.js`** — extend `applySendGridDeliveryEvent` per the state-machine table above. Current logic handles `delivered`/`bounce`/`dropped` via `terminalUpdateMessageHistory`. Add:
   - `deferred` — UPDATE MessageHistory SET Status='Deferred' WHERE ProviderMessageId matches AND Status IN ('Sent') (don't regress from Delivered/Opened)
   - `open` — UPDATE MessageHistory SET Status='Opened' WHERE ProviderMessageId matches AND Status NOT IN ('Opened','Failed')
   - Add a helper `advanceStatusIfNotTerminal(pool, keys, targetStatus, allowedFromStatuses)` to centralize the "no downgrade" rule
2. **`backend/services/shareRequestESSService.js:273`** — insert `oe.MessageHistory` before `GraphEmailService.sendEmail(...)`. MessageType='Email', Status='Sent', ProviderMessageId=null (Graph doesn't provide one in the same way), FromAddress=sender, Body=rendered body. No webhook will ever update this row — Status stays `Sent`. Acceptable since Graph path is low-volume and we just want audit-level visibility.
3. **Retire `GET /api/message-center/failures`** — delete the route handler (lines 1889-1964 in `messageCenter.js`) and its helper queries. No callers remain once the frontend panel is gone.

### Frontend

1. **`frontend/src/pages/message-center/MessageAnalyticsPage.tsx`**:
   - Delete line 34 (`failedMessagesEnabled` const)
   - Delete the `useEffect` at lines 110-129 that fetches failures
   - Delete the `failures`/`failuresDays` state hooks and the `FailedMessage` import
   - Delete the entire flag-gated JSX block (lines ~340-395)
   - Everything else on the page (charts, stats cards, tenant summaries, date range controls) stays untouched
2. **`frontend/src/pages/message-center/MessageHistoryPage.tsx`**:
   - Add `Opened` and `Deferred` to the Status filter dropdown (existing `<select>` at filterStatus)
   - Update the `isDeliveredOk` helper (line 96) to include `Delivered` and `Opened` as success states
   - Update the details modal to show a prominent "Failure reason" section at the top when `status='Failed'` — derive from the latest `MessageEvent` row's `Reason` field (already returned by the details endpoint via `eventsResult.recordset`, just needs to be surfaced in the UI)
   - Add a small status legend/tooltip so users know what `Deferred` and `Opened` mean
3. **`frontend/src/services/messageCenter.service.ts`**: remove `getFailures()` and the `FailedMessage` type. Keep everything else.
4. **`frontend/.env`**: revert the `VITE_FEATURE_FAILED_MESSAGES=true` line added yesterday (no longer needed; flag is deleted).
5. **`frontend/.env.production`**: delete the file entirely.

### Tests

1. **`backend/services/__tests__/sendGridEmailDeliveryTracking.test.js`** (or whatever the existing tracker test file is — audit and add if missing):
   - `deferred` event advances `Sent` → `Deferred` but not `Delivered` → `Deferred`
   - `open` event advances `Delivered` → `Opened` and `Sent` → `Opened`
   - `bounce` on `Opened` row: no change (terminal)
   - `delivered` on `Failed` row: no change (terminal)
2. **`backend/routes/webhooks/__tests__/sendgrid.test.js`**: extend existing suite to cover `deferred` and `open` event types end-to-end (mock MessageHistory lookup, assert correct Status).
3. **Frontend snapshot/render test** for `MessageHistoryPage` filter dropdown showing the new options. Light-touch — the UI surface is small.

## 6. Rollback plan

No DDL. Revert the code commit. New Status string values left in `MessageHistory` rows are still valid `NVARCHAR(50)` — they don't break any existing query (filters that look for `='Sent'` just won't match `Deferred`/`Opened` rows, which is the pre-PR behavior).

## 7. Out of scope (explicitly)

- SMS/Twilio Status updates (Twilio webhook writes to MessageEvent only, MessageHistory.Status for SMS stays `Sent`)
- Business proposal emails (`business-proposal-sends.js:443`) — not logged, stays unlogged
- Admin/internal/vendor send paths (9 call sites) — not logged, stays unlogged
- Charts showing Opened/Deferred counts — can be added later without schema work
- Backfilling historical rows with new Status values — only new webhook events update Status going forward

## 8. Success criteria

After merge + deploy:
- Sending a test email and opening it in a mail client causes `MessageHistory.Status` to transition `Sent` → `Delivered` → `Opened` in prod (visible in the History list without a page reload on next poll)
- Sending to an invalid address produces `Status='Failed'` and the bounce reason is visible at the top of the details modal
- Deferred emails show `Status='Deferred'` and don't flap back to `Sent`
- Analytics page renders identically to today except the Failed Messages panel is gone
- `shareRequestESSService` ESS PDF sends appear in the History list
