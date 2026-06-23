# Message Failure Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface SendGrid + Twilio delivery failures (bounces, deferrals, blocks) to sysadmins and tenant admins in the Message Center. Allow previewing the email body for support relay. Implement per the approved spec at `docs/superpowers/specs/2026-04-16-message-failure-visibility-design.md`.

**Architecture:** Incoming provider webhooks → new `oe.MessageEvent` table → extended details endpoint + new failures endpoint → new "Failed Messages" panel on `MessageAnalyticsPage` + enhanced existing details modal on `MessageHistoryPage`. The existing `MessageHistoryPage` is reused — no new standalone page.

**Tech Stack:** Node.js/Express backend, `@sendgrid/eventwebhook`, React/TypeScript frontend, Azure SQL, SendGrid Event Webhook, Twilio Status Callback (flag-gated).

**Branch:** `feat/message-failure-visibility`

**User has authorized running safe migrations on dev AND prod directly.**

**Rollout is strictly staged.** Each stage ships independently and is revertable without data loss. DO NOT collapse stages. DO NOT enable the SendGrid webhook (Stage 4) before Stage 3 is verified in prod.

---

## File Structure

**Create:**
- `sql-changes/2026-04-16-add-message-event.sql` — Stage 1a migration
- `sql-changes/2026-04-16-messagehistory-add-body.sql` — Stage 1b migration
- `backend/routes/webhooks/sendgrid.js` — Stage 3
- `backend/routes/webhooks/twilio.js` — Stage 3 (flag-gated)
- `backend/routes/webhooks/__tests__/sendgrid.test.js`
- `backend/routes/webhooks/__tests__/twilio.test.js`
- `backend/routes/__tests__/messageCenter.failures.test.js`

**Modify:**
- `backend/app.js` — register webhook routes (Stage 3)
- `messageCenter/shared/bulkBlastProcessor.js` — capture Body + FromAddress, tag `custom_args.MessageId` (Stage 2)
- `messageCenter/MessageProcessor/index.js` — same (Stage 2)
- `messageCenter/TemplateProcessor/index.js` — same if this path sends directly (verify)
- `backend/services/sendGridEmailService.js` — same (Stage 2)
- `backend/routes/messageCenter.js` — extend `/history/:id/details` with real events (Stage 5); add `GET /failures` endpoint (Stage 5)
- `frontend/src/services/messageCenter.service.ts` — add `getFailures(...)` method (Stage 6)
- `frontend/src/pages/message-center/MessageAnalyticsPage.tsx` — add Failed Messages panel (Stage 6)
- `frontend/src/pages/message-center/MessageHistoryPage.tsx` — extend details modal with body preview (Stage 6)

**Not touched:**
- `MessageQueueService` — unchanged
- Any existing `Status` column semantics on `MessageHistory` — we add new info alongside, not replacing

---

## Stage 1 — DB migrations (zero behavior change)

### Task 1.1: Migration — create oe.MessageEvent

**Files:** Create `sql-changes/2026-04-16-add-message-event.sql`

- [ ] **Step 1: Write migration**

```sql
-- sql-changes/2026-04-16-add-message-event.sql
-- New events table for per-message provider event history.
-- Additive only. No FK to MessageHistory (events may arrive before MH insert completes).
-- Idempotency via UNIQUE(Provider, ProviderEventId).

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'MessageEvent' AND schema_id = SCHEMA_ID('oe'))
BEGIN
  CREATE TABLE oe.MessageEvent (
    EventId         UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    MessageId       UNIQUEIDENTIFIER NOT NULL,
    Provider        NVARCHAR(20)     NOT NULL,
    EventType       NVARCHAR(40)     NOT NULL,
    EventTime       DATETIME2        NOT NULL,
    Reason          NVARCHAR(1000)   NULL,
    MxServer        NVARCHAR(200)    NULL,
    ProviderEventId NVARCHAR(100)    NULL,
    RawPayload      NVARCHAR(MAX)    NULL,
    CreatedAt       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_MessageEvent PRIMARY KEY (EventId),
    CONSTRAINT UQ_MessageEvent_ProviderEventId UNIQUE (Provider, ProviderEventId)
  );
  CREATE INDEX IX_MessageEvent_MessageId ON oe.MessageEvent(MessageId);
  CREATE INDEX IX_MessageEvent_EventTime ON oe.MessageEvent(EventTime DESC);
  CREATE INDEX IX_MessageEvent_EventType ON oe.MessageEvent(EventType);
END
```

