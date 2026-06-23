# Unified Message History + Status Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `MessageHistory.Status` to include `Deferred` and `Opened` driven by SendGrid webhook events, surface failure reasons in the History details modal, and retire the duplicative Failed Messages panel on Analytics.

**Architecture:** All changes are code-only (no schema migrations). Extend the existing webhook delivery tracker with a non-downgrade state machine, update the two frontend pages for the new status values, and close one client-facing logging gap (`shareRequestESSService` ESS PDFs to members via Graph API).

**Tech Stack:** Node 22 / Express / mssql (backend), React 18 / Vite 6 / TypeScript (frontend), Jest (backend tests).

**Spec:** `docs/superpowers/specs/2026-04-17-unified-message-history-status-design.md`

**Branch:** `feat/unified-message-history-status` (already created, spec already committed)

**Working directory:** `/Users/rova/Documents/AllAboard365/allaboard365/` (main worktree, ports 5173 frontend / 3001 backend)

---

## Task 1: Add non-downgrade status helper to delivery tracker

**Files:**
- Modify: `backend/services/sendGridEmailDeliveryTracking.service.js:132-159` (existing `terminalUpdateMessageHistory`)
- Modify: `backend/services/sendGridEmailDeliveryTracking.service.js:292-297` (exports)

This task adds a reusable helper that advances MessageHistory.Status to a target value ONLY if the current Status is in an allowed set. Terminal states (`Failed`, `Opened`) are never moved. Called by all event handlers in Task 2.

- [ ] **Step 1: Add the helper function after `terminalUpdateMessageHistory`**

Insert this function immediately after the closing `}` of `terminalUpdateMessageHistory` at line 159:

```javascript
/**
 * Advance MessageHistory.Status to targetStatus, but only if the current
 * Status is in allowedFromStatuses. Also appends the SendGrid event line
 * to ErrorMessage (cumulative log). No-op on rows whose Status is already
 * terminal or past the target in the state machine.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {string[]} keys  — provider id lookup keys (exact + normalized)
 * @param {string} line    — formatted SendGrid event line for ErrorMessage log
 * @param {string} targetStatus  — Deferred | Opened
 * @param {string[]} allowedFromStatuses  — Status values the row must currently hold
 * @returns {Promise<number>} rows affected (best-effort sum)
 */
async function advanceStatusIfAllowed(pool, keys, line, targetStatus, allowedFromStatuses) {
  let n = 0;
  const placeholders = allowedFromStatuses.map((_, i) => `@from${i}`).join(',');
  for (const k of keys) {
    const req = pool.request();
    req.input('line', sql.NVarChar(sql.MAX), line);
    req.input('st', sql.NVarChar(20), targetStatus);
    req.input('kExact', sql.NVarChar(300), k);
    req.input('kLike', sql.NVarChar(301), `${k}.%`);
    allowedFromStatuses.forEach((s, i) => req.input(`from${i}`, sql.NVarChar(20), s));
    const hr = await req.query(`
      UPDATE oe.MessageHistory
      SET
        ErrorMessage = CASE
          WHEN ErrorMessage IS NULL OR LTRIM(RTRIM(CAST(ErrorMessage AS NVARCHAR(MAX)))) = N'' THEN @line
          ELSE CAST(ErrorMessage AS NVARCHAR(MAX)) + NCHAR(10) + @line
        END,
        Status = @st
      WHERE MessageType = N'Email'
        AND (ProviderMessageId = @kExact OR ProviderMessageId LIKE @kLike)
        AND Status IN (${placeholders})
    `);
    n += (hr.rowsAffected && hr.rowsAffected[0]) || 0;
  }
  return n;
}
```

- [ ] **Step 2: Export the new helper**

Update the `module.exports` block at lines 292-297:

```javascript
module.exports = {
  insertQuickQuoteMessageHistory,
  applySendGridDeliveryEvent,
  providerIdLookupKeys,
  normalizeSendGridMessageIdForMatch,
  advanceStatusIfAllowed
};
```

