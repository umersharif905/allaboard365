// backend/routes/me/vendor/call-center.js
//
// Vendor Call Center API: live calls, call history with transcripts + AI
// summaries, per-agent stats, admin reports, and Zoom-user → agent mapping.
// All routes are vendor-scoped to the logged-in user's vendor.

const express = require('express');
const router = express.Router();
const { Readable } = require('stream');
const sql = require('mssql');
const { getPool } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const ZoomPhoneService = require('../../../services/zoomPhoneService');

// Every call-center route requires a vendor portal role.
router.use(authorize(['VendorAdmin', 'VendorAgent']));

const isVendorAdmin = (req) =>
    Array.isArray(req.user?.roles) && req.user.roles.includes('VendorAdmin');

const currentUserId = (req) => req.user?.UserId || req.user?.userId || null;

async function getVendorId(req) {
    const pool = await getPool();
    const userId = currentUserId(req);
    if (!userId) return null;
    const r = await pool.request()
        .input('userId', sql.UniqueIdentifier, userId)
        .query('SELECT VendorId FROM oe.Users WHERE UserId = @userId');
    const row = r.recordset[0];
    return row && row.VendorId ? String(row.VendorId) : null;
}

// Wrap a handler so vendorId resolution + error handling are uniform.
function vendorHandler(fn) {
    return async (req, res) => {
        try {
            const vendorId = await getVendorId(req);
            if (!vendorId) {
                return res.status(403).json({ success: false, message: 'User is not associated with a vendor' });
            }
            await fn(req, res, vendorId);
        } catch (err) {
            console.error(`❌ Call Center route error (${req.method} ${req.originalUrl}):`, err);
            res.status(500).json({ success: false, message: err.message || 'Call Center request failed' });
        }
    };
}