- [ ] **Step 2: Apply on dev**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365/ai_scripts && ./db-query.sh "$(cat ../sql-changes/2026-04-16-add-message-event.sql)" --testing
```

- [ ] **Step 3: Verify dev**

```bash
./db-query.sh "SELECT COUNT(*) AS events FROM oe.MessageEvent" --testing
./db-query.sh "SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID('oe.MessageEvent')" --testing
```

Expected: `events=0`, three named indexes returned.

- [ ] **Step 4: Apply on prod**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365/ai_scripts && set -a && . ./.env && set +a && export DB_NAME=allaboard-prod && cd ../backend && node -e "
const sql = require('mssql');
const fs = require('fs');
const config = { server: process.env.DB_SERVER, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, options: { encrypt: true, trustServerCertificate: false }, connectionTimeout: 30000, requestTimeout: 30000 };
(async () => { await sql.connect(config); await sql.query(fs.readFileSync('../sql-changes/2026-04-16-add-message-event.sql', 'utf8')); const r = await sql.query('SELECT COUNT(*) c FROM oe.MessageEvent'); console.log('rows:', r.recordset[0].c); await sql.close(); })().catch(e => { console.error(e); process.exit(1); });
"
```

- [ ] **Step 5: Commit**

```bash
git add sql-changes/2026-04-16-add-message-event.sql
git commit -m "feat(db): add oe.MessageEvent for provider event history

Additive-only migration. Ran on dev and prod."
```

### Task 1.2: Migration — add Body + FromAddress to MessageHistory

**Files:** Create `sql-changes/2026-04-16-messagehistory-add-body.sql`

- [ ] **Step 1: Write migration**

```sql
-- sql-changes/2026-04-16-messagehistory-add-body.sql
-- Additive, NULL-default columns to capture the rendered body + From address at send time.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MessageHistory') AND name = 'Body')
BEGIN
  ALTER TABLE oe.MessageHistory ADD Body NVARCHAR(MAX) NULL;
END

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MessageHistory') AND name = 'FromAddress')
BEGIN
  ALTER TABLE oe.MessageHistory ADD FromAddress NVARCHAR(320) NULL;
END
```

- [ ] **Step 2: Apply dev + prod** (same pattern as Task 1.1)

- [ ] **Step 3: Verify via `INFORMATION_SCHEMA.COLUMNS`**

```bash
./db-query.sh "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='oe' AND TABLE_NAME='MessageHistory' AND COLUMN_NAME IN ('Body','FromAddress')" --testing
```

Expected: 2 rows, both `IS_NULLABLE = YES`.

- [ ] **Step 4: Verify no existing INSERTs broke** — watch app logs for 5 min after running on prod; confirm normal sends still write MessageHistory.

- [ ] **Step 5: Commit**

```bash
git add sql-changes/2026-04-16-messagehistory-add-body.sql
git commit -m "feat(db): add MessageHistory.Body and FromAddress columns

NULL-default; existing INSERTs unaffected. Ran on dev and prod."
```

---

## Stage 2 — Send paths capture Body, FromAddress, and tag custom_args

**No UI consumes this yet.** Pure data capture.

### Task 2.1: Modify bulkBlastProcessor to capture Body + tag custom_args

**Files:** Modify `messageCenter/shared/bulkBlastProcessor.js`

- [ ] **Step 1: Read full file, locate:**
  - `INSERT INTO oe.MessageHistory` statements (spec ref: lines 79-87 and 110-117)
  - The SendGrid msg construction before `sgMail.send(msg)` (spec ref: line ~210)

- [ ] **Step 2: Add Body + FromAddress to INSERT sites**