- [ ] **Step 3: Run backend lint/syntax check**

Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/backend && node -c services/sendGridEmailDeliveryTracking.service.js`
Expected: no output (syntax OK)

- [ ] **Step 4: Commit**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365
git add backend/services/sendGridEmailDeliveryTracking.service.js
git commit -m "feat(tracker): add advanceStatusIfAllowed helper for non-downgrade status transitions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Handle `deferred` and `open` events in applySendGridDeliveryEvent

**Files:**
- Modify: `backend/services/sendGridEmailDeliveryTracking.service.js:243-290` (`applySendGridDeliveryEvent` function)

Add two new event paths. `deferred` moves only `Sent` → `Deferred`. `open` moves `Sent`/`Deferred`/`Delivered` → `Opened` but never overrides `Failed` or already-`Opened`. Existing `delivered`/`bounce`/`dropped` behavior is preserved; `processed` stays append-only.

- [ ] **Step 1: Update the event classification and add handlers**

Replace the function body of `applySendGridDeliveryEvent` (starting at line 243 up to the final closing brace at line 290). The full replacement:

```javascript
async function applySendGridDeliveryEvent(ev) {
  const eventType = ev && String(ev.event || '').toLowerCase();
  const sg = ev && ev.sg_message_id;
  if (!eventType || !sg) {
    return { ok: false, reason: 'missing_fields' };
  }

  const appendOnly = ['processed'];
  const terminal = ['delivered', 'bounce', 'dropped'];
  const deferredEvent = 'deferred';
  const openEvent = 'open';
  const handled = new Set([...appendOnly, ...terminal, deferredEvent, openEvent]);

  if (!handled.has(eventType)) {
    return { ok: false, reason: 'not_delivery_event' };
  }

  const keys = providerIdLookupKeys(sg);
  if (keys.length === 0) {
    return { ok: false, reason: 'empty_sg_message_id' };
  }

  const line = formatSendGridEventLine(ev);
  const pool = await getPool();

  if (appendOnly.includes(eventType)) {
    const historyRows = await appendSendGridLineMessageHistory(pool, keys, line);
    const emailLogRows = await appendSendGridLineEmailLogs(pool, keys, line);
    return { ok: true, event: eventType, historyRows, emailLogRows };
  }

  if (eventType === deferredEvent) {
    // Only advance Sent -> Deferred. Do NOT downgrade Delivered/Opened/Failed.
    const historyRows = await advanceStatusIfAllowed(pool, keys, line, 'Deferred', ['Sent']);
    const emailLogRows = await appendSendGridLineEmailLogs(pool, keys, line);
    return { ok: true, event: eventType, historyRows, emailLogRows };
  }

  if (eventType === openEvent) {
    // Advance Sent/Deferred/Delivered -> Opened. Never override Opened/Failed.
    const historyRows = await advanceStatusIfAllowed(
      pool,
      keys,
      line,
      'Opened',
      ['Sent', 'Deferred', 'Delivered']
    );
    const emailLogRows = await appendSendGridLineEmailLogs(pool, keys, line);
    return { ok: true, event: eventType, historyRows, emailLogRows };
  }

  if (terminal.includes(eventType)) {
    const nextMH = eventType === 'delivered' ? 'Delivered' : 'Failed';
    const nextEL = eventType === 'delivered' ? 'delivered' : 'failed';
    const historyRows = await terminalUpdateMessageHistory(pool, keys, line, nextMH);
    const emailLogRows = await terminalUpdateEmailLogs(pool, keys, line, nextEL);
    return { ok: true, event: eventType, historyRows, emailLogRows };
  }

  return { ok: false, reason: 'not_delivery_event' };
}
```

- [ ] **Step 2: Update the JSDoc comment**

Replace the JSDoc block at lines 239-242 with:

```javascript
/**
 * Apply one SendGrid event to MessageHistory and EmailLogs.
 * Status transitions (never downgrade):
 *   processed           → append-only log, no Status change
 *   deferred            → Status: Sent → Deferred
 *   delivered           → Status: → Delivered (unless Failed)
 *   bounce/dropped      → Status: → Failed
 *   open                → Status: Sent/Deferred/Delivered → Opened
 * @param {object} ev — raw SendGrid event object
 */
