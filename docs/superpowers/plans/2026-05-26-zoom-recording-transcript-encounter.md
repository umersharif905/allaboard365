# Zoom Recording / Transcript / AI Summary / Encounter Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task.

**Goal:** Unblock the recording, transcript, AI summary, and encounter-creation pipelines for Zoom Phone so that (a) every Zoom call/voicemail produces an Encounter row, (b) recordings + transcripts + AI summaries land on both the call log and the encounter, and (c) a vendor agent can attach an encounter to a Case or Share Request from a member-scoped picker.

**Architecture:** Surgical changes to `zoomPhoneService.js` (recording payload shape, race-fix upsert, new `ai_call_summary_changed` handler, encounter mirroring), a tiny `EncounterService.createFromCallLog` helper, a `getCallDetail` JOIN to surface the linked encounter, and a frontend picker on the call detail panel. No new tables — `oe.Encounters` was already designed for this integration.

**Tech Stack:** Node 22 / Express / `mssql` / Jest; React 18 / Vite / Vitest; Azure SQL.

**Branch:** `zoom-call-history-fixes` (continuing from prior work). All commits are additive on top of `ffa2be0b..f62b26ed`.

---

## ⚠ Required Zoom-admin actions (you do this — no code can substitute)

These toggles are off by default and Zoom never fires the relevant webhooks without them. Once flipped, all of the code below starts producing data immediately.

**1. Zoom Web Portal → Phone System Management → Call Queues → "Member Care Team" (ext 809) → Settings → Call Handling**
- Enable **Call Recording → Automatic recording**
- Enable **Allow Zoom to transcribe the call recording**

**2. Phone System Management → Auto Receptionists → "Main Auto Receptionist" → Settings → Call Handling**
- Same two toggles. This is what lets AI/AR-handled calls (74% of your volume) get transcribed even when no human is involved.

**3. Phone System Management → Users → (each user in `oe.VendorPhoneAgentMap`)** — for direct-dialed calls that bypass the queue. Same two toggles on each.

**4. App Marketplace → your S2S app ("AllAboard365 Call Center Production") → Scopes** — confirm or add these granular scopes:
- `phone:read:list_recordings:admin`
- `phone:read:recording:admin`
- `phone:read:recording_transcript:admin`
- `phone:read:list_voicemails:admin`
- `phone:read:voicemail:admin`
- `phone:read:ai_call_summary:admin` (new — required for Task Z3)

**5. Same S2S app → Features → Event Subscriptions → Phone events** — confirm or add:
- `phone.recording_completed`
- `phone.recording_transcript_completed`
- `phone.voicemail_received`
- `phone.ai_call_summary_changed` (new — required for Task Z3)

**6. After scope/event changes**: re-deploy / re-activate the S2S app so existing access tokens carry the new scopes.

---

## File Structure

**Modified files:**
- `backend/services/zoomPhoneService.js` — recording shape, race upsert, new AI summary handler, encounter mirroring
- `backend/services/encounterService.js` — new `createFromCallLog(vendorId, callLogId, ctx)` and `updateFromCallLog(vendorId, callLogId, patch)` helpers
- `backend/routes/webhooks/zoom-phone.js` — event dispatch table for new event
- `backend/services/aiCallSummaryService.js` — no changes (current behavior already writes Failed state)
- `frontend/src/pages/vendor/VendorCallCenter.tsx` — attach picker UI in detail panel
- `frontend/src/services/vendorCallCenter.service.ts` — type additions (`EncounterId`, etc.)