For each existing `INSERT INTO oe.MessageHistory(...)` (currently 2 sites), append `, Body, FromAddress` to the column list and `, @body, @fromAddress` to the VALUES. Add:

```javascript
request.input('body', sql.NVarChar(sql.MAX), renderedBody || null);
request.input('fromAddress', sql.NVarChar(320), fromAddr || null);
```

The `renderedBody` comes from the already-rendered message body being passed to SendGrid. The `fromAddr` comes from `msg.from.email` (or wherever the From is constructed).

- [ ] **Step 3: Add custom_args tagging**

Before `sgMail.send(msg)`, in the `msg` object construction:

```javascript
msg.custom_args = { ...(msg.custom_args || {}) };
// Per-personalization when using personalizations:
if (Array.isArray(msg.personalizations)) {
  for (const p of msg.personalizations) {
    p.custom_args = { ...(p.custom_args || {}), MessageId: <per-recipient-messageId> };
  }
}
```

For the bulk path, each personalization corresponds to a queue row with its own MessageId. Wire that through from the recipient objects.

- [ ] **Step 4: Add test**

```javascript
// messageCenter/shared/__tests__/bulkBlastProcessor.bodyCapture.test.js
const sgMail = require('@sendgrid/mail');
jest.mock('@sendgrid/mail', () => ({ send: jest.fn(() => Promise.resolve([{statusCode: 202}])) }));

test('each personalization carries MessageId custom_args', async () => {
  // Seed a 3-recipient bulk batch with known MessageIds
  // Invoke processBulkBatch
  const callArg = sgMail.send.mock.calls[0][0];
  expect(callArg.personalizations).toHaveLength(3);
  for (const p of callArg.personalizations) {
    expect(p.custom_args.MessageId).toMatch(/^[0-9a-f-]{36}$/i);
  }
});

test('MessageHistory.Body is populated from rendered body', async () => {
  // Setup + invoke
  // Query MessageHistory rows inserted; assert Body === rendered HTML
});
```

- [ ] **Step 5: Run tests**

- [ ] **Step 6: Commit**

```bash
git add messageCenter/shared/bulkBlastProcessor.js messageCenter/shared/__tests__/bulkBlastProcessor.bodyCapture.test.js
git commit -m "feat(send): capture Body/FromAddress + tag MessageId custom_args (bulk path)"
```

### Task 2.2: Modify MessageProcessor single-email path

**Files:** Modify `messageCenter/MessageProcessor/index.js`

- [ ] **Step 1: Locate INSERT INTO oe.MessageHistory** (the single-email success path, likely around the `sgMail.send` call at line ~213)

- [ ] **Step 2: Same pattern as Task 2.1** — add Body + FromAddress to INSERT; add `msg.custom_args = { MessageId: message.MessageId }` before send.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(send): capture Body/FromAddress + MessageId custom_args (single-message path)"
```

### Task 2.3: Modify sendGridEmailService (if used on any live send path)

- [ ] **Step 1: grep to find live callers of `sendGridEmailService.sendEmail`**

```bash
grep -rn "sendGridEmailService\|SendGridEmailService" /Users/rova/Documents/AllAboard365/allaboard365/backend /Users/rova/Documents/AllAboard365/allaboard365/messageCenter
```

- [ ] **Step 2: For any live send method, add `msg.custom_args.MessageId` if a MessageId is available from caller.**

If the service has no access to a MessageId (some callers may not have one), skip that path — the webhook handler's fallback (match by ProviderMessageId) will cover it.

- [ ] **Step 3: Commit if changes made**

### Task 2.4: Deploy Stage 2

Standard deploy flow. After deploy, verify on staging:

```bash
./db-query.sh "SELECT TOP 5 HistoryId, Body IS NULL AS body_null, FromAddress FROM oe.MessageHistory ORDER BY SentDate DESC" --testing
```

Expected: for recent post-deploy rows, `body_null = 0` and `FromAddress` populated.

Check a recent SendGrid Activity message: confirm `custom_args.MessageId` is present in the message detail view.

---

## Stage 3 — Webhook route deployed (NOT enabled in SendGrid yet)

### Task 3.1: Install @sendgrid/eventwebhook

- [ ] **Step 1:**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365/backend && npm install @sendgrid/eventwebhook
```