```

- [ ] **Step 3: Syntax check**

Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/backend && node -c services/sendGridEmailDeliveryTracking.service.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add backend/services/sendGridEmailDeliveryTracking.service.js
git commit -m "feat(tracker): handle deferred and open events with no-downgrade state machine

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Write unit tests for the state machine

**Files:**
- Create: `backend/services/__tests__/sendGridEmailDeliveryTracking.test.js`

Test each transition end-to-end with a mocked `mssql` pool so we verify the SQL shape (WHERE Status IN (...)) and the result-routing logic.

- [ ] **Step 1: Create the test file**

Create `backend/services/__tests__/sendGridEmailDeliveryTracking.test.js` with this content:

```javascript
/**
 * Tests for sendGridEmailDeliveryTracking.service.js — state machine transitions.
 * Mocks the mssql pool so we assert the SQL shape + which row-count path the
 * handler returned, without hitting a real DB.
 */

const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = { input: mockInput, query: mockQuery };

jest.mock('../../config/database', () => ({
  getPool: jest.fn(() => Promise.resolve({ request: () => mockRequest })),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: (n) => `NVarChar(${n || 'default'})`,
    DateTime2: 'DateTime2',
    MAX: 'MAX'
  }
}));

const { applySendGridDeliveryEvent } = require('../sendGridEmailDeliveryTracking.service');

function buildEvent(overrides = {}) {
  return {
    event: 'delivered',
    sg_message_id: 'abc123xyz.recvd-foo-1',
    timestamp: 1712000000,
    ...overrides
  };
}

