# Zoom Call History Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Zoom Phone Call Center "History" tab so the Member and Agent columns populate reliably, missed-call rows stop appearing as all-NULL phantom rows, and AI/Auto-Receptionist–handled calls are explicitly labeled instead of blank.

**Architecture:** Six surgical fixes to `backend/services/zoomPhoneService.js` plus one schema add, one SQL backfill script, and one frontend rendering change. No new abstractions — each fix lands at the precise code site identified during research. Order matters: classifier + schema first (T1), then handler fixes that depend on them (T2-T5), then frontend (T6), then backfill (T7).

**Tech Stack:** Node 22 / Express / `mssql` / Jest (backend); React 18 / TypeScript / Vite / Vitest (frontend); Azure SQL with `oe.` schema.

**Research basis:** See conversation transcript that produced this plan. Key prod data points:
- `oe.VendorCallLogs` has 903 rows for VendorId `D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6` (ShareWELL Health/Partners)
- 100% have `ZoomUserId` NULL, 99.7% have `AgentUserId` NULL
- 75 rows have CallStatus='Missed' with EVERY identifying field NULL — `handleCallMissed` is reading wrong field paths
- 733 rows (81%) came from legacy bulk-sync paths that don't write the agent columns at all
- AR/AI-answered calls are real and unattributable in webhook payloads — must be detected via `extension_type === 'autoReceptionist'` and labeled explicitly

---

## File Structure

**Files modified:**
- `backend/services/zoomPhoneService.js` — fix handlers, delete legacy sync loops, add `classifyAnsweredBy` helper
- `frontend/src/pages/vendor/VendorCallCenter.tsx` — render `AnsweredBy` in Agent column when AgentUserId is NULL
- `frontend/src/services/vendorCallCenter.service.ts` — add `AnsweredBy` to `CallListItem` type

**Files created:**
- `sql-changes/2026-05-26-vendor-call-logs-answered-by.sql` — adds `AnsweredBy NVARCHAR(40)` column (DRY-RUN default)
- `sql-changes/2026-05-26-vendor-call-logs-answered-by-backfill.sql` — one-time backfill from `RawEventData` (DRY-RUN default)
- `backend/services/__tests__/zoomPhoneService.classifyAnsweredBy.test.js`
- `backend/services/__tests__/zoomPhoneService.handleCallMissed.test.js`
- `backend/services/__tests__/zoomPhoneService.storeSyncedCall.test.js`

**Files deleted** (replaced by `storeSyncedCall`): None — we keep the bulk-sync orchestration in place, but route its per-call write through `storeSyncedCall` instead of the inline INSERT.

---

## Task 1: Add `classifyAnsweredBy` helper + tests

**Why first:** Every other handler will call this; defining it up front makes downstream tasks tiny.

**Files:**
- Modify: `backend/services/zoomPhoneService.js` — add static helper near `extractWebhookCall` (~line 1448)
- Create: `backend/services/__tests__/zoomPhoneService.classifyAnsweredBy.test.js`

**Returns one of:** `'User'`, `'AutoReceptionist'`, `'CallQueue'`, `'CommonArea'`, `'SharedLineGroup'`, `null` (unknown).

- [ ] **Step 1: Write the failing test**

Create `backend/services/__tests__/zoomPhoneService.classifyAnsweredBy.test.js`:

```js
/**
 * ZoomPhoneService.classifyAnsweredBy — derives who/what answered (or was the
 * internal party on) a Zoom call from the raw webhook payload object.
 *
 * Run: npx jest zoomPhoneService.classifyAnsweredBy
 */

jest.mock('../../config/database', () => ({
  sql: require('mssql'),
  getPool: jest.fn(),
}));

const ZoomPhoneService = require('../zoomPhoneService');

describe('ZoomPhoneService.classifyAnsweredBy', () => {
  test('nested inbound payload with user callee → "User"', () => {
    const obj = {
      caller: { phone_number: '+18005551212', extension_type: 'pstn' },
      callee: { user_id: 'zoomU1', extension_type: 'user', extension_number: '102' },
    };
    expect(ZoomPhoneService.classifyAnsweredBy(obj, true)).toBe('User');
  });

  test('nested inbound payload with autoReceptionist callee → "AutoReceptionist"', () => {
    const obj = {
      caller: { phone_number: '+18005551212', extension_type: 'pstn' },
      callee: { extension_type: 'autoReceptionist', phone_number: '+18002691451', name: 'Main Auto Receptionist' },
    };
    expect(ZoomPhoneService.classifyAnsweredBy(obj, true)).toBe('AutoReceptionist');
  });

  test('nested inbound payload with callQueue callee → "CallQueue"', () => {
    const obj = {
      caller: { phone_number: '+18005551212' },
      callee: { extension_type: 'callQueue', name: 'Member Care Team' },
    };
    expect(ZoomPhoneService.classifyAnsweredBy(obj, true)).toBe('CallQueue');
  });

  test('outbound (isInbound=false) reads from caller party', () => {
    const obj = {
      caller: { user_id: 'zoomU1', extension_type: 'user' },
      callee: { phone_number: '+18005551212', extension_type: 'pstn' },
    };
    expect(ZoomPhoneService.classifyAnsweredBy(obj, false)).toBe('User');
  });

  test('flat legacy voicemail payload with callee_user_id → "User"', () => {
    const obj = {
      caller_number: '+18005551212',
      callee_user_id: 'zoomU1',
      callee_extension_type: 'user',
      owner: { type: 'user', id: 'zoomU1' },
    };
    expect(ZoomPhoneService.classifyAnsweredBy(obj, true)).toBe('User');
  });

  test('empty object → null', () => {
    expect(ZoomPhoneService.classifyAnsweredBy({}, true)).toBeNull();
  });

  test('sync-API row with callee.extension_type "auto_receptionist" (snake_case) → "AutoReceptionist"', () => {
    // Zoom's call_logs REST API sometimes uses snake_case extension_type values
    const obj = {
      callee: { extension_type: 'auto_receptionist', name: 'Main AR' },
      callee_ext_type: 'auto_receptionist',
    };
    expect(ZoomPhoneService.classifyAnsweredBy(obj, true)).toBe('AutoReceptionist');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx jest services/__tests__/zoomPhoneService.classifyAnsweredBy.test.js
```
Expected: FAIL — `ZoomPhoneService.classifyAnsweredBy is not a function`.