**Created files:**
- `backend/services/__tests__/zoomPhoneService.handleRecordingCompleted.test.js`
- `backend/services/__tests__/zoomPhoneService.handleAiCallSummary.test.js`
- `backend/services/__tests__/encounterService.createFromCallLog.test.js`
- `sql-changes/2026-05-26-vendor-call-logs-ai-summary-zoom.sql` (adds `ZoomAISummary NVARCHAR(MAX)` to keep Zoom's native AI summary separate from our OpenAI one)

**Not created:** No new tables. `oe.Encounters` already has Source, ExternalRef, RecordingUrl, TranscriptText, DurationSeconds, MemberId, CaseId, ShareRequestId.

---

## Task Z1: Fix recording handler — read `recordings[]` array

**Why first:** Zero recordings in prod is partly an admin-config issue, but `handleRecordingCompleted` also reads `payload.object.download_url` while Zoom actually delivers recordings under `payload.object.recordings[]` (or `payload.object.recording` for some events). This fix lets the data flow once the admin toggles are flipped.

**Files:**
- Modify: `backend/services/zoomPhoneService.js:753-783` (handleRecordingCompleted)
- Create: `backend/services/__tests__/zoomPhoneService.handleRecordingCompleted.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/services/__tests__/zoomPhoneService.handleRecordingCompleted.test.js`:

```js
/**
 * ZoomPhoneService.handleRecordingCompleted — recording webhook handler.
 *
 * Pins:
 *   - reads recordings[] array shape (current Zoom Phone payload)
 *   - falls back to flat download_url/recording_url for legacy/voicemail
 *   - updates VendorCallLogs by ExternalCallId
 *
 * Run: npx jest zoomPhoneService.handleRecordingCompleted
 */

jest.mock('../../config/database', () => ({
  sql: require('mssql'),
  getPool: jest.fn(),
}));

const ZoomPhoneService = require('../zoomPhoneService');
const { getPool } = require('../../config/database');

function makePool({ updateResult = { recordset: [{ CallLogId: 'cl-1' }] } } = {}) {
  const captured = {};
  const req = {
    input: jest.fn(function (k, _t, v) { captured[k] = v; return this; }),
    query: jest.fn(async () => updateResult),
  };
  getPool.mockResolvedValue({ request: () => req });
  return { captured };
}

describe('ZoomPhoneService.handleRecordingCompleted', () => {
  const vendorId = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

  test('current Zoom shape: recordings[] array → uses first recording', async () => {
    const { captured } = makePool();
    const payload = {
      object: {
        call_id: 'call-123',
        recordings: [
          { download_url: 'https://zoom.us/dl/abc', duration: 42, id: 'rec-1' },
        ],
      },
    };
    const r = await ZoomPhoneService.handleRecordingCompleted(vendorId, payload);
    expect(r.handled).toBe(true);
    expect(captured.recordingUrl).toBe('https://zoom.us/dl/abc');
    expect(captured.duration).toBe(42);
    expect(captured.externalCallId).toBe('call-123');
  });

  test('legacy flat shape: download_url at object level (voicemail-style)', async () => {
    const { captured } = makePool();
    const payload = {
      object: {
        call_id: 'call-legacy',
        download_url: 'https://zoom.us/dl/legacy',
        duration: 10,
      },
    };
    const r = await ZoomPhoneService.handleRecordingCompleted(vendorId, payload);
    expect(r.handled).toBe(true);
    expect(captured.recordingUrl).toBe('https://zoom.us/dl/legacy');
    expect(captured.duration).toBe(10);
  });

  test('recordings[] empty array → still updates HasRecording flag false, no URL', async () => {
    const { captured } = makePool();
    const payload = {
      object: { call_id: 'call-empty', recordings: [] },
    };
    const r = await ZoomPhoneService.handleRecordingCompleted(vendorId, payload);
    // We do update the row (so we don't lose the event), but URL stays null
    expect(r.handled).toBe(true);
    expect(captured.recordingUrl).toBeNull();
  });

  test('payload missing call_id but has call_log_id → uses fallback', async () => {
    const { captured } = makePool();
    const payload = {
      object: {
        call_log_id: 'cl-fallback',
        recordings: [{ download_url: 'https://zoom.us/dl/x', duration: 5 }],
      },
    };
    await ZoomPhoneService.handleRecordingCompleted(vendorId, payload);
    expect(captured.externalCallId).toBe('cl-fallback');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/backend && npx jest services/__tests__/zoomPhoneService.handleRecordingCompleted.test.js
```
Expected: FAIL — current handler reads flat `download_url` only.

- [ ] **Step 3: Replace `handleRecordingCompleted`**

In `backend/services/zoomPhoneService.js`, replace the function body (currently ~line 753-783):

```js
    /**
     * Handle phone.recording_completed webhook.
     * Zoom sends recordings under `payload.object.recordings[]` (array — Zoom
     * Phone supports multi-segment recordings). Older / voicemail shape has
     * a flat `download_url` at object level. Support both.
     */
    static async handleRecordingCompleted(vendorId, payload) {
        const obj = payload?.object || {};
        const first = Array.isArray(obj.recordings) && obj.recordings.length > 0 ? obj.recordings[0] : {};
        const callId = obj.call_id || obj.call_log_id || obj.id || first.call_id || first.call_log_id || null;
        const downloadUrl = first.download_url || obj.download_url || obj.recording_url || first.recording_url || null;
        const duration = first.duration ?? obj.duration ?? null;

        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, callId)
            .input('recordingUrl', sql.NVarChar, downloadUrl)
            .input('duration', sql.Int, duration)
            .query(`
                UPDATE oe.VendorCallLogs
                SET HasRecording = CASE WHEN @recordingUrl IS NOT NULL THEN 1 ELSE HasRecording END,
                    RecordingUrl = COALESCE(@recordingUrl, RecordingUrl),
                    RecordingDurationSeconds = COALESCE(@duration, RecordingDurationSeconds),
                    ModifiedDate = GETDATE()
                OUTPUT INSERTED.CallLogId
                WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId
            `);

        if (result.recordset.length > 0) {
            const callLogId = result.recordset[0].CallLogId;
            console.log(`📞 Recording added to call: ${callId}`);
            // Mirror into the linked encounter (best-effort, no throw)
            await this.mirrorCallLogToEncounter(callLogId, {
                recordingUrl: downloadUrl,
            }).catch(e => console.error('⚠ encounter mirror failed:', e.message));
            return { handled: true, callLogId };
        }
        console.log(`⚠️ Recording received for unknown call: ${callId} — will retry via deferred queue (TODO)`);
        return { handled: true, callLogId: null, deferred: true };
    }
```

(The `mirrorCallLogToEncounter` helper is added in Task Z5. Until then, the call will fail at runtime — Z5 must land before this code is exercised against a real webhook.)

- [ ] **Step 4: Run test → PASS**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/backend && npx jest services/__tests__/zoomPhoneService.handleRecordingCompleted.test.js
```

(NOTE: the test mocks `mirrorCallLogToEncounter` to a no-op or stubs it via `jest.spyOn`. Add `jest.spyOn(ZoomPhoneService, 'mirrorCallLogToEncounter').mockResolvedValue(undefined);` in a `beforeEach` if needed.)

- [ ] **Step 5: Commit**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2 && git add backend/services/zoomPhoneService.js backend/services/__tests__/zoomPhoneService.handleRecordingCompleted.test.js && git commit -m "fix(zoom): handleRecordingCompleted reads recordings[] array"
```

---

## Task Z2: Race fix — upsert by ExternalCallId in recording/transcript handlers

**Why:** Both `handleRecordingCompleted` and `handleTranscriptCompleted` rely on the call_log row already existing (matched by `ExternalCallId`). If the webhook arrives before `handleCallEnded` writes the row, the UPDATE matches 0 rows and the event is dropped silently. Zoom does NOT retry webhooks on this kind of soft fail.

**Approach:** When the UPDATE returns 0 rows, INSERT a minimal placeholder row keyed by ExternalCallId. Later `handleCallEnded` will see the placeholder via its dedup query and skip (already does — line 590-598 in current code). The placeholder gives us a stable CallLogId for the recording/transcript/AI summary to attach to.

**Files:**
- Modify: `backend/services/zoomPhoneService.js` — extract `upsertCallLogByExternalCallId(vendorId, externalCallId, fields)` helper; use it from recording + transcript handlers
- Modify: existing `handleCallEnded` dedup check (line ~580-600) to MERGE into the placeholder row's other fields rather than skip

- [ ] **Step 1: Add `upsertCallLogByExternalCallId` helper**

Insert after `recordCallLog` (~line 208) in `backend/services/zoomPhoneService.js`:

```js
    /**
     * Race-safe upsert keyed on (VendorId, ExternalCallId). Used by recording
     * and transcript handlers that may fire before call_ended writes the row.
     * Returns the CallLogId (existing or new).
     */
    static async upsertCallLogByExternalCallId(vendorId, externalCallId, fields = {}) {
        if (!externalCallId) return null;
        const pool = await getPool();
        const existing = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, externalCallId)
            .query(`SELECT CallLogId FROM oe.VendorCallLogs WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId`);
        if (existing.recordset.length > 0) return existing.recordset[0].CallLogId;

        const newId = crypto.randomUUID();
        await pool.request()
            .input('callLogId', sql.UniqueIdentifier, newId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('callType', sql.NVarChar, fields.callType || 'Unknown')
            .input('callStatus', sql.NVarChar, fields.callStatus || 'Pending')
            .input('externalCallId', sql.NVarChar, externalCallId)
            .input('source', sql.NVarChar, 'ZoomPhone')
            .input('callStartTime', sql.DateTime2, fields.callStartTime || new Date())
            .query(`
                INSERT INTO oe.VendorCallLogs (
                    CallLogId, VendorId, CallType, CallStatus,
                    ExternalCallId, Source, CallStartTime,
                    CreatedDate, IsActive
                ) VALUES (
                    @callLogId, @vendorId, @callType, @callStatus,
                    @externalCallId, @source, @callStartTime,
                    GETDATE(), 1
                )
            `);
        console.log(`📞 Created placeholder call log for early webhook: ${externalCallId} → ${newId}`);
        return newId;
    }
```

- [ ] **Step 2: Patch `handleRecordingCompleted`** (the function written in Z1)

Replace the "unknown call" branch (the final `if/else` block) with:

```js
        if (result.recordset.length > 0) {
            const callLogId = result.recordset[0].CallLogId;
            console.log(`📞 Recording added to call: ${callId}`);
            await this.mirrorCallLogToEncounter(callLogId, { recordingUrl: downloadUrl })
                .catch(e => console.error('⚠ encounter mirror failed:', e.message));
            return { handled: true, callLogId };
        }
        // Race: webhook arrived before call_ended. Upsert a placeholder so we don't lose the data.
        const placeholderId = await this.upsertCallLogByExternalCallId(vendorId, callId, { callType: 'Inbound', callStatus: 'Pending' });
        if (placeholderId) {
            await pool.request()
                .input('callLogId', sql.UniqueIdentifier, placeholderId)
                .input('recordingUrl', sql.NVarChar, downloadUrl)
                .input('duration', sql.Int, duration)
                .query(`UPDATE oe.VendorCallLogs SET HasRecording=1, RecordingUrl=@recordingUrl, RecordingDurationSeconds=@duration, ModifiedDate=GETDATE() WHERE CallLogId=@callLogId`);
            console.log(`📞 Recording attached to placeholder ${placeholderId} for early call ${callId}`);
            return { handled: true, callLogId: placeholderId, placeholder: true };
        }
        return { handled: false, callLogId: null };
```

- [ ] **Step 3: Patch `handleTranscriptCompleted` (line ~1622-1670)**

Find the `if (!callLogResult.recordset.length)` block (whatever returns `{handled: false, message: 'Call log not found'}`) and replace with the same upsert-placeholder pattern:

```js
        let callLogId = callLogResult.recordset[0]?.CallLogId;
        if (!callLogId) {
            // Race: transcript arrived before call_ended. Create placeholder.
            callLogId = await this.upsertCallLogByExternalCallId(vendorId, callId, { callType: 'Inbound', callStatus: 'Pending' });
            if (!callLogId) {
                return { handled: false, message: 'Call log not found and could not create placeholder' };
            }
        }
```

- [ ] **Step 4: Update `handleCallEnded` dedup branch** (`zoomPhoneService.js:590-598`)

When `existingLog.recordset.length > 0` (i.e., a placeholder or duplicate exists), the current code just deletes the active call row and returns. Change to: MERGE the call's real fields (CallerNumber, CalleeName, AgentUserId, CallDurationSeconds, etc.) onto the placeholder row before returning. Find the existing block:

```js
        if (existingLog.recordset.length > 0) {
            if (activeCall) { /* delete active call */ }
            return { handled: true, callLogId: existingLog.recordset[0].CallLogId, deduped: true };
        }
```

Replace with:

```js
        if (existingLog.recordset.length > 0) {
            const existingId = existingLog.recordset[0].CallLogId;
            // If this is a placeholder created by an earlier recording/transcript webhook,
            // backfill its fields now that we have full call details.
            const answeredBy = this.classifyAnsweredBy(payload.object, isInbound);
            const callStatus = c.handupResult === 'Voicemail'
                ? 'Voicemail'
                : (c.handupResult === 'Call Canceled' ? 'Missed' : 'Completed');
            const memberId = activeCall?.MemberId || null;
            const agentUserId = activeCall?.AgentUserId || await this.resolveAgentUserId(vendorId, c.agent);
            await pool.request()
                .input('callLogId', sql.UniqueIdentifier, existingId)
                .input('callType', sql.NVarChar, isInbound ? 'Inbound' : 'Outbound')
                .input('callStatus', sql.NVarChar, callStatus)
                .input('callerNumber', sql.NVarChar, c.callerNumber)
                .input('callerName', sql.NVarChar, c.callerName)
                .input('calleeNumber', sql.NVarChar, c.calleeNumber)
                .input('calleeName', sql.NVarChar, c.calleeName)
                .input('callDurationSeconds', sql.Int, c.durationSeconds || 0)
                .input('memberId', sql.UniqueIdentifier, memberId)
                .input('agentUserId', sql.UniqueIdentifier, agentUserId)
                .input('zoomUserId', sql.NVarChar, c.agent.userId)
                .input('agentEmail', sql.NVarChar, c.agent.email)
                .input('agentExtension', sql.NVarChar, c.agent.extension)
                .input('answeredBy', sql.NVarChar, answeredBy)
                .query(`
                    UPDATE oe.VendorCallLogs
                    SET CallType = COALESCE(NULLIF(@callType,''), CallType),
                        CallStatus = COALESCE(NULLIF(@callStatus,''), CallStatus),
                        CallerNumber = COALESCE(@callerNumber, CallerNumber),
                        CallerName = COALESCE(@callerName, CallerName),
                        CalleeNumber = COALESCE(@calleeNumber, CalleeNumber),
                        CalleeName = COALESCE(@calleeName, CalleeName),
                        CallDurationSeconds = COALESCE(NULLIF(@callDurationSeconds, 0), CallDurationSeconds),
                        MemberId = COALESCE(@memberId, MemberId),
                        AgentUserId = COALESCE(@agentUserId, AgentUserId),
                        ZoomUserId = COALESCE(@zoomUserId, ZoomUserId),
                        AgentEmail = COALESCE(@agentEmail, AgentEmail),
                        AgentExtension = COALESCE(@agentExtension, AgentExtension),
                        AnsweredBy = COALESCE(@answeredBy, AnsweredBy),
                        ModifiedDate = GETDATE()
                    WHERE CallLogId = @callLogId
                `);
            if (activeCall) {
                await pool.request()
                    .input('activeCallId', sql.UniqueIdentifier, activeCall.ActiveCallId)
                    .query('DELETE FROM oe.VendorActiveCalls WHERE ActiveCallId = @activeCallId');
            }
            // Now create the encounter if it doesn't exist
            await this.ensureEncounterForCallLog(vendorId, existingId).catch(e => console.error('⚠ encounter create failed:', e.message));
            return { handled: true, callLogId: existingId, mergedPlaceholder: true };
        }
```

(`ensureEncounterForCallLog` is added in Task Z4.)

- [ ] **Step 5: Re-run all zoom jest tests**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/backend && npx jest services/__tests__/zoomPhoneService
```
Expect: all existing 17 tests still pass + the 4 new recording tests pass. (Tests rely on `mirrorCallLogToEncounter` and `ensureEncounterForCallLog` existing — stub them with `jest.spyOn(...).mockResolvedValue()` in `beforeEach` if needed.)

- [ ] **Step 6: Commit**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2 && git add backend/services/zoomPhoneService.js && git commit -m "fix(zoom): race-safe upsert in recording + transcript handlers, merge placeholders on call_ended"
```

---

## Task Z3: Subscribe + handle `phone.ai_call_summary_changed`

**Why:** Zoom's April 2025 Phone changelog added native AI Call Summary delivered via webhook. This is a separate signal from our own OpenAI summary — Zoom's runs against their internal transcript model. Storing both gives the vendor two perspectives and a fallback when one fails.

**Files:**
- Modify: `backend/services/zoomPhoneService.js` — add event dispatch + handler
- Create: `sql-changes/2026-05-26-vendor-call-logs-ai-summary-zoom.sql` — adds `ZoomAISummary NVARCHAR(MAX) NULL` (DRY-RUN default)
- Create: `backend/services/__tests__/zoomPhoneService.handleAiCallSummary.test.js`

- [ ] **Step 1: Write the migration**

Create `sql-changes/2026-05-26-vendor-call-logs-ai-summary-zoom.sql`:

```sql
/*
 * Migration: 2026-05-26 — Add ZoomAISummary column to VendorCallLogs
 *
 * WHY: Zoom's native AI Call Summary (April 2025 webhook
 * `phone.ai_call_summary_changed`) is a separate signal from our own OpenAI
 * summary stored in AISummary. Keep both so vendors have two perspectives
 * and a fallback when one fails.
 *
 * Idempotent. DRY-RUN default. Set @DryRun = 0 to apply.
 */

SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID(N'oe.VendorCallLogs') AND name = N'ZoomAISummary'
    )
    BEGIN
        PRINT 'Adding oe.VendorCallLogs.ZoomAISummary NVARCHAR(MAX) NULL';
        ALTER TABLE oe.VendorCallLogs ADD ZoomAISummary NVARCHAR(MAX) NULL;
        PRINT 'Adding oe.VendorCallLogs.ZoomAISummaryReceivedAt DATETIME2 NULL';
        ALTER TABLE oe.VendorCallLogs ADD ZoomAISummaryReceivedAt DATETIME2 NULL;
    END
    ELSE
    BEGIN
        PRINT 'ZoomAISummary already exists — no change';
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

- [ ] **Step 2: Write the failing test**

Create `backend/services/__tests__/zoomPhoneService.handleAiCallSummary.test.js`:

```js
/**
 * ZoomPhoneService.handleAiCallSummaryChanged — Zoom's native AI summary
 * webhook (April 2025 changelog). Distinct from our OpenAI summary path.
 *
 * Run: npx jest zoomPhoneService.handleAiCallSummary
 */

jest.mock('../../config/database', () => ({
  sql: require('mssql'),
  getPool: jest.fn(),
}));

const ZoomPhoneService = require('../zoomPhoneService');
const { getPool } = require('../../config/database');

describe('ZoomPhoneService.handleAiCallSummaryChanged', () => {
  const vendorId = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

  beforeEach(() => {
    jest.spyOn(ZoomPhoneService, 'mirrorCallLogToEncounter').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test('persists summary to ZoomAISummary column and stamps ReceivedAt', async () => {
    const captured = {};
    const req = {
      input: jest.fn(function (k, _t, v) { captured[k] = v; return this; }),
      query: jest.fn(async (sqlText) => {
        if (/UPDATE oe\.VendorCallLogs/i.test(sqlText)) {
          return { recordset: [{ CallLogId: 'cl-1' }] };
        }
        return { recordset: [] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    const payload = {
      object: {
        call_id: 'call-123',
        ai_summary: {
          summary: 'Member called to ask about HSA eligibility for upcoming knee surgery.',
          next_steps: ['Send HSA enrollment form'],
        },
      },
    };
    const r = await ZoomPhoneService.handleAiCallSummaryChanged(vendorId, payload);
    expect(r.handled).toBe(true);
    expect(captured.zoomAISummary).toContain('HSA');
    expect(captured.externalCallId).toBe('call-123');
  });

  test('handles flat top-level summary string', async () => {
    const captured = {};
    const req = {
      input: jest.fn(function (k, _t, v) { captured[k] = v; return this; }),
      query: jest.fn(async () => ({ recordset: [{ CallLogId: 'cl-1' }] })),
    };
    getPool.mockResolvedValue({ request: () => req });

    const payload = { object: { call_id: 'call-flat', summary: 'Short summary text.' } };
    await ZoomPhoneService.handleAiCallSummaryChanged(vendorId, payload);
    expect(captured.zoomAISummary).toBe('Short summary text.');
  });
});
```

- [ ] **Step 3: Add the handler + dispatch case**

In `backend/services/zoomPhoneService.js` `processWebhookEvent` switch (~line 433-470), add:

```js
                case 'phone.ai_call_summary_changed':
                case 'phone.ai_call_summary_completed':
                    return await this.handleAiCallSummaryChanged(vendorId, payload);
```

Then add the handler near the other handlers (after `handleTranscriptCompleted`):

```js
    /**
     * Handle Zoom's native AI Call Summary webhook (April 2025 changelog).
     * Stored in ZoomAISummary — distinct from our OpenAI summary in AISummary.
     */
    static async handleAiCallSummaryChanged(vendorId, payload) {
        const obj = payload?.object || {};
        const callId = obj.call_id || obj.call_log_id || obj.id || null;
        // Zoom may deliver summary as object { summary, next_steps[] } or as flat string
        let summary = null;
        if (typeof obj.ai_summary === 'string') summary = obj.ai_summary;
        else if (obj.ai_summary && typeof obj.ai_summary === 'object') {
            const parts = [];
            if (obj.ai_summary.summary) parts.push(obj.ai_summary.summary);
            if (Array.isArray(obj.ai_summary.next_steps) && obj.ai_summary.next_steps.length > 0) {
                parts.push('Next steps:\n' + obj.ai_summary.next_steps.map(s => `- ${s}`).join('\n'));
            }
            summary = parts.join('\n\n') || null;
        } else if (typeof obj.summary === 'string') {
            summary = obj.summary;
        }

        if (!callId || !summary) {
            return { handled: false, reason: 'missing_call_id_or_summary' };
        }

        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('externalCallId', sql.NVarChar, callId)
            .input('zoomAISummary', sql.NVarChar(sql.MAX), summary)
            .query(`
                UPDATE oe.VendorCallLogs
                SET ZoomAISummary = @zoomAISummary,
                    ZoomAISummaryReceivedAt = GETDATE(),
                    ModifiedDate = GETDATE()
                OUTPUT INSERTED.CallLogId
                WHERE VendorId = @vendorId AND ExternalCallId = @externalCallId
            `);

        if (result.recordset.length > 0) {
            const callLogId = result.recordset[0].CallLogId;
            await this.mirrorCallLogToEncounter(callLogId, { zoomAISummary: summary })
                .catch(e => console.error('⚠ encounter mirror failed:', e.message));
            return { handled: true, callLogId };
        }
        // Race: AI summary arrived before call_ended
        const placeholderId = await this.upsertCallLogByExternalCallId(vendorId, callId, { callType: 'Inbound', callStatus: 'Pending' });
        if (placeholderId) {
            await pool.request()
                .input('callLogId', sql.UniqueIdentifier, placeholderId)
                .input('zoomAISummary', sql.NVarChar(sql.MAX), summary)
                .query(`UPDATE oe.VendorCallLogs SET ZoomAISummary=@zoomAISummary, ZoomAISummaryReceivedAt=GETDATE(), ModifiedDate=GETDATE() WHERE CallLogId=@callLogId`);
            return { handled: true, callLogId: placeholderId, placeholder: true };
        }
        return { handled: false };
    }
```

- [ ] **Step 4: Run tests → PASS**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/backend && npx jest services/__tests__/zoomPhoneService.handleAiCallSummary.test.js
```

- [ ] **Step 5: Commit**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2 && git add backend/services/zoomPhoneService.js backend/services/__tests__/zoomPhoneService.handleAiCallSummary.test.js sql-changes/2026-05-26-vendor-call-logs-ai-summary-zoom.sql && git commit -m "feat(zoom): handle phone.ai_call_summary_changed webhook"
```

---

## Task Z4: Auto-create encounter on every Zoom call

**Files:**
- Modify: `backend/services/encounterService.js` — add `createFromCallLog(vendorId, callLogId, ctx)`
- Modify: `backend/services/zoomPhoneService.js` — add `ensureEncounterForCallLog(vendorId, callLogId)` wrapper + invoke from `handleCallEnded`, `handleVoicemail`, `handleCallMissed`
- Create: `backend/services/__tests__/encounterService.createFromCallLog.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/services/__tests__/encounterService.createFromCallLog.test.js`:

```js
/**
 * EncounterService.createFromCallLog — auto-create an encounter from a
 * VendorCallLogs row. Triggered from Zoom webhook handlers.
 *
 * Run: npx jest encounterService.createFromCallLog
 */

jest.mock('../../config/database', () => ({
  sql: require('mssql'),
  getPool: jest.fn(),
}));

const EncounterService = require('../encounterService');
const { getPool } = require('../../config/database');

describe('EncounterService.createFromCallLog', () => {
  const vendorId = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
  const callLogId = 'CL-0001';

  test('creates encounter with Source=zoom_phone, ExternalRef=callLogId, Channel=phone', async () => {
    const captured = {};
    const queries = [];
    const req = {
      input: jest.fn(function (k, _t, v) { captured[k] = v; return this; }),
      query: jest.fn(async (sqlText) => {
        queries.push(sqlText);
        // First: dedup SELECT — no existing encounter
        if (/SELECT EncounterId FROM oe\.Encounters/i.test(sqlText)) return { recordset: [] };
        // Second: SELECT from VendorCallLogs (load source row)
        if (/FROM oe\.VendorCallLogs/i.test(sqlText)) {
          return { recordset: [{
            CallLogId: callLogId,
            VendorId: vendorId,
            CallType: 'Inbound',
            CallStatus: 'Completed',
            CallerName: 'Jane Member',
            CallerNumber: '+13105551212',
            CalleeName: 'Stephanie Hollis',
            CallStartTime: new Date('2026-05-26T16:00:00Z'),
            CallDurationSeconds: 184,
            MemberId: 'MEM-0001',
            AgentUserId: 'USR-0001',
            AnsweredBy: 'User',
            HasRecording: true,
            RecordingUrl: 'https://zoom.us/dl/x',
            TranscriptText: null,
            AISummary: null,
            ZoomAISummary: null,
          }]};
        }
        // Third: encounter number sequence
        if (/EncounterNumber/i.test(sqlText) && /SELECT/i.test(sqlText)) {
          return { recordset: [{ Next: 1 }] };
        }
        // Fourth: INSERT
        if (/INSERT INTO oe\.Encounters/i.test(sqlText)) {
          return { recordset: [{ EncounterId: 'ENC-0001' }] };
        }
        return { recordset: [] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    const result = await EncounterService.createFromCallLog(vendorId, callLogId);
    expect(result).toBeTruthy();
    expect(captured.source).toBe('zoom_phone');
    expect(captured.externalRef).toBe(callLogId);
    expect(captured.channel).toBe('phone');
    expect(captured.direction).toBe('inbound');
    expect(captured.memberId).toBe('MEM-0001');
    expect(captured.assignedToUserId).toBe('USR-0001');
    expect(captured.durationSeconds).toBe(184);
    expect(captured.summary).toMatch(/Inbound call/i);
  });

  test('idempotent: if encounter already exists for this CallLogId, returns existing', async () => {
    const req = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn(async (sqlText) => {
        if (/SELECT EncounterId FROM oe\.Encounters/i.test(sqlText)) {
          return { recordset: [{ EncounterId: 'ENC-EXISTING' }] };
        }
        return { recordset: [] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    const result = await EncounterService.createFromCallLog(vendorId, callLogId);
    expect(result.EncounterId).toBe('ENC-EXISTING');
  });

  test('missing call log returns null', async () => {
    const req = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn(async (sqlText) => {
        if (/SELECT EncounterId FROM oe\.Encounters/i.test(sqlText)) return { recordset: [] };
        if (/FROM oe\.VendorCallLogs/i.test(sqlText)) return { recordset: [] };
        return { recordset: [] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    const result = await EncounterService.createFromCallLog(vendorId, 'NONEXISTENT');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test → expect FAIL** (`createFromCallLog is not a function`)

- [ ] **Step 3: Add `createFromCallLog` to `EncounterService`**

In `backend/services/encounterService.js`, find the existing `createEncounter` function (~line 240) and add a new exported function nearby:

```js
/**
 * Create an Encounter row from a VendorCallLogs row. Idempotent on
 * (VendorId, ExternalRef). Used by Zoom Phone webhook handlers to ensure
 * every call produces an Encounter.
 */
async function createFromCallLog(vendorId, callLogId, ctx = {}) {
    const pool = await getPool();

    // Idempotency: skip if encounter already exists for this CallLogId
    const dup = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('externalRef', sql.NVarChar, callLogId)
        .query(`SELECT TOP 1 EncounterId, CaseId, ShareRequestId FROM oe.Encounters WHERE VendorId=@vendorId AND Source='zoom_phone' AND ExternalRef=@externalRef`);
    if (dup.recordset.length > 0) {
        return dup.recordset[0];
    }

    // Load the call log row
    const clRes = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('callLogId', sql.UniqueIdentifier, callLogId)
        .query(`SELECT CallLogId, CallType, CallStatus, CallerName, CallerNumber, CalleeName, CalleeNumber,
                       CallStartTime, CallDurationSeconds, MemberId, AgentUserId, AnsweredBy,
                       HasRecording, RecordingUrl, TranscriptText, AISummary, ZoomAISummary
                FROM oe.VendorCallLogs
                WHERE VendorId=@vendorId AND CallLogId=@callLogId`);
    if (clRes.recordset.length === 0) return null;
    const cl = clRes.recordset[0];

    // Map call type → encounter direction
    const direction =
        cl.CallType === 'Outbound' ? 'outbound' :
        (cl.CallType === 'Inbound' || cl.CallType === 'Missed' || cl.CallType === 'Voicemail') ? 'inbound' :
        null;

    // Build initial Summary text (required NOT NULL)
    const callerLabel = cl.CallerName || cl.CallerNumber || '(unknown caller)';
    const calleeLabel = cl.CalleeName || cl.CalleeNumber || '(unknown destination)';
    const answeredBy = cl.AnsweredBy === 'AutoReceptionist' ? ' (handled by Auto Receptionist)'
                    : cl.AnsweredBy === 'CallQueue' ? ' (call queue)'
                    : '';
    let summary;
    if (cl.CallType === 'Voicemail') {
        summary = `Voicemail from ${callerLabel} (${cl.CallDurationSeconds || 0}s).`;
    } else if (cl.CallType === 'Missed') {
        summary = `Missed call from ${callerLabel}${answeredBy}.`;
    } else if (cl.CallType === 'Outbound') {
        summary = `Outbound call to ${calleeLabel} (${cl.CallDurationSeconds || 0}s).`;
    } else {
        summary = `Inbound call from ${callerLabel} to ${calleeLabel}${answeredBy} (${cl.CallDurationSeconds || 0}s).`;
    }
    // If AI summary already on the call log, prefer it
    if (cl.AISummary) summary = cl.AISummary;
    else if (cl.ZoomAISummary) summary = cl.ZoomAISummary;

    return await createEncounter(vendorId, {
        memberId:         cl.MemberId,
        summary,
        channel:          'phone',
        direction,
        source:           'zoom_phone',
        externalRef:      cl.CallLogId,
        occurredAt:       cl.CallStartTime,
        durationSeconds:  cl.CallDurationSeconds,
        assignedToUserId: cl.AgentUserId,
    }, ctx);
}

module.exports = {
    // ... existing exports
    createFromCallLog,
};
```

(Make sure `createFromCallLog` is added to the `module.exports` block at the bottom of the file.)

- [ ] **Step 4: Add `ensureEncounterForCallLog` to `ZoomPhoneService`**

In `backend/services/zoomPhoneService.js`, add near the bottom of the class:

```js
    /**
     * Best-effort auto-create an Encounter row for a finished call.
     * Idempotent on (VendorId, ExternalRef=CallLogId). Logs and swallows errors.
     */
    static async ensureEncounterForCallLog(vendorId, callLogId) {
        if (!callLogId) return null;
        const EncounterService = require('./encounterService');
        try {
            return await EncounterService.createFromCallLog(vendorId, callLogId, {
                userId: null,
                userName: 'system:zoom_phone',
            });
        } catch (e) {
            console.error(`⚠ ensureEncounterForCallLog(${callLogId}) failed:`, e.message);
            return null;
        }
    }
```

- [ ] **Step 5: Hook into webhook handlers**

In `handleCallEnded`, after the `recordCallLog` return (line ~648), before the function ends, add:

```js
        await this.ensureEncounterForCallLog(vendorId, callLogId).catch(() => {});
        console.log(`📞 Call ended: ${c.callId} (Duration: ${durationSeconds}s)`);
        return { handled: true, callLogId, durationSeconds };
```

Same pattern after `recordCallLog` in `handleCallMissed` and `handleVoicemail`.

- [ ] **Step 6: Run tests → PASS**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/backend && npx jest services/__tests__/encounterService.createFromCallLog services/__tests__/zoomPhoneService
```

- [ ] **Step 7: Commit**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2 && git add backend/services/encounterService.js backend/services/zoomPhoneService.js backend/services/__tests__/encounterService.createFromCallLog.test.js && git commit -m "feat(zoom): auto-create encounter on call_ended/voicemail/missed"
```

---

## Task Z5: Mirror late-arriving data (recording / transcript / AI summary) into encounter

**Files:**
- Modify: `backend/services/zoomPhoneService.js` — add `mirrorCallLogToEncounter` helper

- [ ] **Step 1: Add the mirror helper**

In `backend/services/zoomPhoneService.js`, add as a static method (near `ensureEncounterForCallLog`):

```js
    /**
     * Patch the linked encounter (found by ExternalRef=CallLogId) with late-
     * arriving call data: RecordingUrl, TranscriptText, summary fields.
     *
     * AI summary updates *replace* the encounter's Summary field, but only
     * when no human has edited the encounter (ModifiedBy IS NULL). This
     * preserves agent notes while still showing the auto-generated summary
     * on untouched encounters.
     */
    static async mirrorCallLogToEncounter(callLogId, patch = {}) {
        if (!callLogId) return;
        const pool = await getPool();

        // Find the linked encounter
        const r = await pool.request()
            .input('externalRef', sql.NVarChar, callLogId)
            .query(`SELECT TOP 1 EncounterId, ModifiedBy FROM oe.Encounters WHERE Source='zoom_phone' AND ExternalRef=@externalRef`);
        if (r.recordset.length === 0) return;
        const enc = r.recordset[0];

        const sets = ['ModifiedDate = SYSUTCDATETIME()'];
        const req = pool.request().input('encounterId', sql.UniqueIdentifier, enc.EncounterId);

        if (patch.recordingUrl !== undefined) {
            sets.push('RecordingUrl = COALESCE(@recordingUrl, RecordingUrl)');
            req.input('recordingUrl', sql.NVarChar, patch.recordingUrl);
        }
        if (patch.transcriptText !== undefined) {
            sets.push('TranscriptText = COALESCE(@transcriptText, TranscriptText)');
            req.input('transcriptText', sql.NVarChar(sql.MAX), patch.transcriptText);
        }
        // Summary replacement: only if human hasn't touched the encounter
        const newSummary = patch.aiSummary || patch.zoomAISummary;
        if (newSummary && enc.ModifiedBy == null) {
            sets.push('Summary = @summary');
            req.input('summary', sql.NVarChar(sql.MAX), newSummary);
        }

        if (sets.length === 1) return; // nothing meaningful to update

        await req.query(`UPDATE oe.Encounters SET ${sets.join(', ')} WHERE EncounterId = @encounterId`);
    }
```

- [ ] **Step 2: Wire mirror calls into the existing handlers**

The Z1, Z2, Z3 code already calls `mirrorCallLogToEncounter(...)`. Also hook into the AI summary path:

Find `generateSummaryForCall` (~line 1604-1669) and after the successful UPDATE writes `AISummary=@summary`, add:

```js
            await this.mirrorCallLogToEncounter(callLogId, { aiSummary: result.summary })
                .catch(e => console.error('⚠ encounter mirror failed:', e.message));
            return { summarized: true, summary: result.summary, model: result.model };
```

(Place this just before the `return { summarized: true, ... }` statement.)

Also patch `handleTranscriptCompleted` after the transcript is persisted (where it writes `TranscriptText=@transcript`) to call `mirrorCallLogToEncounter(callLogId, { transcriptText: transcript })`.

- [ ] **Step 3: Smoke test**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/backend && npx jest services/__tests__/zoomPhoneService services/__tests__/encounterService
```

- [ ] **Step 4: Commit**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2 && git add backend/services/zoomPhoneService.js && git commit -m "feat(zoom): mirror recording/transcript/AI summary into linked encounter"
```

---

## Task Z6: Surface linked encounter on the call detail endpoint

**Files:**
- Modify: `backend/services/zoomPhoneService.js` — `getCallDetail` (~line 1921-1960) joins `oe.Encounters` on ExternalRef
- Modify: `frontend/src/services/vendorCallCenter.service.ts` — add encounter fields to `CallDetail` type

- [ ] **Step 1: Update `getCallDetail` SELECT**

In `getCallDetail` add the JOIN and select extra columns:

```sql
LEFT JOIN oe.Encounters enc
    ON enc.VendorId = cl.VendorId
   AND enc.Source = 'zoom_phone'
   AND enc.ExternalRef = CAST(cl.CallLogId AS NVARCHAR(200))
```

And include in the SELECT list:

```sql
enc.EncounterId AS EncounterId,
enc.EncounterNumber AS EncounterNumber,
enc.CaseId AS EncounterCaseId,
enc.ShareRequestId AS EncounterShareRequestId,
```

- [ ] **Step 2: Update frontend type**

In `frontend/src/services/vendorCallCenter.service.ts`, find the `CallDetail` interface and add:

```ts
  EncounterId: string | null;
  EncounterNumber: string | null;
  EncounterCaseId: string | null;
  EncounterShareRequestId: string | null;
```

- [ ] **Step 3: Commit**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2 && git add backend/services/zoomPhoneService.js frontend/src/services/vendorCallCenter.service.ts && git commit -m "feat(zoom): expose linked encounter in call detail response"
```

---

## Task Z7: Frontend "Attach to Case / Share Request" picker

**Files:**
- Modify: `frontend/src/pages/vendor/VendorCallCenter.tsx`
- Modify: `frontend/src/services/vendorCallCenter.service.ts` (helper methods)

- [ ] **Step 1: Add service methods for member-scoped attach picker**

In `frontend/src/services/vendorCallCenter.service.ts`, add (matching existing apiClient style):

```ts
export async function getMemberShareRequests(memberId: string) {
  const r = await apiClient.get(`/api/me/vendor/share-requests`, { params: { memberId, limit: 20 } });
  return (r.data?.data || r.data?.shareRequests || []) as Array<{ ShareRequestId: string; RequestNumber: string; Status: string }>;
}

export async function getMemberCases(memberId: string) {
  const r = await apiClient.get(`/api/me/vendor/cases`, { params: { memberId, limit: 20 } });
  return (r.data?.data || r.data?.cases || []) as Array<{ CaseId: string; CaseNumber: string; Status: string; Title: string }>;
}

export async function attachEncounterToCase(encounterId: string, caseId: string | null) {
  const r = await apiClient.put(`/api/me/vendor/encounters/${encounterId}`, { caseId });
  return r.data;
}

export async function attachEncounterToShareRequest(encounterId: string, shareRequestId: string | null) {
  const r = await apiClient.put(`/api/me/vendor/encounters/${encounterId}`, { shareRequestId });
  return r.data;
}
```

(Verify the response shapes against the actual list endpoints — adjust the unwrap if `r.data.data` isn't the right path.)

- [ ] **Step 2: Add the picker UI to the detail panel**

In `frontend/src/pages/vendor/VendorCallCenter.tsx`, in the detail panel render block (near where Linked request currently shows ~line 714), add a new section "Linked encounter":

```tsx
{detail?.EncounterId && (
  <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
    <div className="flex items-center justify-between mb-2">
      <span className="text-sm font-medium text-gray-700">Encounter</span>
      <a
        href={`/vendor/encounters/${detail.EncounterId}`}
        className="text-sm text-oe-primary hover:text-oe-dark"
      >
        Open ↗
      </a>
    </div>
    <div className="space-y-2">
      <AttachToCase
        encounterId={detail.EncounterId}
        memberId={detail.MemberId}
        currentCaseId={detail.EncounterCaseId}
        onAttached={() => refreshDetail()}
      />
      <AttachToShareRequest
        encounterId={detail.EncounterId}
        memberId={detail.MemberId}
        currentShareRequestId={detail.EncounterShareRequestId}
        onAttached={() => refreshDetail()}
      />
    </div>
  </div>
)}
```

Add the two small components at the top of the file (after `agentDisplay`):

```tsx
function AttachToCase({ encounterId, memberId, currentCaseId, onAttached }:
  { encounterId: string; memberId: string | null; currentCaseId: string | null; onAttached: () => void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Array<{ CaseId: string; CaseNumber: string; Title: string; Status: string }>>([]);

  useEffect(() => {
    if (open && memberId) {
      getMemberCases(memberId).then(setOptions).catch(() => setOptions([]));
    }
  }, [open, memberId]);

  if (currentCaseId) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-600">Case:</span>
        <span className="font-medium">{currentCaseId}</span>
        <button
          onClick={async () => { await attachEncounterToCase(encounterId, null); onAttached(); }}
          className="text-xs text-red-600 hover:bg-red-50 px-2 py-0.5 rounded"
        >
          Unlink
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="text-sm text-oe-primary hover:text-oe-dark"
      >
        + Attach to Case
      </button>
      {open && (
        <select
          className="border border-gray-300 rounded px-2 py-1 text-sm"
          onChange={async (e) => {
            if (e.target.value) {
              await attachEncounterToCase(encounterId, e.target.value);
              onAttached();
              setOpen(false);
            }
          }}
          defaultValue=""
        >
          <option value="">Choose a case…</option>
          {options.map(c => (
            <option key={c.CaseId} value={c.CaseId}>
              {c.CaseNumber} — {c.Title} ({c.Status})
            </option>
          ))}
          {!memberId && <option disabled>No member linked — manual case search not yet wired</option>}
        </select>
      )}
    </div>
  );
}

function AttachToShareRequest({ encounterId, memberId, currentShareRequestId, onAttached }:
  { encounterId: string; memberId: string | null; currentShareRequestId: string | null; onAttached: () => void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Array<{ ShareRequestId: string; RequestNumber: string; Status: string }>>([]);

  useEffect(() => {
    if (open && memberId) {
      getMemberShareRequests(memberId).then(setOptions).catch(() => setOptions([]));
    }
  }, [open, memberId]);

  if (currentShareRequestId) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-600">Share Request:</span>
        <span className="font-medium">{currentShareRequestId}</span>
        <button
          onClick={async () => { await attachEncounterToShareRequest(encounterId, null); onAttached(); }}
          className="text-xs text-red-600 hover:bg-red-50 px-2 py-0.5 rounded"
        >
          Unlink
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="text-sm text-oe-primary hover:text-oe-dark"
      >
        + Attach to Share Request
      </button>
      {open && (
        <select
          className="border border-gray-300 rounded px-2 py-1 text-sm"
          onChange={async (e) => {
            if (e.target.value) {
              await attachEncounterToShareRequest(encounterId, e.target.value);
              onAttached();
              setOpen(false);
            }
          }}
          defaultValue=""
        >
          <option value="">Choose a share request…</option>
          {options.map(sr => (
            <option key={sr.ShareRequestId} value={sr.ShareRequestId}>
              {sr.RequestNumber} ({sr.Status})
            </option>
          ))}
          {!memberId && <option disabled>No member linked — manual SR search not yet wired</option>}
        </select>
      )}
    </div>
  );
}
```

Add corresponding imports at top of file:
```ts
import { getMemberCases, getMemberShareRequests, attachEncounterToCase, attachEncounterToShareRequest } from '@/services/vendorCallCenter.service';
import { useEffect, useState } from 'react';  // if not already imported
```

(Inspect the file to verify import style — match what's there. Use the actual path used by other imports in this file.)

- [ ] **Step 3: Type check (focused)**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/frontend && npx tsc --noEmit 2>&1 | grep -E "VendorCallCenter|vendorCallCenter\.service" | head -10
```
Expect: no errors on touched files.

- [ ] **Step 4: Commit**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2 && git add frontend/src/services/vendorCallCenter.service.ts frontend/src/pages/vendor/VendorCallCenter.tsx && git commit -m "feat(zoom): attach-to-case/share-request picker on call detail"
```

---

## Task Z8: Smoke test + restart localhost

- [ ] **Step 1: Run the full zoom + encounter test suites**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/backend && npx jest services/__tests__/zoomPhoneService services/__tests__/encounterService
```
Expect all green. Note any pre-existing failures.

- [ ] **Step 2: Apply the new migration to allaboard-testing**

(User pre-authorized DB writes on testing in the prior session.)

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2 && sed 's/DECLARE @DryRun BIT = 1;/DECLARE @DryRun BIT = 0;/' sql-changes/2026-05-26-vendor-call-logs-ai-summary-zoom.sql > /tmp/apply-zoom-ai.sql && ./ai_scripts/db-execute.sh /tmp/apply-zoom-ai.sql --testing
```

Verify with:
```bash
./ai_scripts/db-query.sh "SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('oe.VendorCallLogs') AND name LIKE 'ZoomAI%'"
```

- [ ] **Step 3: Restart localhost**

Kill the running backend (port 3002) and frontend (port 5174). Restart both — backend will pick up the schema change automatically (mssql doesn't cache schema).

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/backend && node app.js &
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/frontend && npm run dev -- --port 5174 &
```

- [ ] **Step 4: Sanity check**

```bash
curl -s http://localhost:3002/health
curl -s -o /dev/null -w "frontend %{http_code}\n" http://localhost:5174/
```

Then open `http://localhost:5174/vendor/call-center` → History tab → click any row → verify the new "Encounter" section appears in the detail panel with "Attach to Case" / "Attach to Share Request" buttons. Existing rows won't have linked encounters yet because they weren't created through the new pipeline; new calls (or a manual backfill, future task) will.

- [ ] **Step 5: Final commit if anything trailing**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2 && git status
```
If clean, done.

---

## Out of scope (deliberate — flag, don't fix here)

- **Backfilling encounters for the existing 964 prod call logs** — separate one-time SQL script that calls `createFromCallLog` for each row. Can be done after deploy.
- **Applying the new migration to prod** — needs Jeremy.
- **Voicemail transcript event** — Zoom docs are unclear whether voicemail transcripts come via `phone.recording_transcript_completed` or via an updated `phone.voicemail_received`. Leave the current handlers untouched until we see a real voicemail transcript event arrive in prod logs.
- **Search UI for cases/share-requests when MemberId is NULL** — picker currently shows a disabled option; full search/typeahead is a follow-up.
- **Replacing the placeholder "Linked request" line in the detail panel** — keeping it for back-compat with the older link-by-CallLogId pattern.
- **PR creation** — per user feedback, no PR without explicit approval.

---

## Self-review checklist

- ✅ Z1 fixes recording payload shape (recordings[] array) with 4 unit tests
- ✅ Z2 adds race-safe upsert + placeholder-merge so no webhook data is lost
- ✅ Z3 subscribes to `phone.ai_call_summary_changed` + persists separately from OpenAI summary
- ✅ Z4 auto-creates encounter on call_ended / voicemail / missed, idempotent on (Vendor, CallLogId)
- ✅ Z5 mirrors late-arriving recording/transcript/AI into the encounter; preserves human edits to Summary
- ✅ Z6 exposes the linked encounter in call detail API
- ✅ Z7 frontend picker with member-scoped case + share-request options
- ✅ Z8 smoke test + restart
- ✅ Zoom-admin actions listed up front as a precondition for any of the data to actually flow
- ✅ No placeholders, every step has exact code or exact commands
- ✅ Type consistency: `EncounterId` / `EncounterCaseId` / `EncounterShareRequestId` used identically across backend SELECT, frontend type, and frontend rendering