function adminOnly(req, res) {
    if (!isVendorAdmin(req)) {
        res.status(403).json({ success: false, message: 'VendorAdmin role required' });
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Config status (for the not-configured empty state)
// ---------------------------------------------------------------------------
router.get('/config', vendorHandler(async (req, res, vendorId) => {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT PhoneProvider, PhoneProviderEnabled,
                   CASE WHEN ZoomAccountId IS NOT NULL AND ZoomClientId IS NOT NULL
                             AND ZoomClientSecret IS NOT NULL THEN 1 ELSE 0 END AS HasCredentials,
                   PhoneAutoMatchEnabled, PhoneRecordingsEnabled, PhonePopupEnabled,
                   ZoomWebhookUrl
            FROM oe.Vendors WHERE VendorId = @vendorId
        `);
    const c = r.recordset[0] || {};
    res.json({
        success: true,
        data: {
            provider: c.PhoneProvider || null,
            enabled: !!c.PhoneProviderEnabled,
            configured: c.HasCredentials === 1,
            autoMatchEnabled: !!c.PhoneAutoMatchEnabled,
            recordingsEnabled: !!c.PhoneRecordingsEnabled,
            popupEnabled: !!c.PhonePopupEnabled,
            webhookUrl: c.ZoomWebhookUrl || null,
            isAdmin: isVendorAdmin(req),
        },
    });
}));

// ---------------------------------------------------------------------------
// Live calls ("who's on the line")
// ---------------------------------------------------------------------------
router.get('/live', vendorHandler(async (req, res, vendorId) => {
    const calls = await ZoomPhoneService.getActiveCallsDetailed(vendorId);
    res.json({ success: true, data: calls });
}));

// Full member context for the live pop-up (identity + open cases + share requests)
router.get('/members/:memberId/context', vendorHandler(async (req, res, vendorId) => {
    const ctx = await ZoomPhoneService.getMemberCallContext(vendorId, req.params.memberId);
    if (!ctx) return res.status(404).json({ success: false, message: 'Member not found for this vendor' });
    res.json({ success: true, data: ctx });
}));

// Member lookup by phone number
router.get('/lookup', vendorHandler(async (req, res, vendorId) => {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ success: false, message: 'phone query param required' });
    const members = await ZoomPhoneService.searchMembersByPhone(vendorId, phone);
    res.json({ success: true, data: members });
}));

// ---------------------------------------------------------------------------
// Call history list & detail
// ---------------------------------------------------------------------------
router.get('/calls', vendorHandler(async (req, res, vendorId) => {
    const q = req.query;
    const options = {
        direction: q.direction || undefined,
        search: q.search || undefined,
        hasRecording: q.hasRecording === 'true' ? true : undefined,
        hasTranscript: q.hasTranscript === 'true' ? true : undefined,
        fromDate: q.fromDate || undefined,
        toDate: q.toDate || undefined,
        limit: q.limit,
        offset: q.offset,
    };
    if (q.matched === 'true') options.matched = true;
    if (q.matched === 'false') options.matched = false;
    // scope=mine restricts to the calling agent's own calls.
    if (q.scope === 'mine') options.agentUserId = currentUserId(req);

    const result = await ZoomPhoneService.getCallsList(vendorId, options);
    res.json({ success: true, data: result });
}));

router.get('/calls/:callLogId', vendorHandler(async (req, res, vendorId) => {
    const call = await ZoomPhoneService.getCallDetail(vendorId, req.params.callLogId);
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });
    res.json({ success: true, data: call });
}));

// Update notes / link to share request / set member
router.put('/calls/:callLogId', vendorHandler(async (req, res, vendorId) => {
    const existing = await ZoomPhoneService.getCallDetail(vendorId, req.params.callLogId);
    if (!existing) return res.status(404).json({ success: false, message: 'Call not found' });

    const { callNotes, shareRequestId, memberId } = req.body || {};
    await ZoomPhoneService.updateCallLog(
        req.params.callLogId,
        { callNotes, shareRequestId, memberId },
        currentUserId(req)
    );
    const updated = await ZoomPhoneService.getCallDetail(vendorId, req.params.callLogId);
    res.json({ success: true, data: updated });
}));

// (Re)generate the AI summary for a call
router.post('/calls/:callLogId/summary', vendorHandler(async (req, res, vendorId) => {
    const existing = await ZoomPhoneService.getCallDetail(vendorId, req.params.callLogId);
    if (!existing) return res.status(404).json({ success: false, message: 'Call not found' });
    const force = req.body?.force === true || req.query.force === 'true';
    const result = await ZoomPhoneService.generateSummaryForCall(req.params.callLogId, { force });
    res.json({ success: true, data: result });
}));

// Stream a call recording (proxied with the vendor's Zoom token so the token
// is never exposed to the browser)
router.get('/calls/:callLogId/recording', vendorHandler(async (req, res, vendorId) => {
    const call = await ZoomPhoneService.getCallDetail(vendorId, req.params.callLogId);
    if (!call || !call.RecordingUrl) {
        return res.status(404).json({ success: false, message: 'Recording not available' });
    }
    const config = await ZoomPhoneService.getVendorConfig(vendorId);
    const token = await ZoomPhoneService.getAccessToken(config);

    const url = call.RecordingUrl;
    let upstream = await fetch(`${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`);
    if (!upstream.ok) {
        upstream = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (!upstream.ok || !upstream.body) {
        return res.status(502).json({ success: false, message: 'Failed to fetch recording from Zoom' });
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    Readable.fromWeb(upstream.body).pipe(res);
}));

// ---------------------------------------------------------------------------
// Stats & reports
// ---------------------------------------------------------------------------
router.get('/stats', vendorHandler(async (req, res, vendorId) => {
    const options = { fromDate: req.query.fromDate || undefined, toDate: req.query.toDate || undefined };
    // Default to the agent's own numbers unless they explicitly ask for vendor-wide.
    if (req.query.scope === 'mine' || (!isVendorAdmin(req) && req.query.scope !== 'all')) {
        options.agentUserId = currentUserId(req);
    }
    if (req.query.scope === 'all') delete options.agentUserId;
    const stats = await ZoomPhoneService.getStats(vendorId, options);
    res.json({ success: true, data: { ...stats, scope: options.agentUserId ? 'mine' : 'all' } });
}));

// Per-agent breakdown (admin only)
router.get('/reports/agents', vendorHandler(async (req, res, vendorId) => {
    if (!adminOnly(req, res)) return;
    const rows = await ZoomPhoneService.getAgentReport(vendorId, {
        fromDate: req.query.fromDate || undefined,
        toDate: req.query.toDate || undefined,
    });
    res.json({ success: true, data: rows });
}));

// ---------------------------------------------------------------------------
// Zoom-user ↔ internal-agent mapping (admin only)
// ---------------------------------------------------------------------------
router.get('/agent-map', vendorHandler(async (req, res, vendorId) => {
    if (!adminOnly(req, res)) return;
    // Pull live Zoom users when possible; fall back to just the stored map if
    // the Zoom API is unreachable so the screen still renders.
    let zoom = { zoomUsers: [], vendorUsers: [] };
    let zoomError = null;
    try {
        zoom = await ZoomPhoneService.listZoomUsersForMapping(vendorId);
    } catch (err) {
        zoomError = err.message;
        zoom.vendorUsers = await ZoomPhoneService.getVendorUsers(vendorId);
    }
    const currentMap = await ZoomPhoneService.getAgentMap(vendorId);
    res.json({ success: true, data: { ...zoom, currentMap, zoomError } });
}));

router.put('/agent-map', vendorHandler(async (req, res, vendorId) => {
    if (!adminOnly(req, res)) return;
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    for (const entry of entries) {
        if (!entry.zoomUserId) continue;
        await ZoomPhoneService.upsertAgentMap(vendorId, entry, currentUserId(req));
    }
    const currentMap = await ZoomPhoneService.getAgentMap(vendorId);
    res.json({ success: true, data: { currentMap } });
}));

// ---------------------------------------------------------------------------
// Sync (pull recent call history from Zoom)
// ---------------------------------------------------------------------------
router.post('/sync', vendorHandler(async (req, res, vendorId) => {
    const { fromDate, toDate } = req.body || {};
    // Kick off in the background; the UI polls /calls afterward.
    ZoomPhoneService.syncCallHistory(vendorId, { fromDate, toDate })
        .then(r => console.log('✅ Call Center sync finished', r))
        .catch(err => console.error('❌ Call Center sync failed:', err.message));
    res.json({ success: true, message: 'Sync started' });
}));

module.exports = router;