describe('applySendGridDeliveryEvent', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockInput.mockClear();
    mockQuery.mockResolvedValue({ rowsAffected: [1] });
  });

  test('rejects when event type or sg_message_id is missing', async () => {
    expect(await applySendGridDeliveryEvent({})).toEqual({ ok: false, reason: 'missing_fields' });
    expect(await applySendGridDeliveryEvent({ event: 'delivered' })).toEqual({ ok: false, reason: 'missing_fields' });
    expect(await applySendGridDeliveryEvent({ sg_message_id: 'x' })).toEqual({ ok: false, reason: 'missing_fields' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rejects unknown event types', async () => {
    const res = await applySendGridDeliveryEvent(buildEvent({ event: 'unsubscribe' }));
    expect(res).toEqual({ ok: false, reason: 'not_delivery_event' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('processed event: append-only (no Status change)', async () => {
    const res = await applySendGridDeliveryEvent(buildEvent({ event: 'processed' }));
    expect(res.ok).toBe(true);
    expect(res.event).toBe('processed');
    const allSql = mockQuery.mock.calls.map(c => c[0]).join('\n');
    expect(allSql).not.toMatch(/SET\s+[^S]*Status\s*=/i);
  });

  test('deferred event: SQL guards Status IN (Sent) only', async () => {
    const res = await applySendGridDeliveryEvent(buildEvent({ event: 'deferred' }));
    expect(res.ok).toBe(true);
    expect(res.event).toBe('deferred');
    const mhSql = mockQuery.mock.calls.find(c => /UPDATE oe\.MessageHistory/i.test(c[0]))[0];
    expect(mhSql).toMatch(/Status\s*=\s*@st/);
    expect(mhSql).toMatch(/Status\s+IN\s*\(@from0\)/);
    const stBinding = mockInput.mock.calls.find(c => c[0] === 'st');
    const fromBinding = mockInput.mock.calls.find(c => c[0] === 'from0');
    expect(stBinding[2]).toBe('Deferred');
    expect(fromBinding[2]).toBe('Sent');
  });

  test('open event: SQL guards Status IN (Sent, Deferred, Delivered)', async () => {
    const res = await applySendGridDeliveryEvent(buildEvent({ event: 'open' }));
    expect(res.ok).toBe(true);
    expect(res.event).toBe('open');
    const mhSql = mockQuery.mock.calls.find(c => /UPDATE oe\.MessageHistory/i.test(c[0]))[0];
    expect(mhSql).toMatch(/Status\s+IN\s*\(@from0,@from1,@from2\)/);
    const fromValues = ['from0', 'from1', 'from2'].map(k =>
      mockInput.mock.calls.find(c => c[0] === k)[2]
    );
    expect(fromValues).toEqual(['Sent', 'Deferred', 'Delivered']);
    const stBinding = mockInput.mock.calls.find(c => c[0] === 'st');
    expect(stBinding[2]).toBe('Opened');
  });

  test('delivered event: uses terminal update (keeps Failed semantics)', async () => {
    const res = await applySendGridDeliveryEvent(buildEvent({ event: 'delivered' }));
    expect(res.ok).toBe(true);
    expect(res.event).toBe('delivered');
    const mhSql = mockQuery.mock.calls.find(c => /UPDATE oe\.MessageHistory/i.test(c[0]))[0];
    expect(mhSql).toMatch(/WHEN @st = N'Delivered' AND Status = N'Failed' THEN Status/);
  });

  test('bounce event: terminal update with Failed', async () => {
    const res = await applySendGridDeliveryEvent(buildEvent({ event: 'bounce' }));
    expect(res.ok).toBe(true);
    expect(res.event).toBe('bounce');
    const stBinding = mockInput.mock.calls.find(c => c[0] === 'st');
    expect(stBinding[2]).toBe('Failed');
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/backend && npx jest services/__tests__/sendGridEmailDeliveryTracking.test.js`
Expected: 7/7 pass

- [ ] **Step 3: Commit**

```bash
git add backend/services/__tests__/sendGridEmailDeliveryTracking.test.js
git commit -m "test(tracker): cover deferred/open state-machine transitions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Retire `/api/message-center/failures` endpoint

**Files:**
- Modify: `backend/routes/messageCenter.js:1873-1965` (delete JSDoc + route + helpers)
- Modify: `backend/routes/__tests__/messageCenter.failures.test.js` (delete file)

The Failed Messages panel is the only caller. Once removed from the frontend (Task 6), this endpoint is dead code.

- [ ] **Step 1: Delete the failures endpoint block**

Open `backend/routes/messageCenter.js` and delete lines 1873-1965 (inclusive) — the JSDoc comment starting with `* GET /api/message-center/failures`, the entire `router.get('/failures', ...)` handler, and its closing `});`. After deletion, the file should flow directly from the end of the `/history/:id/details` endpoint into `/history/export` (line 1971 in the old numbering).

Use this shell command to verify the range to delete — it should show the JSDoc on the first line and the closing `});` on the last:

Run: `sed -n '1873p;1965p' /Users/rova/Documents/AllAboard365/allaboard365/backend/routes/messageCenter.js`

If the first line starts with `/**` or `* GET /api/message-center/failures` and the last line is `});`, the range is correct. Delete those lines with your editor.

- [ ] **Step 2: Delete the failures test file**

Run: `rm /Users/rova/Documents/AllAboard365/allaboard365/backend/routes/__tests__/messageCenter.failures.test.js`

- [ ] **Step 3: Run backend syntax check**

Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/backend && node -c app.js`
Expected: no output

- [ ] **Step 4: Run remaining messageCenter tests**

Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/backend && npx jest routes/messageCenter`
Expected: all pass (failures test is gone; no others should regress)

- [ ] **Step 5: Commit**

```bash
git add backend/routes/messageCenter.js backend/routes/__tests__/messageCenter.failures.test.js
git commit -m "refactor(backend): retire /api/message-center/failures endpoint and tests

The only caller was the flag-gated Failed Messages panel on
MessageAnalyticsPage, which is being removed in a follow-up commit.
Users see failures via Message History with Status=Failed filter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Remove the Failed Messages panel from MessageAnalyticsPage

**Files:**
- Modify: `frontend/src/pages/message-center/MessageAnalyticsPage.tsx`

Strip the flag-gated panel, the flag itself, the related state, and the data-fetch effect. Keep everything else (charts, stats cards, tenant summaries) intact.

- [ ] **Step 1: Remove the flag-gated JSX block**

Delete lines 340-398 in `MessageAnalyticsPage.tsx` — the entire block starting with `{/* Failed Messages Panel (flag-gated) */}` and ending with the closing `)}` of `{failedMessagesEnabled && (`. The next visible JSX element after removal should be `{/* Tenant Summary Table - Only show for SysAdmin */}`.

- [ ] **Step 2: Remove the failures-loading useEffect**

Delete lines 109-129 (the `// Load failed messages (flag-gated)` comment through the closing `}, [failedMessagesEnabled, ...])`):

```javascript
  // Load failed messages (flag-gated)
  useEffect(() => {
    if (!failedMessagesEnabled) return;
    // ... (entire effect body)
  }, [failedMessagesEnabled, failuresDays, selectedTenant, isSysAdmin]);
```

- [ ] **Step 3: Remove the flag const and failures state**

Delete line 34:
```javascript
const failedMessagesEnabled = import.meta.env.VITE_FEATURE_FAILED_MESSAGES === 'true';
```

Delete lines 32-33:
```javascript
const [failures, setFailures] = useState<FailedMessage[]>([]);
const [failuresDays, setFailuresDays] = useState<number>(7);
```

- [ ] **Step 4: Remove unused imports**

Edit the import at line 8. The original reads:

```typescript
import { messageAnalyticsService, messageHistoryService, MessageAnalytics, FailedMessage } from '../../services/messageCenter.service';
```

Change to:

```typescript
import { messageAnalyticsService, MessageAnalytics } from '../../services/messageCenter.service';
```

Also remove `Link` from `react-router-dom` if it was only used by the panel's "view" links (check line 5). If other imports become unused (`AlertCircle` from `lucide-react` if only used in the panel), remove them too. Use the TypeScript check in Step 5 to catch any missed ones.

- [ ] **Step 5: TypeScript check**

Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/frontend && npx tsc --noEmit`
Expected: no errors for `MessageAnalyticsPage.tsx`. If errors appear, they'll point to remaining dangling references — remove each.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/message-center/MessageAnalyticsPage.tsx
git commit -m "refactor(analytics): remove flag-gated Failed Messages panel

Duplicative of Message History with Status=Failed filter. Keeps all
charts, stats cards, and tenant summaries on the Analytics page.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Drop `getFailures`, `FailedMessage` type, and dead env flag

**Files:**
- Modify: `frontend/src/services/messageCenter.service.ts`
- Modify: `frontend/.env` (remove one line — gitignored, local only)
- Delete: `frontend/.env.production`

- [ ] **Step 1: Remove `getFailures` and `FailedMessage` from the service**

Open `frontend/src/services/messageCenter.service.ts` and:
1. Delete the `FailedMessage` interface/type export (grep for `FailedMessage` to find it)
2. Delete the `getFailures` method from the `messageHistoryService` object

Run: `grep -n "FailedMessage\|getFailures" /Users/rova/Documents/AllAboard365/allaboard365/frontend/src/services/messageCenter.service.ts`

Expected after edits: no matches. If any remain, remove those references.

- [ ] **Step 2: Revert the flag line in `frontend/.env`**

Run: `sed -i '' '/^VITE_FEATURE_FAILED_MESSAGES=/d' /Users/rova/Documents/AllAboard365/allaboard365/frontend/.env`

Then verify:

Run: `cat /Users/rova/Documents/AllAboard365/allaboard365/frontend/.env`

Expected:
```
VITE_OAUTH_URL=http://localhost:3001
VITE_BRAND=open-enroll
```

- [ ] **Step 3: Delete `frontend/.env.production`**

Run: `rm /Users/rova/Documents/AllAboard365/allaboard365/frontend/.env.production`

- [ ] **Step 4: TypeScript check**

Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/frontend && npx tsc --noEmit 2>&1 | grep -i "FailedMessage\|getFailures" | head`
Expected: no output (no dangling references)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/messageCenter.service.ts frontend/.env.production
git commit -m "refactor(frontend): drop getFailures + FailedMessage + env flag

Panel is gone; endpoint is retired; flag is unused. frontend/.env is
gitignored so the local line removal is not committed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Add `Opened`/`Deferred` to MessageHistoryPage filter + helpers

**Files:**
- Modify: `frontend/src/pages/message-center/MessageHistoryPage.tsx`

- [ ] **Step 1: Extend the Status type**

Edit line 24 (inside `interface MessageHistoryItem`):

Before:
```typescript
status: 'Sent' | 'Sending' | 'Delivered' | 'Failed' | string;
```

After:
```typescript
status: 'Sent' | 'Sending' | 'Deferred' | 'Delivered' | 'Opened' | 'Failed' | string;
```

- [ ] **Step 2: Extend `isDeliveredOk` to count Delivered and Opened as success**

Edit line 96:

Before:
```typescript
const isDeliveredOk = (s: string) => s === 'Sent' || s === 'Delivered';
```

After:
```typescript
const isDeliveredOk = (s: string) => s === 'Sent' || s === 'Delivered' || s === 'Opened';
```

- [ ] **Step 3: Add `Deferred` and `Opened` to the filter dropdown**

Edit the dropdown at lines 469-473:

Before:
```jsx
<option value="All">All Status</option>
<option value="Sending">Sending</option>
<option value="Delivered">Delivered</option>
<option value="Sent">Sent</option>
<option value="Failed">Failed</option>
```

After:
```jsx
<option value="All">All Status</option>
<option value="Sending">Sending</option>
<option value="Sent">Sent</option>
<option value="Deferred">Deferred</option>
<option value="Delivered">Delivered</option>
<option value="Opened">Opened</option>
<option value="Failed">Failed</option>
```

- [ ] **Step 4: Extend `getStatusIcon` and `getStatusColor`**

Replace the entire `getStatusIcon` function (lines 303-315):

```typescript
const getStatusIcon = (status: string) => {
  switch (status) {
    case 'Sent':
      return <Mail className="h-4 w-4 text-gray-500" />;
    case 'Delivered':
      return <CheckCircle className="h-4 w-4 text-green-500" />;
    case 'Opened':
      return <Eye className="h-4 w-4 text-blue-500" />;
    case 'Deferred':
      return <Clock className="h-4 w-4 text-amber-500" />;
    case 'Sending':
      return <Clock className="h-4 w-4 text-amber-500" />;
    case 'Failed':
      return <XCircle className="h-4 w-4 text-red-500" />;
    default:
      return null;
  }
};
```

Replace the entire `getStatusColor` function (lines 317-329):

```typescript
const getStatusColor = (status: string) => {
  switch (status) {
    case 'Sent':
      return 'bg-gray-100 text-gray-800';
    case 'Delivered':
      return 'bg-green-100 text-green-800';
    case 'Opened':
      return 'bg-blue-100 text-blue-800';
    case 'Deferred':
      return 'bg-amber-100 text-amber-900';
    case 'Sending':
      return 'bg-amber-100 text-amber-900';
    case 'Failed':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
};
```

`Mail` and `Eye` are already imported at line 4; no import change needed.

- [ ] **Step 5: TypeScript check**

Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/message-center/MessageHistoryPage.tsx
git commit -m "feat(history): surface Deferred and Opened statuses in list + filter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Surface failure reason in the details modal

**Files:**
- Modify: `frontend/src/pages/message-center/MessageHistoryPage.tsx`

When a row has `status='Failed'`, show the bounce/dropped reason (from the latest `MessageEvent`) at the top of the details modal, above the timeline.

- [ ] **Step 1: Find the details modal JSX**

Run: `grep -n "isDetailsModalOpen\|deliveryEvents\.map\|selectedMessage" /Users/rova/Documents/AllAboard365/allaboard365/frontend/src/pages/message-center/MessageHistoryPage.tsx | head -20`

Note the line where the modal's content `<div>` begins (the one rendered when `isDetailsModalOpen && selectedMessage`).

- [ ] **Step 2: Add the failure-reason banner**

Immediately inside the modal content (before the delivery timeline — look for `{deliveryEvents.map(...)}`), insert this block:

```jsx
{selectedMessage.status === 'Failed' && (() => {
  const failureEvent = [...deliveryEvents]
    .reverse()
    .find(e => {
      const t = String(e.eventType || e.event || '').toLowerCase();
      return t === 'bounce' || t === 'dropped' || t === 'blocked' || t === 'failed';
    });
  const reason = failureEvent?.details || selectedMessage.errorMessage || 'No reason available from provider yet.';
  return (
    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4">
      <div className="flex items-start gap-2">
        <XCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-red-900">Delivery failed</p>
          <p className="text-sm text-red-800 mt-1 break-words">{reason}</p>
          {failureEvent?.eventType && failureEvent.eventType !== 'failed' && (
            <p className="text-xs text-red-600 mt-1">SendGrid event: {failureEvent.eventType}</p>
          )}
        </div>
      </div>
    </div>
  );
})()}
```

`XCircle` is already imported at line 4.

- [ ] **Step 3: TypeScript check**

Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/message-center/MessageHistoryPage.tsx
git commit -m "feat(history): show failure reason banner in details modal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Backfill MessageHistory insert in shareRequestESSService

**Files:**
- Modify: `backend/services/shareRequestESSService.js`

Before the `GraphEmailService.sendEmail(...)` call at line 273, insert a MessageHistory row so the ESS send becomes visible in Message History. Graph API gives no webhook, so Status stays `Sent`.

- [ ] **Step 1: Add required imports at the top of the file**

At the top of `backend/services/shareRequestESSService.js`, confirm `crypto` is imported (line 5 already has `const crypto = require('crypto');`) — no new imports needed.

- [ ] **Step 2: Insert the MessageHistory INSERT before the sendEmail call**

Locate the block starting at line 273 (`await GraphEmailService.sendEmail(...)`). Immediately BEFORE that `await`, insert this code (matching existing indentation — the code is inside an async class method, indented 20 spaces from the left margin of the file):

```javascript
                    // Log to MessageHistory so ESS emails appear in the Message Center.
                    // Graph API provides no webhook, so Status will remain 'Sent'.
                    try {
                        const historyId = crypto.randomUUID();
                        const historyMessageId = crypto.randomUUID();
                        const bodyText = `Your ESS document for Share Request ${shareRequest.RequestNumber} is ready. ESS Number: ${essNumber}. Download: ${authenticatedUrl}`;
                        await pool.request()
                            .input('HistoryId', sql.UniqueIdentifier, historyId)
                            .input('MessageId', sql.UniqueIdentifier, historyMessageId)
                            .input('TenantId', sql.UniqueIdentifier, shareRequest.TenantId)
                            .input('RecipientId', sql.UniqueIdentifier, shareRequest.MemberId || '00000000-0000-0000-0000-000000000000')
                            .input('RecipientAddress', sql.NVarChar(500), shareRequest.MemberEmail)
                            .input('Subject', sql.NVarChar(200), `Explanation of Sharing - ${essNumber}`)
                            .input('Status', sql.NVarChar(20), 'Sent')
                            .input('Body', sql.NVarChar(sql.MAX), bodyText)
                            .query(`
                                INSERT INTO oe.MessageHistory (
                                    HistoryId, MessageId, TenantId, RecipientId, MessageType,
                                    RecipientAddress, Subject, Status, ProviderMessageId, ErrorMessage,
                                    SentDate, BatchId, Body, FromAddress
                                ) VALUES (
                                    @HistoryId, @MessageId, @TenantId, @RecipientId, N'Email',
                                    @RecipientAddress, @Subject, @Status, NULL, NULL,
                                    GETUTCDATE(), NULL, @Body, NULL
                                )
                            `);
                    } catch (mhErr) {
                        // Non-fatal — don't block the send on logging failure.
                        console.error('[shareRequestESS] MessageHistory insert failed:', mhErr.message);
                    }

```

The blank line after the catch block separates from the existing `await GraphEmailService.sendEmail(...)` call.

- [ ] **Step 3: Syntax check**

Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/backend && node -c services/shareRequestESSService.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add backend/services/shareRequestESSService.js
git commit -m "feat(ess): log ESS emails to MessageHistory for Message Center visibility

Graph API provides no webhook, so Status stays 'Sent'. Acceptable for
audit-level visibility on low-volume ESS sends.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Localhost verification

**Files:** none (manual test)

- [ ] **Step 1: Ensure dev servers are running on main-worktree ports**

Run: `lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null | grep -E ':(3001|5173) '`

If backend (3001) is not listed, start it:
Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/backend && nohup node app.js > /tmp/aa-backend.log 2>&1 & disown`

If frontend (5173) is not listed, start it:
Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/frontend && nohup npm run dev > /tmp/aa-frontend.log 2>&1 & disown`

Wait 5 seconds for startup.

- [ ] **Step 2: Kill and restart backend to pick up service changes**

Run: `pkill -f "node app.js" && sleep 2 && cd /Users/rova/Documents/AllAboard365/allaboard365/backend && nohup node app.js > /tmp/aa-backend.log 2>&1 & disown`
Then: `sleep 5 && curl -sS http://localhost:3001/health`
Expected: `{"status":"healthy",...}` JSON

- [ ] **Step 3: Manual browser test**

Open http://localhost:5173/ in a browser. Log in (or rely on `BYPASS_AUTH=true` if set). Navigate to Message Center → Message History.

Verify in the browser:
- Status filter dropdown includes `All`, `Sending`, `Sent`, `Deferred`, `Delivered`, `Opened`, `Failed`
- Stats cards at the top render (no blank)
- Clicking a row with `Status='Failed'` opens the details modal and a red banner appears at the top with the failure reason

Navigate to Message Center → Analytics:
- Charts render (line chart, pie charts)
- Stats cards render (Total Sent, Delivery Rate, Failed, Email/SMS split)
- Tenant Summary table renders (if SysAdmin)
- Failed Messages panel is GONE

Report results back.

- [ ] **Step 4: Run full backend test suite targeted at touched areas**

Run: `cd /Users/rova/Documents/AllAboard365/allaboard365/backend && npx jest services/__tests__/sendGridEmailDeliveryTracking.test.js routes/webhooks/ routes/messageCenter 2>&1 | tail -20`
Expected: all pass

- [ ] **Step 5: No-op if all green; else iterate**

If any test failed or UI didn't render correctly, open the relevant task and iterate. Otherwise proceed.

---

## Task 11: Push branch and open PR

**Files:** none (git operations)

- [ ] **Step 1: Push the branch**

Run: `cd /Users/rova/Documents/AllAboard365/allaboard365 && git push -u origin feat/unified-message-history-status`

- [ ] **Step 2: Open the PR**

Run:
```bash
gh pr create --base master --head feat/unified-message-history-status \
  --title "feat(message-center): expand Status to Deferred/Opened, unify failure visibility" \
  --body "$(cat <<'EOF'
## Summary
- Extends SendGrid webhook delivery tracker to move MessageHistory.Status on `deferred` and `open` events (non-downgrade state machine)
- Retires the flag-gated Failed Messages panel on MessageAnalyticsPage (duplicative of Message History's built-in Status=Failed filter) along with the `/api/message-center/failures` endpoint, `getFailures` service method, `FailedMessage` type, and `VITE_FEATURE_FAILED_MESSAGES` flag
- Surfaces the failure reason as a banner at the top of the Message History details modal when Status='Failed'
- Backfills MessageHistory logging for `shareRequestESSService` ESS PDF emails (client-facing, previously only logged in vendor-specific table)
- No schema migrations; no DDL

## Test plan
- [x] `npx jest services/__tests__/sendGridEmailDeliveryTracking.test.js` (7/7)
- [x] `npx jest routes/webhooks/ routes/messageCenter` (all pass, `failures` test removed along with endpoint)
- [x] `npx tsc --noEmit` frontend (no errors)
- [x] Manual: Message History filter shows all 6 Status values; details modal shows failure banner on Failed rows
- [x] Manual: Analytics page renders unchanged minus the Failed Messages panel
- [ ] After deploy: send a bounce-guaranteed test email and confirm MessageHistory.Status transitions to `Failed` with reason in the modal
- [ ] After deploy: open a delivered email; confirm Status transitions to `Opened` within 60s of open event arriving

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Capture PR URL**

Run: `gh pr view --json url -q .url`
Expected: prints the PR URL. Report it back to the user so they can review before merge.

---

## Definition of done

- All 11 tasks checked
- Branch pushed, PR opened, URL reported
- User can see the PR diff, review, and merge when ready
- On merge, backend and frontend deploy scripts run and the new Status values start appearing on new webhook events in prod