- [ ] **Step 3: Add the helper to `zoomPhoneService.js`**

Insert directly after `extractWebhookCall` (currently ends ~line 1447). Add:

```js
    /**
     * Classify *who answered* (or *who is the internal party on*) a Zoom call.
     * Reads the same payload shape as extractWebhookCall — supports both nested
     * (webhook lifecycle) and flat (voicemail / older call_logs) layouts.
     * Returns one of: 'User', 'AutoReceptionist', 'CallQueue', 'CommonArea',
     * 'SharedLineGroup', or null when undetermined.
     *
     * NOTE: lifecycle webhooks use camelCase ('autoReceptionist'), the
     * call_logs REST API uses snake_case ('auto_receptionist'). Normalize both.
     */
    static classifyAnsweredBy(obj = {}, isInbound = true) {
        const party = isInbound ? (obj.callee || {}) : (obj.caller || {});
        const rawType =
            party.extension_type
            || (isInbound ? obj.callee_extension_type : obj.caller_extension_type)
            || (isInbound ? obj.callee_ext_type : obj.caller_ext_type)
            || obj.path
            || null;

        if (!rawType) {
            // Voicemail-style flat payload sometimes has callee_user_id without an explicit type
            if (isInbound && obj.callee_user_id) return 'User';
            return null;
        }

        const t = String(rawType).toLowerCase().replace(/_/g, '');
        if (t === 'user' || t === 'extension') return 'User';
        if (t === 'autoreceptionist') return 'AutoReceptionist';
        if (t === 'callqueue') return 'CallQueue';
        if (t === 'commonarea' || t === 'commonareaphone') return 'CommonArea';
        if (t === 'sharedlinegroup') return 'SharedLineGroup';
        return null;
    }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npx jest services/__tests__/zoomPhoneService.classifyAnsweredBy.test.js
```
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/zoomPhoneService.js backend/services/__tests__/zoomPhoneService.classifyAnsweredBy.test.js
git commit -m "feat(zoom): add classifyAnsweredBy helper for AR/queue/user routing"
```

---

## Task 2: Add `AnsweredBy` column to `oe.VendorCallLogs`

**Why before T3-T5:** Handlers need a column to write to.

**Files:**
- Create: `sql-changes/2026-05-26-vendor-call-logs-answered-by.sql`

- [ ] **Step 1: Write the migration script (DRY-RUN default)**

```sql
/*
 * Migration: 2026-05-26 — Add AnsweredBy classification column to VendorCallLogs
 *
 * WHY: Many Zoom Phone calls are handled entirely by an Auto Receptionist (AI)
 * or routed to a call queue without reaching a human. Today these show as a
 * blank "Agent" column, indistinguishable from "agent not mapped". This column
 * lets us label AR-handled calls explicitly and surface accurate stats.
 *
 * Values:
 *   'User'             — answered by a real Zoom user (has AgentUserId, hopefully)
 *   'AutoReceptionist' — answered by IVR / Zoom Virtual Agent / auto receptionist
 *   'CallQueue'        — landed in a queue (may also have downstream User row)
 *   'CommonArea'       — common-area phone
 *   'SharedLineGroup'  — shared line group
 *   NULL               — undetermined / legacy data
 *
 * Idempotent. Defaults to DRY-RUN: shows what would change without committing.
 * Set @DryRun = 0 to apply.
 */

SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID(N'oe.VendorCallLogs') AND name = N'AnsweredBy'
    )
    BEGIN
        PRINT 'Adding oe.VendorCallLogs.AnsweredBy NVARCHAR(40) NULL';
        ALTER TABLE oe.VendorCallLogs
            ADD AnsweredBy NVARCHAR(40) NULL;
    END
    ELSE
    BEGIN
        PRINT 'Column oe.VendorCallLogs.AnsweredBy already exists — no change';
    END

    IF @DryRun = 1
    BEGIN
        PRINT 'DRY RUN — rolling back. Set @DryRun = 0 to apply.';
        ROLLBACK TRANSACTION;
    END
    ELSE
    BEGIN
        PRINT 'APPLY — committing.';
        COMMIT TRANSACTION;
    END
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
```

- [ ] **Step 2: Verify the script syntactically by reading it back**

No execution against the DB. Per CLAUDE.md, DDL is not applied automatically.

- [ ] **Step 3: Commit**

```bash
git add sql-changes/2026-05-26-vendor-call-logs-answered-by.sql
git commit -m "feat(zoom): add migration for VendorCallLogs.AnsweredBy column"
```

---

## Task 3: Fix `handleCallMissed` to extract nested payload + resolve agent + classify AnsweredBy

**Files:**
- Modify: `backend/services/zoomPhoneService.js:665-696`
- Create: `backend/services/__tests__/zoomPhoneService.handleCallMissed.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/services/__tests__/zoomPhoneService.handleCallMissed.test.js`:

```js
/**
 * ZoomPhoneService.handleCallMissed — handles phone.callee_missed webhook.
 *
 * Pins:
 *   - reads nested caller{}/callee{} shape (real Zoom payload)
 *   - resolves AgentUserId via VendorPhoneAgentMap
 *   - classifies AnsweredBy = 'User' when callee.extension_type='user'
 *   - dedupes when same ExternalCallId is already logged
 *
 * Run: npx jest zoomPhoneService.handleCallMissed
 */

jest.mock('../../config/database', () => {
  const sql = require('mssql');
  return { sql, getPool: jest.fn() };
});

const ZoomPhoneService = require('../zoomPhoneService');
const { getPool } = require('../../config/database');

function makeRequestMock(responseMap) {
  // Each query() returns the next queued result in order it's called.
  const queries = [];
  const req = {
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockImplementation(async (sqlText) => {
      const matched = responseMap.find((r) => r.match.test(sqlText));
      queries.push({ sqlText, matched: !!matched });
      if (!matched) return { recordset: [], rowsAffected: [0] };
      const result = typeof matched.result === 'function' ? matched.result(sqlText) : matched.result;
      return result;
    }),
  };
  return { req, queries };
}