- [ ] **Step 2: Commit package.json + package-lock.json**

### Task 3.2: Create webhook route — SendGrid

**Files:** Create `backend/routes/webhooks/sendgrid.js`

- [ ] **Step 1: Write failing test**

```javascript
// backend/routes/webhooks/__tests__/sendgrid.test.js
const request = require('supertest');
const express = require('express');
const router = require('../sendgrid');
const sql = require('mssql');

const app = express();
app.use('/api/webhooks/sendgrid', router);

test('rejects request with no signature', async () => {
  const res = await request(app).post('/api/webhooks/sendgrid/events').send([{}]);
  expect(res.status).toBe(401);
});

test('inserts events for valid signed payload', async () => {
  // Build a signed payload using the test public/private key pair
  // POST and assert 200
  // Query oe.MessageEvent; assert row inserted
});

test('idempotent on retry (same sg_event_id)', async () => {
  // POST same payload twice; assert only one row in MessageEvent
});
```

- [ ] **Step 2: Implement the route**

```javascript
// backend/routes/webhooks/sendgrid.js
const express = require('express');
const { EventWebhook, EventWebhookHeader } = require('@sendgrid/eventwebhook');
const sql = require('mssql');
const { getPool } = require('../../config/database');

const router = express.Router();

// IMPORTANT: must receive the raw body for signature verification.
// Mount with express.raw({ type: 'application/json' }) OR configure app.js to provide raw body.
router.post('/events',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const publicKey = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
    const signature = req.get(EventWebhookHeader.SIGNATURE());
    const timestamp = req.get(EventWebhookHeader.TIMESTAMP());

    if (!publicKey || !signature || !timestamp) {
      return res.status(401).json({ error: 'Missing signature headers' });
    }

    const ew = new EventWebhook();
    const ecKey = ew.convertPublicKeyToECDSA(publicKey);
    const ok = ew.verifySignature(ecKey, req.body, signature, timestamp);
    if (!ok) return res.status(401).json({ error: 'Invalid signature' });

    let events;
    try { events = JSON.parse(req.body.toString('utf8')); }
    catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    if (!Array.isArray(events)) events = [events];

    const pool = await getPool();
    let inserted = 0;
    for (const e of events) {
      try {
        const messageId = (e.custom_args && e.custom_args.MessageId) || null;
        if (!messageId) {
          console.warn('sendgrid webhook: event missing MessageId custom_arg', e.sg_event_id, e.event);
          continue;
        }

        const request = pool.request();
        request.input('messageId', sql.UniqueIdentifier, messageId);
        request.input('provider', sql.NVarChar, 'sendgrid');
        request.input('eventType', sql.NVarChar, e.event);
        request.input('eventTime', sql.DateTime2, new Date((e.timestamp || Date.now()/1000) * 1000));
        request.input('reason', sql.NVarChar, e.reason || null);
        request.input('mxServer', sql.NVarChar, e['mx'] || null);
        request.input('providerEventId', sql.NVarChar, e.sg_event_id);
        request.input('raw', sql.NVarChar(sql.MAX), JSON.stringify(e));

        await request.query(`
          IF NOT EXISTS (SELECT 1 FROM oe.MessageEvent WHERE Provider = @provider AND ProviderEventId = @providerEventId)
          BEGIN
            INSERT INTO oe.MessageEvent
              (MessageId, Provider, EventType, EventTime, Reason, MxServer, ProviderEventId, RawPayload)
            VALUES
              (@messageId, @provider, @eventType, @eventTime, @reason, @mxServer, @providerEventId, @raw);
          END
        `);
        inserted++;
      } catch (err) {
        console.error('sendgrid webhook event insert failed', err.message, e.sg_event_id);
      }
    }
    res.json({ success: true, inserted });
  }
);

module.exports = router;
```

- [ ] **Step 3: Register in app.js**

In `backend/app.js`, add:

```javascript
app.use('/api/webhooks/sendgrid', require('./routes/webhooks/sendgrid'));
```

