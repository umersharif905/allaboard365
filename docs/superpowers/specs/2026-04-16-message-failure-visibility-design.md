# Message Failure Visibility — Design Spec

**Date:** 2026-04-16
**Status:** Draft — awaiting user review
**Author:** Claude (brainstormed with Joey)
**Problem context:** [2026-03-31 Yahoo TSS04 incident](../../../README.md) — we need sysadmin/tenant-admin visibility into which messages bounced/deferred and ability to preview failed emails for support calls.

## 1. Goal

Give sysadmins and tenant admins a fast way to:
- See which outbound messages (email + SMS) have failed or are stuck in delivery limbo
- Drill into why a specific message failed (real event timeline, not synthetic)
- Preview the actual email body so support can relay the content (e.g., verification code) to a customer over another channel
- Auto-clear a message from the failed list if it eventually delivers

## 2. What already exists (reuse; do not rewrite)

Before coding, confirm these still exist; if any have changed, re-audit.

| Component | Path | Status |
|---|---|---|
| MessageHistoryPage (list + filters + details modal shell) | `frontend/src/pages/message-center/MessageHistoryPage.tsx` | ✅ Full UI, including Status=Failed filter, tenant filter, date range, CSV/Excel export |
| Delivery-details modal (`handleViewDetails`) | `MessageHistoryPage.tsx:179-203` | ✅ Calls `messageHistoryService.getDeliveryDetails(historyId)` and displays a `DeliveryEvent[]` timeline |
| Backend details endpoint | `backend/routes/messageCenter.js:1708-1780` | ⚠️ Exists but **synthesizes** the timeline (only ever emits `Sent` + optional `Failed` events). No real provider event data. |
| MessageAnalyticsPage | `frontend/src/pages/message-center/MessageAnalyticsPage.tsx` | ✅ Has totals, daily trend, status pie, types pie, tenant summary table |
| `messageHistoryService.getDeliveryDetails` | `frontend/src/services/messageCenter.service.ts` | ✅ Wired to the above endpoint |
| `oe.MessageHistory` | Azure SQL | ✅ Columns: HistoryId, MessageId, TenantId, RecipientId, MessageType, RecipientAddress, Subject, Status, ProviderMessageId, ErrorMessage, SentDate, BatchId |
| SendGrid webhook handler | — | ❌ **Does not exist**. Confirmed via grep. |
| Twilio status callback | — | ❌ Not confirmed; likely does not exist. |
| `oe.MessageEvent` table | — | ❌ Does not exist. |
| MessageHistory.Body column | — | ❌ Does not exist. Template/body generated on send (`TemplateProcessor`, `bulkBlastProcessor`) and discarded. |

**Implication:** the primary work is *data* (capture real provider events + bodies), not UI. The UI changes are additive extensions of existing components.

## 3. Architecture

```
┌──────────────┐   send   ┌─────────────┐   events   ┌──────────────────┐
│ Our app      │ ───────> │ SendGrid    │ ─────────> │ POST /api/hooks/ │
│ (existing)   │          │ (shared IP) │            │ sendgrid/events  │ ◄── NEW
└──────────────┘          └─────────────┘            └────────┬─────────┘
       │                                                       │
       │ insert MessageHistory                                  │ insert
       │ (include Body, FromAddress) ◄── NEW columns            │
       ▼                                                       ▼
  ┌────────────────────┐                               ┌────────────────┐
  │ oe.MessageHistory  │ ◄─── FK ─── MessageId ─────── │ oe.MessageEvent│ ◄── NEW
  │ (augmented)        │                               │ (NEW)          │
  └────────────────────┘                               └────────────────┘
            ▲                                                  ▲
            │                  join on MessageId               │
            └──────────────────────┬───────────────────────────┘
                                   ▼
                    ┌────────────────────────────────┐
                    │ GET /api/message-center/       │
                    │   history/:id/details          │ ◄── extend (return real events)
                    │ GET /api/message-center/       │
                    │   failures                     │ ◄── NEW
                    └────────────────────────────────┘
                                   ▲
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
  ┌─────────────────────────┐                 ┌──────────────────────┐
  │ MessageAnalyticsPage    │                 │ MessageHistoryPage   │
  │  + "Failed Messages"    │ ◄── NEW panel   │  details modal       │ ◄── enhance
  │  panel (summary + link) │                 │   + real timeline    │
  └─────────────────────────┘                 │   + email body preview│
                                              └──────────────────────┘
```