describe('ZoomPhoneService.handleCallMissed', () => {
  const vendorId = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

  beforeEach(() => {
    jest.spyOn(ZoomPhoneService, 'getVendorConfig').mockResolvedValue({ autoMatchEnabled: true });
    jest.spyOn(ZoomPhoneService, 'recordCallLog').mockResolvedValue('new-log-id');
    jest.spyOn(ZoomPhoneService, 'matchPhoneToMember').mockResolvedValue(null);
    jest.spyOn(ZoomPhoneService, 'resolveAgentUserId').mockResolvedValue('internal-user-id');
  });

  afterEach(() => jest.restoreAllMocks());

  test('nested payload: extracts caller/callee, resolves agent, classifies AnsweredBy=User', async () => {
    // Real prod payload shape from CallLogId 62D67D06
    const payload = {
      object: {
        call_id: '7644236094002219380',
        caller: {
          extension_type: 'autoReceptionist',
          phone_number: '+18282131111',
          extension_number: 18282131111,
        },
        callee: {
          extension_type: 'user',
          user_id: 'z4W4cRjDTyqkZb23rgytCg',
          extension_number: 813,
          phone_number: '813',
        },
        forwarded_by: { name: 'Member Care Team', extension_type: 'callQueue' },
        handup_result: 'No Answer',
      },
    };

    // Pool only consulted for dedup check
    const { req } = makeRequestMock([
      { match: /SELECT CallLogId FROM oe\.VendorCallLogs/i, result: { recordset: [] } },
    ]);
    getPool.mockResolvedValue({ request: () => req });

    await ZoomPhoneService.handleCallMissed(vendorId, payload);

    expect(ZoomPhoneService.resolveAgentUserId).toHaveBeenCalledWith(
      vendorId,
      expect.objectContaining({ userId: 'z4W4cRjDTyqkZb23rgytCg', extension: '813' }),
    );

    expect(ZoomPhoneService.recordCallLog).toHaveBeenCalledWith(
      vendorId,
      expect.objectContaining({
        callType: 'Missed',
        callStatus: 'Missed',
        callerNumber: '+18282131111',
        agentUserId: 'internal-user-id',
        zoomUserId: 'z4W4cRjDTyqkZb23rgytCg',
        answeredBy: 'User',
        externalCallId: '7644236094002219380',
      }),
    );
  });

  test('dedup: when ExternalCallId already logged, skips insert', async () => {
    const payload = {
      object: {
        call_id: 'already-logged',
        caller: { phone_number: '+15555550000' },
        callee: { user_id: 'zU', extension_type: 'user' },
      },
    };

    const { req } = makeRequestMock([
      {
        match: /SELECT CallLogId FROM oe\.VendorCallLogs/i,
        result: { recordset: [{ CallLogId: 'existing-id' }] },
      },
    ]);
    getPool.mockResolvedValue({ request: () => req });

    const result = await ZoomPhoneService.handleCallMissed(vendorId, payload);

    expect(ZoomPhoneService.recordCallLog).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: true, callLogId: 'existing-id', deduped: true });
  });

  test('AR-only missed (no human user_id on callee) → AnsweredBy=AutoReceptionist, agentUserId=null', async () => {
    ZoomPhoneService.resolveAgentUserId.mockResolvedValue(null);
    const payload = {
      object: {
        call_id: 'ar-only',
        caller: { phone_number: '+18002691451', extension_type: 'pstn' },
        callee: { extension_type: 'autoReceptionist', name: 'Main Auto Receptionist' },
        handup_result: 'No Answer',
      },
    };

    const { req } = makeRequestMock([
      { match: /SELECT CallLogId FROM oe\.VendorCallLogs/i, result: { recordset: [] } },
    ]);
    getPool.mockResolvedValue({ request: () => req });

    await ZoomPhoneService.handleCallMissed(vendorId, payload);

    expect(ZoomPhoneService.recordCallLog).toHaveBeenCalledWith(
      vendorId,
      expect.objectContaining({
        agentUserId: null,
        answeredBy: 'AutoReceptionist',
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx jest services/__tests__/zoomPhoneService.handleCallMissed.test.js
```
Expected: FAIL — current handler reads `callData.caller_number` (flat), tests assert nested extraction; `answeredBy` not present.

- [ ] **Step 3: Replace `handleCallMissed`**

In `backend/services/zoomPhoneService.js` replace lines 663-696 (the `handleCallMissed` function and its preceding comment) with:

```js
    /**
     * Handle missed call event (phone.callee_missed).
     * Reads the nested caller{}/callee{} shape (real Zoom payload), resolves
     * the internal agent, and de-duplicates against existing rows on
     * ExternalCallId so per-queue-member miss events don't produce N rows.
     */
    static async handleCallMissed(vendorId, payload) {
        const c = this.extractWebhookCall(payload.object, /* isInbound */ true);
        const answeredBy = this.classifyAnsweredBy(payload.object, true);

        // De-dupe: phone.callee_missed fires once per ringing queue member, so
        // a single call_id can produce multiple events. Keep the first row.
        const pool = await getPool();
        const existing = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, c.callId)
            .query(`SELECT CallLogId FROM oe.VendorCallLogs WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId`);
        if (existing.recordset.length > 0) {
            return { handled: true, callLogId: existing.recordset[0].CallLogId, deduped: true };
        }

        const config = await this.getVendorConfig(vendorId);

        let memberId = null;
        let matchedBy = null;
        if (config.autoMatchEnabled && c.callerNumber) {
            const matchedMember = await this.matchPhoneToMember(vendorId, c.callerNumber);
            if (matchedMember) {
                memberId = matchedMember.MemberId;
                matchedBy = 'Auto';
            }
        }

        const agentUserId = await this.resolveAgentUserId(vendorId, c.agent);

        const callLogId = await this.recordCallLog(vendorId, {
            callType: 'Missed',
            callStatus: 'Missed',
            callerNumber: c.callerNumber,
            callerName: c.callerName,
            calleeNumber: c.calleeNumber,
            calleeName: c.calleeName,
            callStartTime: new Date(),
            callDurationSeconds: 0,
            memberId,
            matchedBy,
            agentUserId,
            agentExtension: c.agent.extension,
            zoomUserId: c.agent.userId,
            agentEmail: c.agent.email,
            answeredBy,
            source: 'ZoomPhone',
            externalCallId: c.callId,
            rawEventData: payload,
        });

        console.log(`📞 Missed call from: ${c.callerNumber || '(unknown)'} → ${answeredBy || 'unknown'}`);
        return { handled: true, callLogId };
    }
```

- [ ] **Step 4: Add `answeredBy` to `recordCallLog`**

`recordCallLog` is at `backend/services/zoomPhoneService.js:~135-208`. Find the `.input('agentEmail', ...)` line (~line 171) and add directly after it:

```js
            .input('answeredBy', sql.NVarChar, callData.answeredBy || null)
```

Then update the INSERT column list (~line 188) from:
```
                    AgentUserId, AgentExtension, ZoomUserId, AgentEmail,
```
to:
```
                    AgentUserId, AgentExtension, ZoomUserId, AgentEmail, AnsweredBy,
```

And the VALUES clause (~line 198) from:
```
                    @agentUserId, @agentExtension, @zoomUserId, @agentEmail,
```
to:
```
                    @agentUserId, @agentExtension, @zoomUserId, @agentEmail, @answeredBy,
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd backend && npx jest services/__tests__/zoomPhoneService.handleCallMissed.test.js services/__tests__/zoomPhoneService.extract.test.js services/__tests__/zoomPhoneService.classifyAnsweredBy.test.js
```
Expected: PASS — all tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/services/zoomPhoneService.js backend/services/__tests__/zoomPhoneService.handleCallMissed.test.js
git commit -m "fix(zoom): handleCallMissed reads nested payload, resolves agent, dedupes"
```

---

## Task 4: Pass `answeredBy` through `handleCallEnded` and `handleCallStarted`

**Why:** Now that the column exists and `recordCallLog` accepts it, all live-call paths should populate it.

**Files:**
- Modify: `backend/services/zoomPhoneService.js` — `handleCallEnded` (line 571), `handleCallStarted` (line 481), `handleVoicemail` (line 701)

- [ ] **Step 1: Update `handleCallEnded` to pass answeredBy**

In `handleCallEnded`, after the line:
```js
        const c = this.extractWebhookCall(payload.object, isInbound);
```
add:
```js
        const answeredBy = this.classifyAnsweredBy(payload.object, isInbound);
```

In the same function, in the `recordCallLog` call (currently ~line 628-648), add `answeredBy` to the object passed in:
```js
            zoomUserId: c.agent.userId,
            agentEmail: c.agent.email,
            answeredBy,
            source: 'ZoomPhone',
```

- [ ] **Step 2: Update `handleVoicemail`**

In `handleVoicemail` (~line 701-748), after `const callData = payload.object;` add:
```js
        const answeredBy = this.classifyAnsweredBy(payload.object, true);
```

Then in the `recordCallLog` call (~line 725), add `answeredBy,` next to the `agentUserId,` field, and also pass `zoomUserId` + `agentEmail` (currently dropped):

Replace the existing `recordCallLog({...})` block with:

```js
        const callLogId = await this.recordCallLog(vendorId, {
            callType: 'Voicemail',
            callStatus: 'Voicemail',
            callerNumber: callData.caller_number,
            callerName: callData.caller_name,
            calleeNumber: callData.callee_number,
            calleeName: callData.callee_name,
            agentUserId,
            zoomUserId: callData.callee_user_id || null,
            agentExtension: callData.callee_number || null,
            answeredBy,
            callStartTime: new Date(),
            callDurationSeconds: callData.duration || 0,
            memberId: memberId,
            matchedBy: memberId ? 'Auto' : null,
            source: 'ZoomPhone',
            externalCallId: callData.id,
            hasRecording: !!voicemailUrl,
            recordingUrl: voicemailUrl,
            recordingDurationSeconds: callData.duration,
            rawEventData: payload
        });
```

- [ ] **Step 3: Verify no `recordCallLog` callers were missed**

```bash
cd backend && grep -n "recordCallLog(" services/zoomPhoneService.js
```
Confirm: each call site (handleCallEnded, handleVoicemail, handleCallMissed) passes `answeredBy`.

- [ ] **Step 4: Re-run the existing tests as a smoke check**

```bash
cd backend && npx jest services/__tests__/zoomPhoneService
```
Expected: PASS — extract/classify/handleCallMissed all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/zoomPhoneService.js
git commit -m "fix(zoom): propagate answeredBy through call_ended + voicemail handlers"
```

---

## Task 5: Replace legacy bulk-sync inline INSERTs with `storeSyncedCall`

**Why:** Lines 1140-1191 and 1268-1340 are two near-duplicate INSERT blocks that don't write the agent columns and lose caller info on most rows. `storeSyncedCall` (line 1506) already does this correctly. Route both paths through it.

**Files:**
- Modify: `backend/services/zoomPhoneService.js` — two call sites that should call `storeSyncedCall`
- Modify: `backend/services/zoomPhoneService.js` — `storeSyncedCall` needs to also populate `answeredBy`
- Create: `backend/services/__tests__/zoomPhoneService.storeSyncedCall.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/services/__tests__/zoomPhoneService.storeSyncedCall.test.js`:

```js
/**
 * ZoomPhoneService.storeSyncedCall — bulk-sync row write.
 *
 * Pins:
 *   - extracts caller/callee from nested OR flat sync-API shape
 *   - writes AgentUserId / ZoomUserId / AgentEmail / AnsweredBy
 *   - skips duplicates by ExternalCallId
 *
 * Run: npx jest zoomPhoneService.storeSyncedCall
 */

jest.mock('../../config/database', () => ({
  sql: require('mssql'),
  getPool: jest.fn(),
}));

const ZoomPhoneService = require('../zoomPhoneService');
const { getPool } = require('../../config/database');

describe('ZoomPhoneService.storeSyncedCall', () => {
  const vendorId = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
  const config = { autoMatchEnabled: true };

  beforeEach(() => {
    jest.spyOn(ZoomPhoneService, 'matchPhoneToMemberForSync').mockResolvedValue(null);
    jest.spyOn(ZoomPhoneService, 'resolveAgentUserId').mockResolvedValue('internal-uid');
  });

  afterEach(() => jest.restoreAllMocks());

  test('nested-shape inbound call: writes agent attribution + AnsweredBy', async () => {
    const captured = {};
    const req = {
      input: jest.fn(function (key, _type, value) { captured[key] = value; return this; }),
      query: jest.fn(async (sqlText) => {
        if (/SELECT CallLogId/i.test(sqlText)) return { recordset: [] }; // dedup miss
        return { recordset: [], rowsAffected: [1] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    await ZoomPhoneService.storeSyncedCall(vendorId, {
      id: 'sync-call-1',
      direction: 'inbound',
      caller: { phone_number: '+18005551212' },
      callee: { user_id: 'zoomU1', email: 'a@v.com', extension_number: '102', extension_type: 'user' },
      duration: 30,
      result: 'answered',
    }, config);

    expect(captured.agentUserId).toBe('internal-uid');
    expect(captured.zoomUserId).toBe('zoomU1');
    expect(captured.agentEmail).toBe('a@v.com');
    expect(captured.answeredBy).toBe('User');
    expect(captured.callerNumber).toBe('+18005551212');
  });

  test('flat-shape outbound call: extracts caller fields from flat keys', async () => {
    const captured = {};
    const req = {
      input: jest.fn(function (key, _type, value) { captured[key] = value; return this; }),
      query: jest.fn(async (sqlText) => {
        if (/SELECT CallLogId/i.test(sqlText)) return { recordset: [] };
        return { recordset: [], rowsAffected: [1] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    await ZoomPhoneService.storeSyncedCall(vendorId, {
      id: 'sync-call-2',
      direction: 'outbound',
      caller_number: '+13105550000',
      callee_number: '+14005550000',
      caller_name: 'Agent A',
      duration: 12,
      result: 'connected',
    }, config);

    expect(captured.callerNumber).toBe('+13105550000');
    expect(captured.calleeNumber).toBe('+14005550000');
  });

  test('skips duplicate (ExternalCallId already exists)', async () => {
    const req = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn(async (sqlText) => {
        if (/SELECT CallLogId/i.test(sqlText)) return { recordset: [{ CallLogId: 'x' }] };
        throw new Error('Should not have INSERTed');
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    const result = await ZoomPhoneService.storeSyncedCall(vendorId, {
      id: 'sync-call-3',
      direction: 'inbound',
    }, config);
    expect(result).toEqual({ skipped: true });
  });

  test('AR-handled inbound: extension_type=auto_receptionist → AnsweredBy=AutoReceptionist', async () => {
    ZoomPhoneService.resolveAgentUserId.mockResolvedValue(null);
    const captured = {};
    const req = {
      input: jest.fn(function (key, _type, value) { captured[key] = value; return this; }),
      query: jest.fn(async (sqlText) => {
        if (/SELECT CallLogId/i.test(sqlText)) return { recordset: [] };
        return { recordset: [], rowsAffected: [1] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    await ZoomPhoneService.storeSyncedCall(vendorId, {
      id: 'sync-call-4',
      direction: 'inbound',
      caller: { phone_number: '+18005551212' },
      callee: { extension_type: 'auto_receptionist', name: 'Main AR' },
      duration: 45,
      result: 'answered',
    }, config);

    expect(captured.agentUserId).toBeNull();
    expect(captured.answeredBy).toBe('AutoReceptionist');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx jest services/__tests__/zoomPhoneService.storeSyncedCall.test.js
```
Expected: FAIL — `storeSyncedCall` currently doesn't pass `answeredBy`.

- [ ] **Step 3: Update `storeSyncedCall` to include `answeredBy`**

In `backend/services/zoomPhoneService.js`, modify `storeSyncedCall` (currently lines 1506-1595).

After the `const agentExtension = ...` line (~1536), add:

```js
        const answeredBy = this.classifyAnsweredBy(call, callType === 'Inbound');
```

In the `.input('agentEmail', ...)` block (~line 1564), add directly after:
```js
            .input('answeredBy', sql.NVarChar, answeredBy)
```

In the INSERT column list (currently `AgentUserId, AgentExtension, ZoomUserId, AgentEmail,`) change to:
```
                    AgentUserId, AgentExtension, ZoomUserId, AgentEmail, AnsweredBy,
```

In the VALUES clause (currently `@agentUserId, @agentExtension, @zoomUserId, @agentEmail,`) change to:
```
                    @agentUserId, @agentExtension, @zoomUserId, @agentEmail, @answeredBy,
```

- [ ] **Step 4: Run storeSyncedCall test, expect PASS**

```bash
cd backend && npx jest services/__tests__/zoomPhoneService.storeSyncedCall.test.js
```
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Replace the inline INSERT in `syncCallHistory` (lines ~1140-1191)**

Locate the per-call loop body in `syncCallHistory` (within the for-each-user outer loop). Currently roughly lines 1100-1195 inside the inner `for (const call of callLogs)` block.

Replace the existing inline body (from `// Check if already exists` through the INSERT block) with a delegation:

```js
                    for (const call of callLogs) {
                        try {
                            const r = await this.storeSyncedCall(vendorId, call, config);
                            if (r.skipped) totalSkipped++;
                            if (r.imported) {
                                totalImported++;
                                if (r.matched) totalMatched++;
                            }
                        } catch (callError) {
                            console.error(`❌ Error importing call ${call.id}:`, callError.message);
                        }
                    }
```

Be precise: replace ONLY the `for (const call of callLogs) { ... }` block body. Keep the outer pagination / `nextPageToken` loop intact.

- [ ] **Step 6: Replace the inline INSERT in `syncCallHistoryForCurrentUser` (lines ~1268-1340)**

Same replacement strategy. Locate the `for (const call of callLogs)` block inside `syncCallHistoryForCurrentUser` and replace its body with the same delegation:

```js
                for (const call of callLogs) {
                    try {
                        const r = await this.storeSyncedCall(vendorId, call, config);
                        if (r.skipped) totalSkipped++;
                        if (r.imported) {
                            totalImported++;
                            if (r.matched) totalMatched++;
                        }
                    } catch (callError) {
                        console.error(`❌ Error importing call ${call.id}:`, callError.message);
                    }
                }
```

- [ ] **Step 7: Confirm there is no remaining inline INSERT into VendorCallLogs in the sync paths**

```bash
cd backend && grep -n "INSERT INTO oe.VendorCallLogs" services/zoomPhoneService.js
```
Expected: exactly 2 INSERT sites — `recordCallLog` (~line 183) and `storeSyncedCall` (~line 1571). The two legacy sync inserts at ~1174 and ~1326 should be gone.

- [ ] **Step 8: Re-run all zoom tests**

```bash
cd backend && npx jest services/__tests__/zoomPhoneService
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/services/zoomPhoneService.js backend/services/__tests__/zoomPhoneService.storeSyncedCall.test.js
git commit -m "refactor(zoom): route bulk-sync paths through storeSyncedCall + populate AnsweredBy"
```

---

## Task 6: Update history endpoint + frontend to render `AnsweredBy`

**Files:**
- Modify: `backend/services/zoomPhoneService.js:~1893-1916` — add `cl.AnsweredBy` to SELECT
- Modify: `frontend/src/services/vendorCallCenter.service.ts` — add `AnsweredBy` to `CallListItem`
- Modify: `frontend/src/pages/vendor/VendorCallCenter.tsx` — render in Agent column

- [ ] **Step 1: Add `AnsweredBy` to `getCallsList` SELECT**

In `backend/services/zoomPhoneService.js` find the SELECT in `getCallsList` (~line 1893). The line currently reads:

```sql
                cl.AgentUserId, cl.AgentExtension,
```

Change to:

```sql
                cl.AgentUserId, cl.AgentExtension, cl.AnsweredBy,
```

Also update the `getCallDetail` SELECT (which uses `cl.*` so it should pick up `AnsweredBy` automatically — verify by reading lines ~1921-1960). If `getCallDetail` uses explicit columns, add `cl.AnsweredBy` there too.

- [ ] **Step 2: Add `AnsweredBy` to the frontend type**

In `frontend/src/services/vendorCallCenter.service.ts` find the `CallListItem` interface. Add this field (alphabetize near `AgentExtension`):

```ts
  AgentExtension: string | null;
  AnsweredBy: 'User' | 'AutoReceptionist' | 'CallQueue' | 'CommonArea' | 'SharedLineGroup' | null;
```

- [ ] **Step 3: Render the Agent column with AnsweredBy fallback**

In `frontend/src/pages/vendor/VendorCallCenter.tsx` locate the Agent column cell (the line near `{memberName(c.AgentFirstName, c.AgentLastName) || <span ...>—</span>}` — roughly line 535 per earlier research).

Replace with:

```tsx
                  <td className="px-3 py-2">
                    {agentDisplay(c)}
                  </td>
```

And add a helper near the other helpers at the top of the file (after `memberName` ~line 74):

```ts
function agentDisplay(c: CallListItem) {
  const name = `${c.AgentFirstName || ''} ${c.AgentLastName || ''}`.trim();
  if (name) return <span>{name}</span>;
  if (c.AnsweredBy === 'AutoReceptionist') {
    return <span className="text-gray-600 italic">Auto Receptionist (AI)</span>;
  }
  if (c.AnsweredBy === 'CallQueue') {
    return <span className="text-gray-600 italic">Call Queue</span>;
  }
  if (c.AnsweredBy === 'CommonArea') {
    return <span className="text-gray-600 italic">Common Area Phone</span>;
  }
  if (c.AnsweredBy === 'SharedLineGroup') {
    return <span className="text-gray-600 italic">Shared Line</span>;
  }
  return <span className="text-gray-400">—</span>;
}
```

Import `CallListItem` at the top of the file if not already imported:
```ts
import type { CallListItem } from '@/services/vendorCallCenter.service';
```
(adjust path to match this file's existing import style — check how other types are imported in the same file).

- [ ] **Step 4: Type-check the frontend**

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "VendorCallCenter|vendorCallCenter\.service" | head -10
```
Expected: no errors in the modified files. (The project has ~597 pre-existing TS errors elsewhere — only verify the touched files are clean.)

- [ ] **Step 5: Commit**

```bash
git add backend/services/zoomPhoneService.js frontend/src/services/vendorCallCenter.service.ts frontend/src/pages/vendor/VendorCallCenter.tsx
git commit -m "feat(zoom): surface AnsweredBy in history tab Agent column"
```

---

## Task 7: One-time backfill SQL script for `AnsweredBy`

**Files:**
- Create: `sql-changes/2026-05-26-vendor-call-logs-answered-by-backfill.sql`

- [ ] **Step 1: Write the backfill script (DRY-RUN default)**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add sql-changes/2026-05-26-vendor-call-logs-answered-by-backfill.sql
git commit -m "feat(zoom): add backfill script for VendorCallLogs.AnsweredBy"
```

---

## Task 8: Final smoke check + localhost

- [ ] **Step 1: Run the full Zoom Jest suite once**

```bash
cd backend && npx jest services/__tests__/zoomPhoneService
```
Expected: all tests pass. If any pre-existing fail, note them but don't block.

- [ ] **Step 2: Verify no stray references to deleted code**

```bash
cd backend && grep -nE "matchPhoneToMemberForSync|recordCallLog|storeSyncedCall|classifyAnsweredBy" services/zoomPhoneService.js | head -30
```
Expected: only the intended call sites.

- [ ] **Step 3: Start backend on wt2 port (3002)**

```bash
cd backend && PORT=3002 node app.js &
```
Wait for "Server running" or equivalent log line.

- [ ] **Step 4: Start frontend on wt2 port (5174)**

```bash
cd frontend && npm run dev -- --port 5174 &
```
Wait for Vite "ready" line.

- [ ] **Step 5: Verify the History tab renders without errors**

Use Playwright MCP to navigate to `http://localhost:5174/vendor/call-center`, log in as a VendorAdmin, click History tab. Confirm:
- Member column either shows a name or "—"
- Agent column shows a name or "Auto Receptionist (AI)" / "Call Queue" or "—"

(Sample data may not exist on this DB; the test verifies the page loads + types are correct.)

---

## Out of scope (deliberate — flag, don't fix here)

- **Applying the migrations** — `sql-changes/` files are dry-run by default; applying requires explicit Jeremy approval per CLAUDE.md.
- **PR creation** — per user feedback, don't open PRs without explicit approval.
- **Refactoring or renaming unrelated code** in `zoomPhoneService.js`.
- **Removing the `Inbound/answered`/`Outbound/connected`/`hang_up`/`abandoned` lowercase statuses from existing rows** — could be done later in a separate normalization script. The new sync writes still pass `call.result` raw, which is consistent with prior behavior.

---

## Self-review checklist

- ✅ T1 covers classifyAnsweredBy with 7 unit tests covering nested, flat, AR, queue, outbound, snake_case, and empty payloads
- ✅ T2 adds the AnsweredBy column with idempotent dry-run migration
- ✅ T3 fixes handleCallMissed (root cause #1) with test coverage for nested extraction, dedup, AR-only path; also adds answeredBy to recordCallLog
- ✅ T4 wires answeredBy through call_ended + voicemail handlers; voicemail also preserves zoomUserId/agentEmail (minor data-quality fix #6)
- ✅ T5 replaces both legacy bulk-sync INSERTs (root cause #2) with storeSyncedCall, adds storeSyncedCall test coverage
- ✅ T6 surfaces AnsweredBy in API response + frontend Agent column with explicit labels (addresses user's "show AI when AI" ask)
- ✅ T7 backfills AnsweredBy on existing rows (dry-run default)
- ✅ T8 smoke test + localhost
- ✅ Missed-call dedup (recommendation #5) handled in T3 via the existing `SELECT CallLogId WHERE ExternalCallId = ...` check
- ✅ No placeholders; every step has exact code or exact commands
- ✅ Type consistency: `answeredBy` (camelCase JS) ↔ `AnsweredBy` (PascalCase SQL/API) used consistently throughout