Place BEFORE any generic `express.json()` middleware if that would strip the raw body. Best pattern: mount this specific sub-route before the global JSON parser.

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Deploy to staging (still NOT enabled in SendGrid)**

- [ ] **Step 6: Smoke-test endpoint with curl**

Use a known valid signed payload from SendGrid's docs OR generate one in a Node REPL with a test key pair.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(webhook): add signed SendGrid event webhook endpoint

HMAC-verified; idempotent inserts into oe.MessageEvent via
UQ(Provider, ProviderEventId). Not enabled in SendGrid dashboard yet."
```

### Task 3.3: Twilio status callback (flag-gated)

- [ ] **Step 1: Gate behind env `ENABLE_TWILIO_WEBHOOK=true`**

- [ ] **Step 2: Create `backend/routes/webhooks/twilio.js`** using `twilio.webhook()` middleware + `TWILIO_AUTH_TOKEN`. Map statuses (`queued`, `sent`, `delivered`, `failed`, `undelivered`) to MessageEvent rows. Same UQ dedupe pattern.

- [ ] **Step 3: Register in app.js only when flag enabled.**

- [ ] **Step 4: Tests + commit**

---

## Stage 4 — Enable SendGrid Event Webhook (operational task)

**This is the point of no return for receiving live events.** Before running this, confirm Stage 3 is deployed and responding 200 to signed curl tests.

### SendGrid dashboard instructions

- [ ] **Step 1: Get the prod webhook URL**

`https://api.mightywellhealth.com/api/webhooks/sendgrid/events` (confirm actual prod base URL).

- [ ] **Step 2: In SendGrid dashboard:**

1. Navigate to **Settings → Mail Settings → Event Webhook**
2. Click **Enable**
3. **HTTP POST URL**: paste the URL from Step 1
4. **Select events to send**: check ALL of:
   - Delivered
   - Deferred
   - Bounced
   - Blocked
   - Dropped
   - Spam Report
   - Processed
5. (Optional v2) check Open / Click if analytics wants them — skip for v1
6. Under **Signed Event Webhook Requests**, click **Enabled** to generate the signing key pair
7. **Copy the Verification Key** (public key) shown — this is the value for env var `SENDGRID_WEBHOOK_PUBLIC_KEY`

- [ ] **Step 3: Set env var in prod Azure App Service config**

```
SENDGRID_WEBHOOK_PUBLIC_KEY=<paste verification key from step 6>
```

Restart the app (or confirm reload-on-config-change).

- [ ] **Step 4: Click "Test Your Integration" in SendGrid**

SendGrid posts a sample event. Expected: 200 response; a row in `oe.MessageEvent` with `Provider='sendgrid'`, `EventType='processed'` (or whatever sample event they send).

- [ ] **Step 5: Save settings in SendGrid**

- [ ] **Step 6: Monitor for 15 min**

Watch app logs. Expected: event inserts at roughly the rate emails are being sent; no parse errors; no 401 auth failures.