## 4. Data model changes

All DB changes ship as two SQL migration files in `sql-changes/` (repo convention: `YYYY-MM-DD-<topic>.sql`):
- `sql-changes/2026-04-16-add-message-event.sql` — creates `oe.MessageEvent` (§4a)
- `sql-changes/2026-04-16-messagehistory-add-body.sql` — adds `Body` + `FromAddress` columns (§4b)

### 4a. New table `oe.MessageEvent` (create only; no backfill)

```sql
CREATE TABLE oe.MessageEvent (
  EventId         UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
  MessageId       UNIQUEIDENTIFIER NOT NULL,
  Provider        NVARCHAR(20)     NOT NULL,     -- 'sendgrid' | 'twilio'
  EventType       NVARCHAR(40)     NOT NULL,     -- 'processed','deferred','delivered','bounce','dropped','spam_report','blocked','open','click' (email); 'queued','sending','sent','delivered','failed','undelivered' (SMS)
  EventTime       DATETIME2        NOT NULL,
  Reason          NVARCHAR(1000)   NULL,         -- verbatim provider error text / smtp-id
  MxServer        NVARCHAR(200)    NULL,         -- email deferrals
  ProviderEventId NVARCHAR(100)    NULL,         -- provider dedupe key (sg_event_id / twilio MessageSid+status)
  RawPayload      NVARCHAR(MAX)    NULL,         -- full JSON for audit
  CreatedAt       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_MessageEvent PRIMARY KEY (EventId),
  CONSTRAINT UQ_MessageEvent_ProviderEventId UNIQUE (Provider, ProviderEventId)  -- idempotent ingestion
);
CREATE INDEX IX_MessageEvent_MessageId ON oe.MessageEvent(MessageId);
CREATE INDEX IX_MessageEvent_EventTime ON oe.MessageEvent(EventTime DESC);
CREATE INDEX IX_MessageEvent_EventType ON oe.MessageEvent(EventType);
```

Notes:
- Not a FK to `MessageHistory` (`MessageId` exists on both `MessageQueue` and `MessageHistory`; events might arrive before MessageHistory insert completes, and having a hard FK would cause webhook drops). Soft linkage via `MessageId` + index is enough.
- `UQ(Provider, ProviderEventId)` lets the webhook retry freely; SendGrid supplies `sg_event_id` (unique per event), Twilio supplies `MessageSid` + status transition.
- `RawPayload` kept for audit — we can reconstruct history if schema evolves.

### 4b. Augment `oe.MessageHistory`

```sql
ALTER TABLE oe.MessageHistory ADD
  Body        NVARCHAR(MAX) NULL,     -- rendered body captured at send time (email HTML or SMS text)
  FromAddress NVARCHAR(320) NULL;     -- From address actually used
```

Safety:
- Both columns NULL-default — zero risk to existing rows, zero risk to existing INSERTs that don't set them.
- We populate them on new sends via code changes in `bulkBlastProcessor.js`, `TemplateProcessor/index.js`, and `sendGridEmailService.js`. Older rows (pre-deploy) keep Body=NULL → preview shows "Body not captured for this message."

Storage estimate: ~50 MB/month at current volume; trivial for Azure SQL Standard.

### 4c. View `oe.v_MessageEffectiveStatus` (optional; ship if queries get ugly)

Deriving "effective status" (delivered / bounced / stuck-deferred) from events on the fly:

```sql
CREATE OR ALTER VIEW oe.v_MessageEffectiveStatus AS
SELECT
  mh.HistoryId,
  mh.MessageId,
  CASE
    WHEN EXISTS (SELECT 1 FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId AND e.EventType = 'delivered') THEN 'Delivered'
    WHEN EXISTS (SELECT 1 FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId AND e.EventType IN ('bounce','dropped','spam_report','blocked','failed','undelivered')) THEN 'Failed'
    WHEN EXISTS (SELECT 1 FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId AND e.EventType = 'deferred') THEN 'Deferred'
    WHEN mh.Status = 'Failed' THEN 'Failed'
    ELSE 'Sent'  -- handed to provider, no events yet (or events pruned)
  END AS EffectiveStatus,
  (SELECT TOP 1 EventTime FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId ORDER BY EventTime DESC) AS LastEventTime
FROM oe.MessageHistory mh;
```

Indexed? No — it's a logical view. If perf becomes an issue we'll materialize (separate PR).

## 5. Backend changes

### 5a. NEW: SendGrid Event Webhook handler

File: `backend/routes/webhooks/sendgrid.js` (new). Registered in `backend/app.js` via `app.use('/api/webhooks/sendgrid', require('./routes/webhooks/sendgrid'))`.