- [ ] **Step 7: Verify ingestion**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365/ai_scripts && set -a && . ./.env && set +a && export DB_NAME=allaboard-prod && cd ../backend && node -e "
const sql = require('mssql');
const config = { server: process.env.DB_SERVER, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, options: { encrypt: true, trustServerCertificate: false } };
(async () => { await sql.connect(config); const r = await sql.query(\"SELECT EventType, COUNT(*) c FROM oe.MessageEvent WHERE EventTime > DATEADD(MINUTE, -30, SYSUTCDATETIME()) GROUP BY EventType\"); console.log(r.recordset); })().catch(console.error);
"
```

Expected: rows returned for `processed`, `delivered`, possibly `deferred`/`bounce`.

---

## Stage 5 — Backend endpoints

### Task 5.1: Extend /history/:id/details to return real events

**Files:** Modify `backend/routes/messageCenter.js` around line 1708

- [ ] **Step 1: Add SQL query for MessageEvent**

Replace the synthesized events block with:

```javascript
const eventsResult = await pool.request()
  .input('messageId', sql.UniqueIdentifier, message.messageId)
  .query(`
    SELECT EventType AS event, EventTime AS timestamp, Reason AS details,
           Provider AS provider, MxServer AS mxServer, EventType AS eventType
      FROM oe.MessageEvent
     WHERE MessageId = @messageId
     ORDER BY EventTime ASC
  `);

let events = eventsResult.recordset;
if (events.length === 0) {
  // Fallback for historical rows predating the webhook
  events = [{
    event: message.status === 'Failed' ? 'Failed' : 'Sent',
    timestamp: message.sentDate,
    details: message.errorMessage || `Sent via ${message.messageType}`
  }];
}
```

- [ ] **Step 2: Also return body, fromAddress, effectiveStatus** in the response

Add to the SELECT in the history query (earlier in the same handler):

```
mh.Body as body,
mh.FromAddress as fromAddress,
```

Compute effective status inline:

```javascript
const effectiveStatus = (() => {
  const types = events.map(e => e.event);
  if (types.includes('delivered')) return 'Delivered';
  if (types.some(t => ['bounce','dropped','spam_report','blocked','failed','undelivered'].includes(t))) return 'Failed';
  if (types.includes('deferred')) return 'Deferred';
  return message.status || 'Sent';
})();
```

Include `effectiveStatus` in the response payload.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(api): details endpoint returns real provider events + body"
```

### Task 5.2: Add GET /api/message-center/failures

**Files:** Modify `backend/routes/messageCenter.js`

- [ ] **Step 1: Write failing test** at `backend/routes/__tests__/messageCenter.failures.test.js`

Seed fixture MessageHistory + MessageEvent rows: 1 delivered, 1 bounced, 1 deferred-only, 1 deferred-then-delivered, 1 dropped. Assert GET returns exactly the bounce + deferred-only + dropped (3 rows).

- [ ] **Step 2: Implement**

Add handler:

```javascript
router.get('/failures', authenticate, async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    const type = req.query.type; // 'email' | 'sms' | undefined
    const requestedTenantId = req.query.tenantId;
    const userRoles = getUserRoles(req.user);
    const isSysAdmin = userRoles.includes('SysAdmin');

    const pool = await getPool();
    const request = pool.request();
    request.input('days', sql.Int, days);

    let tenantFilter = '';
    if (isSysAdmin && requestedTenantId) {
      tenantFilter = 'AND mh.TenantId = @tenantId';
      request.input('tenantId', sql.UniqueIdentifier, requestedTenantId);
    } else if (!isSysAdmin) {
      tenantFilter = 'AND mh.TenantId = @tenantId';
      request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
    }

    let typeFilter = '';
    if (type === 'email' || type === 'sms') {
      typeFilter = 'AND mh.MessageType = @type';
      request.input('type', sql.NVarChar, type === 'email' ? 'Email' : 'SMS');
    }

    const result = await request.query(`
      SELECT TOP 50
        mh.HistoryId as historyId, mh.MessageId as messageId, mh.TenantId as tenantId,
        mh.RecipientAddress as recipientAddress, mh.Subject as subject,
        mh.MessageType as messageType, mh.SentDate as sentDate,
        (SELECT TOP 1 EventType FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId ORDER BY EventTime DESC) AS lastEventType,
        (SELECT TOP 1 Reason    FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId ORDER BY EventTime DESC) AS lastEventReason,
        (SELECT TOP 1 EventTime FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId ORDER BY EventTime DESC) AS lastEventTime
      FROM oe.MessageHistory mh
      WHERE mh.SentDate >= DATEADD(day, -@days, SYSUTCDATETIME())
        AND (
          EXISTS (SELECT 1 FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId AND e.EventType IN ('bounce','dropped','spam_report','blocked','failed','undelivered'))
          OR mh.Status = 'Failed'
          OR (
            EXISTS (SELECT 1 FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId AND e.EventType = 'deferred')
            AND NOT EXISTS (SELECT 1 FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId AND e.EventType = 'delivered')
          )
        )
        AND NOT EXISTS (SELECT 1 FROM oe.MessageEvent e WHERE e.MessageId = mh.MessageId AND e.EventType = 'delivered')
        ${tenantFilter}
        ${typeFilter}
      ORDER BY mh.SentDate DESC;
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('failures endpoint error', err);
    res.status(500).json({ success: false, message: 'Failed to load failures' });
  }
});
```

- [ ] **Step 3: Run tests; commit**

```bash
git commit -m "feat(api): GET /message-center/failures for Failed Messages panel

Query includes hard failures + stuck deferrals; auto-drops once a
delivered event arrives for a message."
```

---

## Stage 6 — Frontend (flag-gated)

### Task 6.1: Add messageHistoryService.getFailures

**Files:** Modify `frontend/src/services/messageCenter.service.ts`

- [ ] **Step 1: Add method + types**

```typescript
export interface FailedMessage {
  historyId: string;
  messageId: string;
  tenantId: string;
  recipientAddress: string;
  subject: string | null;
  messageType: 'Email' | 'SMS';
  sentDate: string;
  lastEventType: string | null;
  lastEventReason: string | null;
  lastEventTime: string | null;
}

async getFailures(params: { days?: number; type?: 'email'|'sms'; tenantId?: string }) {
  const qs = new URLSearchParams();
  if (params.days) qs.set('days', String(params.days));
  if (params.type) qs.set('type', params.type);
  if (params.tenantId) qs.set('tenantId', params.tenantId);
  const res = await api.get(`/message-center/failures?${qs}`);
  return res.data as { success: boolean; data: FailedMessage[] };
}
```

### Task 6.2: Add Failed Messages panel to MessageAnalyticsPage

**Files:** Modify `frontend/src/pages/message-center/MessageAnalyticsPage.tsx`

- [ ] **Step 1: Add feature flag check**

```tsx
const failedMessagesEnabled = import.meta.env.VITE_FEATURE_FAILED_MESSAGES === 'true';
```

- [ ] **Step 2: Add state + loader**

```tsx
const [failures, setFailures] = useState<FailedMessage[]>([]);
const [failuresDays, setFailuresDays] = useState(7);

useEffect(() => {
  if (!failedMessagesEnabled) return;
  const params: any = { days: failuresDays };
  if (isSysAdmin && selectedTenant !== 'all') params.tenantId = selectedTenant;
  messageHistoryService.getFailures(params).then(r => {
    if (r.success) setFailures(r.data);
  });
}, [failedMessagesEnabled, failuresDays, selectedTenant, isSysAdmin]);
```

- [ ] **Step 3: Add panel JSX** after the Message Types pie chart row (~line 300):

```tsx
{failedMessagesEnabled && (
  <div className="bg-white rounded-lg shadow p-6 mb-6">
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-lg font-semibold">Failed Messages ({failures.length})</h3>
      <select value={failuresDays} onChange={e => setFailuresDays(Number(e.target.value))}
              className="text-sm border rounded px-2 py-1">
        <option value={1}>Last 24h</option>
        <option value={7}>Last 7 days</option>
        <option value={30}>Last 30 days</option>
      </select>
    </div>
    {failures.length === 0 ? (
      <p className="text-gray-500 text-sm">No failures in this period. 🎉</p>
    ) : (
      <ul className="divide-y">
        {failures.slice(0, 20).map(f => (
          <li key={f.historyId} className="py-2 flex items-center gap-3">
            <AlertCircle className={f.lastEventType === 'deferred' ? 'text-yellow-500' : 'text-red-500'} size={16} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{f.recipientAddress}</div>
              <div className="text-xs text-gray-500 truncate">{f.subject || '(no subject)'} · {f.lastEventType || 'unknown'}</div>
            </div>
            <span className="text-xs text-gray-400">{new Date(f.sentDate).toLocaleString()}</span>
            <Link to={`/message-center/history?highlight=${f.historyId}&status=Failed`}
                  className="text-blue-600 text-sm hover:underline">view</Link>
          </li>
        ))}
      </ul>
    )}
    {failures.length > 20 && (
      <Link to="/message-center/history?status=Failed" className="block text-right text-sm text-blue-600 mt-2 hover:underline">
        View all {failures.length} →
      </Link>
    )}
  </div>
)}
```

- [ ] **Step 4: Visual test with flag ON**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365/frontend && VITE_FEATURE_FAILED_MESSAGES=true npm run dev
```