- `POST /api/webhooks/sendgrid/events`
- Verify signature: use `@sendgrid/eventwebhook` library's `verifySignature(publicKey, rawBody, timestamp, signature)`. Reject on mismatch with 401.
- Signing public key loaded from env `SENDGRID_WEBHOOK_PUBLIC_KEY` (copy from SendGrid dashboard after we enable it).
- Body is a JSON array of events. For each:
  1. Extract `sg_event_id`, `event`, `timestamp`, `email`, `reason`, `mx`, `smtp-id`, custom args.
  2. Resolve `MessageId` from `unique_args.MessageId` — we must **add that custom arg to every send** (see §5c). Fallback: match by `ProviderMessageId` prefix if unique_args missing.
  3. `INSERT INTO oe.MessageEvent ... ON CONFLICT UQ (Provider, ProviderEventId) DO NOTHING` (MSSQL equivalent: `MERGE` or `IF NOT EXISTS ... INSERT`).
  4. Respond 200 (don't let one bad event block the batch — catch and log per-event errors).

Performance: process batches inline for now (SendGrid sends max ~30 events/batch). If volume grows, move to MessageQueue.

Idempotency: enforced by the UNIQUE constraint; SendGrid retries are safe.

### 5b. NEW: Twilio SMS status callback

File: `backend/routes/webhooks/twilio.js` (new, optional for v1 — gate behind env flag).
- `POST /api/webhooks/twilio/status`
- Verify signature via `twilio.webhook()` middleware + `TWILIO_AUTH_TOKEN`.
- Map Twilio status (`queued`, `sent`, `delivered`, `failed`, `undelivered`) → MessageEvent rows.
- Same UQ dedupe pattern.

### 5c. Modify send paths to tag SendGrid payloads with `MessageId`

Files and approx lines (verify at implementation time):
- `messageCenter/shared/bulkBlastProcessor.js` around the `sgMail.send(msg)` payload construction (line ~210). Add `custom_args: { MessageId: <uuid> }` to each personalization.
- `messageCenter/TemplateProcessor/index.js` — any direct SendGrid send path (verify).
- `messageCenter/MessageProcessor/index.js` around the single-email `sgMail.send` (line ~213). Add `custom_args: { MessageId: message.MessageId }`.
- `backend/services/sendGridEmailService.js` — ensure every send method (`sendEmail`, any other) includes `custom_args.MessageId` when the MessageId is known.

This is a pure addition to the outgoing payload — no behavior change for sends, no risk to existing deliveries.

### 5d. Modify send paths to capture Body + FromAddress

Same files as §5c. Whenever we `INSERT INTO oe.MessageHistory ...`, also write `Body` and `FromAddress`. All three insert sites already exist (`bulkBlastProcessor.js:79-87` and `:110-117`; MessageProcessor's history insert — verify path).

Body contents:
- Email: store the rendered HTML body that was passed to SendGrid (not the template — the resolved, per-recipient rendered version).
- SMS: store the text message body.

Safety: adding two input parameters to the existing INSERT — backwards-compatible with any untouched insert sites. Column NULL-safe.

### 5e. EXTEND: details endpoint

File: `backend/routes/messageCenter.js` around line 1708 (`/history/:id/details`).
- Replace synthesized `events` array with: `SELECT EventType, EventTime, Reason, MxServer, Provider FROM oe.MessageEvent WHERE MessageId = @messageId ORDER BY EventTime ASC` keyed by the MessageId of the history row.
- If 0 rows, fall back to current synthetic events (covers pre-webhook-deploy historical messages).
- Also return: `body` (from new column), `fromAddress`, `effectiveStatus` (compute inline or join view from §4c).

### 5f. NEW: failures list endpoint

File: `backend/routes/messageCenter.js` (add a new handler around line 1780).

```
GET /api/message-center/failures
  ?days=7                     (default 7)
  &type=email|sms             (optional)
  &tenantId=<uuid>            (SysAdmin only; tenant admin implicitly scoped)
  &cursor=<ISO>               (pagination by SentDate DESC)
```

Query logic (SysAdmin example):
```sql
SELECT TOP 50
  mh.HistoryId, mh.MessageId, mh.TenantId, mh.RecipientAddress, mh.Subject, mh.MessageType, mh.SentDate,
  (SELECT TOP 1 e.EventType FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId ORDER BY e.EventTime DESC) AS LastEventType,
  (SELECT TOP 1 e.Reason FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId ORDER BY e.EventTime DESC) AS LastEventReason,
  (SELECT TOP 1 e.EventTime FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId ORDER BY e.EventTime DESC) AS LastEventTime
FROM oe.MessageHistory mh
WHERE mh.SentDate >= DATEADD(day, -@days, GETUTCDATE())
  AND (
    -- hard failures
    EXISTS (SELECT 1 FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId AND e.EventType IN ('bounce','dropped','spam_report','blocked','failed','undelivered'))
    OR mh.Status = 'Failed'
    -- deferred and not yet delivered
    OR (
      EXISTS (SELECT 1 FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId AND e.EventType = 'deferred')
      AND NOT EXISTS (SELECT 1 FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId AND e.EventType = 'delivered')
    )
  )
  -- drop once delivered
  AND NOT EXISTS (SELECT 1 FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId AND e.EventType = 'delivered')
  AND [@tenantId filter]
ORDER BY mh.SentDate DESC;
```

The last `NOT EXISTS` is the "drop from list when eventually delivered" logic the user asked for — implicit in the query, no cron needed.

Returns shape:
```
{ success: true, data: [{
    historyId, messageId, tenantId, recipientAddress, subject, messageType,
    sentDate, lastEventType, lastEventReason, lastEventTime, category: 'bounce'|'deferred'|'other'
  }], nextCursor: ISO | null }
```

## 6. Frontend changes

### 6a. NEW: "Failed Messages" panel on MessageAnalyticsPage

File: `frontend/src/pages/message-center/MessageAnalyticsPage.tsx` — add a new section after the existing "Message Types" pie chart row (approx line 300, after the last closing `</div>` of the types grid).

Panel contents (one card, full-width on narrow screens, 2-col grid on lg):
- Header: "Failed Messages" with a count badge
- Filter pill: "Last 7 days" (click to toggle 7/30)
- Scrollable list of up to ~20 rows: icon (bounce ⚠️ / deferred 🕐 / blocked 🛑), recipient, subject/text snippet, category label, relative time
- Each row clickable → opens the existing `MessageHistoryPage` details modal (or navigates to `/message-center/history?status=Failed&highlight=:id`)
- Footer link: "View all (N) →" → `/message-center/history?status=Failed`

State hooks use the existing `messageCenter.service.ts` pattern; add `messageHistoryService.getFailures(params)` method there.

### 6b. EXTEND: existing details modal in MessageHistoryPage

File: `frontend/src/pages/message-center/MessageHistoryPage.tsx`.

1. `DeliveryEvent` interface (line 29) — add optional fields:
   ```ts
   interface DeliveryEvent {
     event: string;
     timestamp: string;
     details?: string;
     provider?: string;
     mxServer?: string;
     eventType?: string;
   }
   ```

2. `MessageHistoryItem` — add `body?: string; fromAddress?: string; effectiveStatus?: string;`.

3. In the details modal body (find where `deliveryEvents.map(...)` is rendered), add below the timeline:
   - If `messageType === 'Email'` and `body` present: iframe-sandboxed HTML preview (`<iframe sandbox="" srcDoc={body} />`) with a "View raw HTML" toggle
   - If `messageType === 'SMS'` and `body` present: text block in a `<pre>` with a "Copy text" button (uses `navigator.clipboard.writeText(body)`)
   - If body missing: gray "Body not captured for this message." note

Sandbox attribute on iframe is critical — no scripts, no forms, no same-origin access. Prevents any stored body from running JS in the admin's browser.

4. Show `effectiveStatus` label next to `status` in the list and in the modal header. Uses the backend-computed value.

## 7. Safety / rollout plan

**Everything is additive. Core send paths keep their existing behavior.** Only the SendGrid `custom_args` addition and the INSERT column additions touch running code.

Staged rollout:

1. **Ship DB migration only** (§4a + §4b). Zero behavior change; zero-downtime DDL (ALTER ADD COLUMN NULL + CREATE TABLE are Azure SQL online ops). Verify in prod via `SELECT COUNT(*) FROM oe.MessageEvent`.

2. **Ship send-path code changes** (§5c + §5d) **behind a no-op check**: just start writing Body/FromAddress and custom_args. No UI consumes this yet. If something breaks (e.g., some template has a body too large), we see errors in the send path — but the send itself still succeeds because the INSERT columns are nullable and the custom_args addition can't fail the SendGrid call.

3. **Ship webhook handler** (§5a + §5b). Do NOT enable in SendGrid dashboard yet. Deploy the route + signature verification; manually POST a sample event via curl to staging to confirm insert works.

4. **Enable webhook in SendGrid dashboard** — only after step 3 is verified. SendGrid starts POSTing. Watch logs. Validate that `MessageEvent` is populating.

5. **Ship failures endpoint** (§5f) + details endpoint extension (§5e). Backend now queryable.

6. **Ship frontend** (§6). Users start seeing the panel + enhanced modal.

Each step is independently revertable:
- Step 1: drop column/table if needed (but data loss).
- Step 2: revert code; new rows after revert just stop populating the new columns.
- Step 3: disable route; no consumers.
- Step 4: disable webhook in SendGrid UI.
- Step 5: feature-flag endpoint.
- Step 6: hide the new panel behind a feature flag (`VITE_FEATURE_FAILED_MESSAGES`) for initial deploy; enable per-user first.

## 8. What we're NOT doing (v1)

- **Forward email to another address** — user dropped this feature (support can copy the body text out of the preview instead)
- **Standalone Failed Messages page** — reuse MessageHistoryPage with `?status=Failed` filter
- **Auto-suppression list** — separate future work; should be driven off `oe.MessageEvent` but designed as its own spec
- **Retention policy on MessageEvent** — keep all events for now; revisit at 6 months
- **Analytics charts on failures** — just a list for v1
- **Marketing/transactional subdomain split** — the larger infrastructure discussion is a separate spec
- **Multi-ESP fallback** — separate spec

## 9. Checklist (things smart devs do; things we must not break)

### Pre-implementation audit (do BEFORE writing code)
- [ ] Re-verify each file:line reference in §2 and §5 still matches trunk
- [ ] Confirm `@sendgrid/eventwebhook` is installable (or the verification logic isn't bundled elsewhere we can reuse)
- [ ] Confirm `oe.MessageEvent` table name does not clash with anything in `CampaignMessageLog` or other existing tables
- [ ] Confirm the exact SendGrid custom_args format for bulk personalizations (per-personalization vs top-level) — read SendGrid docs before step 2

### Safety guardrails
- [ ] New DB columns are NULL-default — **no** NOT NULL adds to existing tables
- [ ] No modifications to existing `INSERT INTO oe.MessageHistory` column lists; add new columns as *additional* parameters so a partial-rollback leaves behavior intact
- [ ] Webhook route is HMAC-verified; reject unauthenticated POSTs
- [ ] Iframe preview is `sandbox=""` — no JS, no forms, no same-origin access
- [ ] Failures endpoint scoped to tenant for non-SysAdmin
- [ ] MessageEvent insert is idempotent (UQ constraint handles retries)

### "Don't break production" (operational)
- [ ] DB migration runs as an ONLINE operation — Azure SQL: `ALTER TABLE ... ADD COLUMN <nullable>` and `CREATE TABLE` are online. Confirm on staging first.
- [ ] Deploy in the order listed in §7; do NOT collapse steps.
- [ ] Feature flag the new Analytics panel (`VITE_FEATURE_FAILED_MESSAGES`) so initial deploy is dark for end users.
- [ ] Gate the Twilio webhook (§5b) behind a separate flag; ship SendGrid-only for v1 if it saves time.
- [ ] Do NOT touch the existing `MessageProcessor` retry logic (bugs #1 and #2 have their own PRs).
- [ ] Do NOT modify MessageHistoryPage status filter behavior (support reads of `Status` column stay identical — new info lives in `effectiveStatus` alongside, not replacing).
- [ ] Log every webhook receipt + parse outcome for 2 weeks after go-live for debugging.
- [ ] Add a dev/test webhook secret separate from prod so local envs don't accept prod events if someone misconfigures.

### What will break if we're careless
- **If custom_args is added wrong in bulk personalizations**, SendGrid will reject the whole batch send with a 400. Test on a 2-recipient bulk before enabling in prod.
- **If MessageEvent has no index on MessageId**, the details endpoint query gets slow. The migration in §4a includes the index — verify it actually creates.
- **If the iframe preview is not sandboxed**, a stored malicious email body could execute JS in the admin's browser. Sandbox is the guardrail.
- **If the failures query is not tenant-scoped for non-SysAdmin**, one tenant sees another tenant's recipient addresses. The role check is in §5f — don't omit it.

## 10. Test plan

1. **DB migration (staging)**
   - Run ALTER + CREATE + index
   - Verify existing `INSERT INTO oe.MessageHistory` statements still succeed (don't set new columns)
   - Sanity: `SELECT COUNT(*) FROM oe.MessageEvent` returns 0

2. **Send-path augmentation (staging)**
   - Send one transactional email; assert `oe.MessageHistory.Body IS NOT NULL`
   - Send a 5-recipient bulk blast; assert all 5 rows have Body and FromAddress set
   - Inspect SendGrid Activity for one of those messages; confirm `custom_args.MessageId` appears in the payload

3. **Webhook ingestion (staging)**
   - Post a sample SendGrid event payload via curl; assert MessageEvent row created
   - Post the same payload again; assert no duplicate (UQ kicks in)
   - Post with bad signature; assert 401
   - Enable webhook in SendGrid sandbox; send test email; verify event arrives

4. **Failures endpoint (staging)**
   - Create 5 MessageHistory rows with synthetic MessageEvent entries: 1 delivered, 1 bounce, 1 deferred-only, 1 deferred-then-delivered, 1 dropped
   - Hit `/api/message-center/failures` — expect 3 rows (bounce, deferred-only, dropped). Deferred-then-delivered is excluded.
   - Hit with tenant-admin auth for a different tenant — expect 0 rows.

5. **UI (staging)**
   - Analytics page: panel renders; count matches endpoint
   - Click a row: opens the existing details modal
   - Modal: timeline shows real events (not just synthesized Sent/Failed)
   - Email preview iframe: renders HTML safely, no JS execution (test with a body containing `<script>alert(1)</script>` — should not fire)
   - SMS preview: Copy text button works

6. **Production smoke**
   - Deploy with flag OFF
   - Turn flag ON for one SysAdmin account
   - Trigger one real failure (send to a known-bad address); verify appears in panel within webhook latency (~seconds)
   - Full rollout after 24h clean

## 11. Open questions (none blocking)

None — all decisions made. Revisit if implementation uncovers surprises.

---

## Next steps after user review

- Spec committed to git
- Hand off to writing-plans skill → detailed implementation plan with tasks + acceptance criteria
- Implementation in a feature branch, PR per rollout stage