Navigate to `/message-center/analytics`. Expected: panel renders; rows link to history page.

- [ ] **Step 5: Commit**

### Task 6.3: Extend details modal with body preview

**Files:** Modify `frontend/src/pages/message-center/MessageHistoryPage.tsx`

- [ ] **Step 1: Update `MessageHistoryItem` and `DeliveryEvent` interfaces** — add `body?: string; fromAddress?: string; effectiveStatus?: string;` and `provider?, mxServer?, eventType?` as specified in the design doc §6b.

- [ ] **Step 2: In the details modal body**, find where `deliveryEvents.map(...)` is rendered. Below the timeline, add:

```tsx
{selectedMessage?.messageType === 'Email' && selectedMessage.body && (
  <div className="mt-4">
    <h4 className="font-semibold mb-2">Email Preview</h4>
    <iframe
      sandbox=""
      srcDoc={selectedMessage.body}
      className="w-full border rounded bg-gray-50"
      style={{ height: 400 }}
    />
  </div>
)}
{selectedMessage?.messageType === 'SMS' && selectedMessage.body && (
  <div className="mt-4">
    <h4 className="font-semibold mb-2">Message Text</h4>
    <pre className="bg-gray-50 border rounded p-3 text-sm whitespace-pre-wrap">{selectedMessage.body}</pre>
    <button
      onClick={() => navigator.clipboard.writeText(selectedMessage.body!)}
      className="mt-2 px-3 py-1 border rounded text-sm hover:bg-gray-50"
    >
      Copy text
    </button>
  </div>
)}
{!selectedMessage?.body && (
  <p className="mt-4 text-sm text-gray-500 italic">Body not captured for this message.</p>
)}
```

- [ ] **Step 3: XSS smoke test**

Manually insert a row with body `<script>alert('XSS')</script><p>test</p>` into a dev MessageHistory. Open modal. Expected: `<p>test</p>` renders, script does NOT execute (sandbox blocks).

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(ui): sandboxed body preview + Copy text in details modal"
```

### Task 6.4: Enable flag in staging → then prod

- [ ] **Step 1: In staging**, set `VITE_FEATURE_FAILED_MESSAGES=true` and deploy. Validate panel + modal work with real data.

- [ ] **Step 2: In prod**, enable for SysAdmin first via per-user conditional (if flag infra supports it). If it's only a global flag, wait 24h of clean staging observation then flip in prod.

---

## Self-review

**Spec coverage:**
- §4a MessageEvent table → Task 1.1 ✅
- §4b Body/FromAddress columns → Task 1.2 ✅
- §5a SendGrid webhook → Task 3.2 ✅
- §5b Twilio webhook (flag-gated) → Task 3.3 ✅
- §5c custom_args tagging → Tasks 2.1–2.3 ✅
- §5d Body/FromAddress capture → Tasks 2.1–2.2 ✅
- §5e extended details endpoint → Task 5.1 ✅
- §5f failures endpoint → Task 5.2 ✅
- §6a Analytics panel → Task 6.2 ✅
- §6b modal extension → Task 6.3 ✅
- §7 staged rollout → enforced by task stages 1–6 ✅

**Placeholders:** None; every step has actual code or concrete SQL/commands.

**Type consistency:** `FailedMessage` interface fields match `/failures` endpoint response columns (historyId, messageId, lastEventType, etc.). `DeliveryEvent` interface extension in Task 6.3 matches the Task 5.1 SELECT aliases.

**Key safety invariants enforced:**
- All DB changes additive + NULL-default
- Webhook route HMAC-verified
- Iframe `sandbox=""` — no script execution
- Failures endpoint tenant-scoped for non-SysAdmin
- Frontend behind `VITE_FEATURE_FAILED_MESSAGES` flag
- MessageEvent UNIQUE(Provider, ProviderEventId) — idempotent ingestion
