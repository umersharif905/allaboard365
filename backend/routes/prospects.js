// backend/routes/prospects.js
// Prospects CRM routes (Phase 1): list / detail / create / update + confirm member link.
// Visibility mirrors Members/Groups/Commissions: an Agent sees self + downline (or a
// specific downline agent); an AgencyOwner/Admin can scope to the whole agency; a
// TenantAdmin sees the whole tenant (optionally filtered by agency or agent); SysAdmin
// is unrestricted within the requested tenant. Mounted behind authenticate +
// requireTenantAccess in app.js, so every query is already tenant-scoped.

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, getUserRoles } = require('../middleware/auth');
const agentHierarchy = require('../utils/agentHierarchy');
const agencyAdmins = require('../utils/agencyAdmins');
const prospectService = require('../services/prospect.service');
const MessageQueueService = require('../services/messageQueue.service');
const { getAgentSenderContext } = require('../utils/agentSenderContext');
const { resolveAgentOutboundEmailEnvelope } = require('../utils/agentOutboundEmail');

const ROLES = ['Agent', 'AgencyOwner', 'TenantAdmin', 'SysAdmin'];

function getTenantId(req) {
  return req.tenantId || req.user.TenantId;
}

/**
 * Parse a `?tags=` query value (comma-separated GUIDs) into an array, or null.
 */
function parseTagIds(raw) {
  if (!raw) return null;
  const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : null;
}

/**
 * Look up the requesting user's own agent row (if any).
 */
async function getMyAgentContext(pool, userId) {
  const r = pool.request();
  r.input('userId', sql.UniqueIdentifier, userId);
  const result = await r.query(`
    SELECT a.AgentId, a.AgencyId
    FROM oe.Agents a
    WHERE a.UserId = @userId AND a.Status = 'Active'
  `);
  return result.recordset[0] || null;
}

/**
 * Resolve which owning-agent IDs the requester may see, honoring scope/agentId/agencyId.
 * Returns { agentIds } where agentIds === null means "no agent restriction" (whole
 * tenant, admins only). An empty array means "nothing visible". Returns { error } with
 * an HTTP status + message when the request is not permitted.
 */
async function resolveVisibility(pool, req) {
  const roles = getUserRoles(req.user) || [];
  const tenantId = getTenantId(req);
  const isSysAdmin = roles.includes('SysAdmin');
  const isTenantAdmin = roles.includes('TenantAdmin');
  const { agentId: specificAgentId, scope, agencyId } = req.query;

  // Admins: whole tenant, optionally narrowed by a specific agent or agency.
  if (isSysAdmin || isTenantAdmin) {
    if (specificAgentId) {
      const valid = await validateAgentInTenant(pool, specificAgentId, tenantId, isSysAdmin);
      if (!valid) return { error: { status: 403, message: 'Agent is not in this tenant.' } };
      return { agentIds: [specificAgentId] };
    }
    if (agencyId) {
      return { agentIds: await agentHierarchy.getAgentIdsForAgency(pool, agencyId) };
    }
    return { agentIds: null };
  }

  // Agent / AgencyOwner: bounded by their downline (or agency, if an agency admin).
  const me = await getMyAgentContext(pool, req.user.UserId);
  if (!me) return { error: { status: 403, message: 'Agent profile required.' } };

  const isAgencyOwner =
    roles.includes('AgencyOwner') ||
    (me.AgencyId ? await agencyAdmins.isAgencyAdmin(pool, me.AgencyId, me.AgentId) : false);

  // The full set this user is ever allowed to see.
  const downline = await agentHierarchy.getSelfAndDownlineAgentIds(pool, req.user.UserId);
  const agencyAll = isAgencyOwner && me.AgencyId
    ? await agentHierarchy.getAgentIdsForAgency(pool, me.AgencyId)
    : [];
  const allowedSet = new Set([...downline, ...agencyAll].map(String));

  // Specific agent: must be within the allowed set.
  if (specificAgentId) {
    if (!allowedSet.has(String(specificAgentId))) {
      return { error: { status: 403, message: 'You do not have access to that agent.' } };
    }
    return { agentIds: [specificAgentId] };
  }

  switch (scope) {
    case 'self':
      return { agentIds: [me.AgentId] };
    case 'agency':
      if (!isAgencyOwner) return { error: { status: 403, message: 'Agency-wide view not permitted.' } };
      return { agentIds: agencyAll };
    case 'direct': {
      const direct = await agentHierarchy.getDirectDownlineAgentIds(pool, me.AgentId);
      return { agentIds: [me.AgentId, ...direct] };
    }
    case 'downline':
    default:
      return { agentIds: downline };
  }
}

async function validateAgentInTenant(pool, agentId, tenantId, sysAdmin) {
  const r = pool.request();
  r.input('agentId', sql.UniqueIdentifier, agentId);
  if (sysAdmin) {
    const res = await r.query(`SELECT TOP 1 AgentId FROM oe.Agents WHERE AgentId = @agentId AND Status = 'Active'`);
    return res.recordset.length > 0;
  }
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  const res = await r.query(`SELECT TOP 1 AgentId FROM oe.Agents WHERE AgentId = @agentId AND TenantId = @tenantId AND Status = 'Active'`);
  return res.recordset.length > 0;
}

/**
 * GET /api/prospects
 * List prospects with visibility + status/search filters and pagination.
 */
router.get('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const { agentIds, error } = await resolveVisibility(pool, req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));

    const { prospects, total } = await prospectService.listProspects({
      tenantId: getTenantId(req),
      agentIds,
      status: req.query.status || null,
      source: req.query.source || null,
      sourceId: req.query.sourceId || null,
      search: req.query.search || null,
      tagIds: parseTagIds(req.query.tags),
      followUp: req.query.followUp || null,
      sortBy: req.query.sortBy || 'createdDate',
      sortDir: req.query.sortDir || 'desc',
      page,
      pageSize,
    });

    return res.json({ success: true, data: { prospects, total, page, pageSize } });
  } catch (err) {
    console.error('❌ [prospects] list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to list prospects' });
  }
});

/**
 * GET /api/prospects/stats
 * Aggregated insights (per-month-by-source, source breakdown, status funnel, totals)
 * honoring the SAME visibility scoping as the list. Optional from/to (ISO dates);
 * defaults to the trailing 12 months. Registered before /:id so "stats" isn't
 * treated as a prospect id.
 */
router.get('/stats', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const { agentIds, error } = await resolveVisibility(pool, req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const parseDate = (raw) => {
      if (!raw) return null;
      const d = new Date(raw);
      return isNaN(d.getTime()) ? null : d;
    };

    const data = await prospectService.getProspectStats({
      tenantId: getTenantId(req),
      agentIds,
      from: parseDate(req.query.from),
      to: parseDate(req.query.to),
      sourceId: req.query.sourceId || null,
      source: req.query.source || null,
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ [prospects] stats error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load prospect stats' });
  }
});

/**
 * GET /api/prospects/report
 * CSV export of prospects honoring the same visibility + filters. Columns are
 * toggleable via `?fields=` (comma-separated); default includes the common set.
 * Registered before /:id so "report" isn't treated as a prospect id.
 */
router.get('/report', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const { agentIds, error } = await resolveVisibility(pool, req);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const rows = await prospectService.getProspectsForReport({
      tenantId: getTenantId(req),
      agentIds,
      status: req.query.status || null,
      search: req.query.search || null,
      tagIds: parseTagIds(req.query.tags),
      followUp: req.query.followUp || null,
    });

    // Column registry: key -> { header, value(row) }
    const ALL_COLUMNS = {
      firstName: { header: 'First Name', value: (r) => r.FirstName },
      lastName: { header: 'Last Name', value: (r) => r.LastName },
      email: { header: 'Email', value: (r) => r.Email },
      phone: { header: 'Phone', value: (r) => r.Phone },
      status: { header: 'Status', value: (r) => r.Status },
      referralName: { header: 'Referral', value: (r) => r.ReferralName },
      premium: { header: 'Premium', value: (r) => (r.PremiumAmount != null ? r.PremiumAmount : '') },
      products: { header: 'Products', value: (r) => r.Products },
      agent: { header: 'Agent', value: (r) => [r.AgentFirstName, r.AgentLastName].filter(Boolean).join(' ').trim() },
      source: { header: 'Source', value: (r) => r.Source },
      tags: { header: 'Tags', value: (r) => r.Tags },
      isMember: { header: 'Enrolled Member', value: (r) => r.IsMember },
      nextFollowUp: { header: 'Next Follow-up', value: (r) => (r.NextFollowUpDate ? new Date(r.NextFollowUpDate).toISOString().slice(0, 10) : '') },
      lastContacted: { header: 'Last Contacted', value: (r) => (r.LastContactedDate ? new Date(r.LastContactedDate).toISOString().slice(0, 10) : '') },
      createdDate: { header: 'Created', value: (r) => (r.CreatedDate ? new Date(r.CreatedDate).toISOString().slice(0, 10) : '') },
      closedDate: { header: 'Closed', value: (r) => (r.ClosedDate ? new Date(r.ClosedDate).toISOString().slice(0, 10) : '') },
    };
    const DEFAULT_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'status', 'referralName', 'premium', 'products', 'tags', 'agent', 'source', 'isMember', 'nextFollowUp', 'lastContacted', 'createdDate'];

    const requested = (req.query.fields ? String(req.query.fields).split(',') : DEFAULT_FIELDS)
      .map((f) => f.trim())
      .filter((f) => ALL_COLUMNS[f]);
    const fields = requested.length ? requested : DEFAULT_FIELDS;

    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = fields.map((f) => esc(ALL_COLUMNS[f].header)).join(',');
    const lines = rows.map((row) => fields.map((f) => esc(ALL_COLUMNS[f].value(row))).join(','));
    const csv = [header, ...lines].join('\n');

    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="prospects-report-${today}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('❌ [prospects] report error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate report' });
  }
});

/**
 * GET /api/prospects/:id
 * Prospect detail (products + member summary for link/suggestion banner).
 */
router.get('/:id', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const detail = await prospectService.getProspect(pool, { prospectId: req.params.id, tenantId });
    if (!detail) return res.status(404).json({ success: false, message: 'Prospect not found' });

    const allowed = await canAccessProspect(pool, req, detail.prospect.AgentId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });

    return res.json({ success: true, data: detail });
  } catch (err) {
    console.error('❌ [prospects] detail error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load prospect' });
  }
});

/**
 * Whether the requester may act on a prospect owned by ownerAgentId.
 * Admins: yes (tenant already enforced). Agents: only within their allowed set;
 * unassigned (null owner) prospects are admin-only.
 */
async function canAccessProspect(pool, req, ownerAgentId) {
  const roles = getUserRoles(req.user) || [];
  if (roles.includes('SysAdmin') || roles.includes('TenantAdmin')) return true;
  if (!ownerAgentId) return false;

  const me = await getMyAgentContext(pool, req.user.UserId);
  if (!me) return false;
  const isAgencyOwner =
    roles.includes('AgencyOwner') ||
    (me.AgencyId ? await agencyAdmins.isAgencyAdmin(pool, me.AgencyId, me.AgentId) : false);
  const downline = await agentHierarchy.getSelfAndDownlineAgentIds(pool, req.user.UserId);
  const agencyAll = isAgencyOwner && me.AgencyId
    ? await agentHierarchy.getAgentIdsForAgency(pool, me.AgencyId)
    : [];
  return new Set([...downline, ...agencyAll].map(String)).has(String(ownerAgentId));
}

/**
 * POST /api/prospects
 * Manually create a prospect (find-or-create, email-primary/phone-fallback dedupe).
 */
router.post('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const roles = getUserRoles(req.user) || [];
    const tenantId = getTenantId(req);
    const { firstName, lastName, email, phone, referralName, premiumAmount, notes, products, agentId: bodyAgentId } = req.body;

    if (!firstName && !lastName && !email && !phone) {
      return res.status(400).json({ success: false, message: 'Provide at least a name, email, or phone.' });
    }

    // Determine owning agent.
    let agentId = null;
    if (roles.includes('TenantAdmin') || roles.includes('SysAdmin')) {
      if (bodyAgentId) {
        const valid = await validateAgentInTenant(pool, bodyAgentId, tenantId, roles.includes('SysAdmin'));
        if (!valid) return res.status(400).json({ success: false, message: 'Invalid agent for this tenant.' });
        agentId = bodyAgentId;
      }
    } else {
      const me = await getMyAgentContext(pool, req.user.UserId);
      if (!me) return res.status(403).json({ success: false, message: 'Agent profile required.' });
      agentId = me.AgentId;
    }

    const { prospect, created } = await prospectService.findOrCreateProspect({
      tenantId,
      agentId,
      firstName: firstName || null,
      lastName: lastName || null,
      email: email || null,
      phone: phone || null,
      referralName: referralName || null,
      premiumAmount: premiumAmount != null ? premiumAmount : null,
      notes: notes || null,
      products: products || [],
      source: 'Manual',
      createdBy: req.user.UserId,
    });

    return res.status(created ? 201 : 200).json({ success: true, data: { prospect, created } });
  } catch (err) {
    console.error('❌ [prospects] create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create prospect' });
  }
});

/**
 * PUT /api/prospects/:id
 * Update editable fields (status, contact info, referral, premium, notes).
 */
router.put('/:id', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);

    const existing = await prospectService.getProspectRow(pool, req.params.id);
    if (!existing || String(existing.TenantId) !== String(tenantId)) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const allowed = await canAccessProspect(pool, req, existing.AgentId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });

    const { firstName, lastName, email, phone, status, referralName, premiumAmount, notes, nextFollowUpDate } = req.body;
    if (status && !prospectService.PROSPECT_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Allowed: ${prospectService.PROSPECT_STATUSES.join(', ')}` });
    }

    // Parse an optional follow-up date (ISO string or null to clear).
    let followUpValue = existing.NextFollowUpDate;
    if (nextFollowUpDate !== undefined) {
      followUpValue = nextFollowUpDate ? new Date(nextFollowUpDate) : null;
      if (followUpValue && isNaN(followUpValue.getTime())) {
        return res.status(400).json({ success: false, message: 'Invalid nextFollowUpDate.' });
      }
    }

    const r = pool.request();
    r.input('prospectId', sql.UniqueIdentifier, req.params.id);
    r.input('firstName', sql.NVarChar, firstName !== undefined ? firstName : existing.FirstName);
    r.input('lastName', sql.NVarChar, lastName !== undefined ? lastName : existing.LastName);
    r.input('email', sql.NVarChar, email !== undefined ? email : existing.Email);
    r.input('emailNorm', sql.NVarChar, email !== undefined ? prospectService.normalizeEmail(email) : existing.EmailNormalized);
    r.input('phone', sql.NVarChar, phone !== undefined ? phone : existing.Phone);
    r.input('phoneNorm', sql.NVarChar, phone !== undefined ? prospectService.normalizePhone(phone) : existing.PhoneNormalized);
    r.input('status', sql.NVarChar, status || existing.Status);
    r.input('referralName', sql.NVarChar, referralName !== undefined ? referralName : existing.ReferralName);
    r.input('premium', sql.Decimal(18, 2), premiumAmount !== undefined ? premiumAmount : existing.PremiumAmount);
    r.input('notes', sql.NVarChar, notes !== undefined ? notes : existing.Notes);
    r.input('followUp', sql.DateTime2, followUpValue);
    await r.query(`
      UPDATE oe.Prospects SET
        FirstName = @firstName, LastName = @lastName,
        Email = @email, EmailNormalized = @emailNorm,
        Phone = @phone, PhoneNormalized = @phoneNorm,
        Status = @status, ReferralName = @referralName,
        PremiumAmount = @premium, Notes = @notes,
        NextFollowUpDate = @followUp,
        ModifiedDate = GETUTCDATE()
      WHERE ProspectId = @prospectId
    `);

    const detail = await prospectService.getProspect(pool, { prospectId: req.params.id, tenantId });
    return res.json({ success: true, data: detail });
  } catch (err) {
    console.error('❌ [prospects] update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update prospect' });
  }
});

/**
 * POST /api/prospects/:id/confirm-member-link
 * Agent confirms the suggested (or an explicit) member match → links + closes.
 * Body: { memberId } (defaults to the current SuggestedMemberId).
 */
router.post('/:id/confirm-member-link', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);

    const existing = await prospectService.getProspectRow(pool, req.params.id);
    if (!existing || String(existing.TenantId) !== String(tenantId)) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const allowed = await canAccessProspect(pool, req, existing.AgentId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });

    const memberId = req.body.memberId || existing.SuggestedMemberId;
    if (!memberId) return res.status(400).json({ success: false, message: 'No member to link.' });

    const linked = await prospectService.confirmMemberLink(pool, { prospectId: req.params.id, memberId, tenantId });
    if (!linked) return res.status(400).json({ success: false, message: 'Member not found in this tenant.' });

    const detail = await prospectService.getProspect(pool, { prospectId: req.params.id, tenantId });
    return res.json({ success: true, data: detail });
  } catch (err) {
    console.error('❌ [prospects] confirm-member-link error:', err);
    return res.status(500).json({ success: false, message: 'Failed to link member' });
  }
});

/**
 * GET /api/prospects/:id/communications
 * Past email + SMS with this prospect (by ProspectId or matching email/phone).
 */
router.get('/:id/communications', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);

    const existing = await prospectService.getProspectRow(pool, req.params.id);
    if (!existing || String(existing.TenantId) !== String(tenantId)) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const allowed = await canAccessProspect(pool, req, existing.AgentId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });

    const messages = await prospectService.getProspectCommunications(pool, { prospectId: req.params.id, tenantId });
    return res.json({ success: true, data: messages || [] });
  } catch (err) {
    console.error('❌ [prospects] communications list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load communications' });
  }
});

/**
 * GET /api/prospects/:id/proposals
 * Proposals + quotes associated with this prospect.
 */
router.get('/:id/proposals', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);

    const existing = await prospectService.getProspectRow(pool, req.params.id);
    if (!existing || String(existing.TenantId) !== String(tenantId)) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const allowed = await canAccessProspect(pool, req, existing.AgentId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });

    const data = await prospectService.getProspectProposals(pool, { prospectId: req.params.id, tenantId });
    return res.json({ success: true, data: data || { proposals: [], quotes: [] } });
  } catch (err) {
    console.error('❌ [prospects] proposals list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load proposals' });
  }
});

/**
 * POST /api/prospects/:id/communications
 * Send a new email or SMS to the prospect. Body: { channel: 'email'|'sms', subject?, body }.
 */
router.post('/:id/communications', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const { channel, subject, body } = req.body;

    const existing = await prospectService.getProspectRow(pool, req.params.id);
    if (!existing || String(existing.TenantId) !== String(tenantId)) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const allowed = await canAccessProspect(pool, req, existing.AgentId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });

    if (!body || !body.trim()) return res.status(400).json({ success: false, message: 'Message body is required.' });
    if (!['email', 'sms'].includes(channel)) return res.status(400).json({ success: false, message: 'channel must be "email" or "sms".' });

    let messageId;
    if (channel === 'email') {
      if (!existing.Email) return res.status(400).json({ success: false, message: 'Prospect has no email address.' });
      const sender = await getAgentSenderContext(req);
      const envelope = await resolveAgentOutboundEmailEnvelope(tenantId, sender);
      const html = String(body).replace(/\n/g, '<br>');
      messageId = await MessageQueueService.queueEmail({
        tenantId,
        toEmail: existing.Email,
        toName: [existing.FirstName, existing.LastName].filter(Boolean).join(' ').trim() || undefined,
        subject: subject || 'A message regarding your benefits',
        htmlContent: html,
        textContent: body,
        createdBy: req.user.UserId,
        recipientId: null,
        replyToEmail: envelope.replyToEmail || undefined,
        fromEmail: envelope.fromEmail,
        fromName: envelope.fromDisplayName,
      });
    } else {
      if (!existing.Phone) return res.status(400).json({ success: false, message: 'Prospect has no phone number.' });
      messageId = await MessageQueueService.queueMessage({
        tenantId,
        messageType: 'SMS',
        recipientAddress: existing.Phone,
        subject: null,
        messageBody: body,
        createdBy: req.user.UserId,
        recipientId: null,
      });
    }

    await prospectService.tagMessageWithProspect(pool, messageId, req.params.id);
    await prospectService.stampLastContacted(pool, req.params.id);
    return res.json({ success: true, data: { messageId } });
  } catch (err) {
    console.error('❌ [prospects] send communication error:', err);
    return res.status(500).json({ success: false, message: 'Failed to send message' });
  }
});

/**
 * Compute the set of owning-agent ids the requester may act on. Returns null for
 * admins (no restriction within tenant), otherwise a Set of stringified agent ids.
 */
async function allowedAgentSet(pool, req) {
  const roles = getUserRoles(req.user) || [];
  if (roles.includes('SysAdmin') || roles.includes('TenantAdmin')) return null;
  const me = await getMyAgentContext(pool, req.user.UserId);
  if (!me) return new Set();
  const isAgencyOwner =
    roles.includes('AgencyOwner') ||
    (me.AgencyId ? await agencyAdmins.isAgencyAdmin(pool, me.AgencyId, me.AgentId) : false);
  const downline = await agentHierarchy.getSelfAndDownlineAgentIds(pool, req.user.UserId);
  const agencyAll = isAgencyOwner && me.AgencyId
    ? await agentHierarchy.getAgentIdsForAgency(pool, me.AgencyId)
    : [];
  return new Set([...downline, ...agencyAll].map(String));
}

/**
 * POST /api/prospects/:id/reassign
 * Reassign a prospect to a different owning agent. Body: { agentId }.
 * The requester must be able to act on both the prospect and the target agent.
 */
router.post('/:id/reassign', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const roles = getUserRoles(req.user) || [];
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ success: false, message: 'agentId is required.' });

    const existing = await prospectService.getProspectRow(pool, req.params.id);
    if (!existing || String(existing.TenantId) !== String(tenantId)) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const allowed = await canAccessProspect(pool, req, existing.AgentId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });

    // Target agent must be in this tenant; for non-admins, within the allowed set.
    const isAdmin = roles.includes('SysAdmin') || roles.includes('TenantAdmin');
    const validTenant = await validateAgentInTenant(pool, agentId, tenantId, roles.includes('SysAdmin'));
    if (!validTenant) return res.status(400).json({ success: false, message: 'Invalid agent for this tenant.' });
    if (!isAdmin) {
      const set = await allowedAgentSet(pool, req);
      if (set && !set.has(String(agentId))) {
        return res.status(403).json({ success: false, message: 'You cannot assign to that agent.' });
      }
    }

    await prospectService.reassignAgent(pool, { prospectId: req.params.id, agentId, tenantId });
    const detail = await prospectService.getProspect(pool, { prospectId: req.params.id, tenantId });
    return res.json({ success: true, data: detail });
  } catch (err) {
    console.error('❌ [prospects] reassign error:', err);
    return res.status(500).json({ success: false, message: 'Failed to reassign prospect' });
  }
});

/**
 * POST /api/prospects/:id/tags
 * Assign a tag to a prospect. Body: { tagId }. The tag must belong to the tenant.
 */
router.post('/:id/tags', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const { tagId } = req.body;
    if (!tagId) return res.status(400).json({ success: false, message: 'tagId is required.' });

    const existing = await prospectService.getProspectRow(pool, req.params.id);
    if (!existing || String(existing.TenantId) !== String(tenantId)) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const allowed = await canAccessProspect(pool, req, existing.AgentId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });

    const tag = await prospectService.getTag(pool, { tagId, tenantId });
    if (!tag) return res.status(400).json({ success: false, message: 'Tag not found in this tenant.' });

    await prospectService.assignTag(pool, { prospectId: req.params.id, tagId, tenantId, createdBy: req.user.UserId });
    const detail = await prospectService.getProspect(pool, { prospectId: req.params.id, tenantId });
    return res.json({ success: true, data: detail });
  } catch (err) {
    console.error('❌ [prospects] assign tag error:', err);
    return res.status(500).json({ success: false, message: 'Failed to assign tag' });
  }
});

/**
 * DELETE /api/prospects/:id/tags/:tagId
 * Remove a tag from a prospect.
 */
router.delete('/:id/tags/:tagId', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);

    const existing = await prospectService.getProspectRow(pool, req.params.id);
    if (!existing || String(existing.TenantId) !== String(tenantId)) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const allowed = await canAccessProspect(pool, req, existing.AgentId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });

    await prospectService.unassignTag(pool, { prospectId: req.params.id, tagId: req.params.tagId });
    const detail = await prospectService.getProspect(pool, { prospectId: req.params.id, tenantId });
    return res.json({ success: true, data: detail });
  } catch (err) {
    console.error('❌ [prospects] remove tag error:', err);
    return res.status(500).json({ success: false, message: 'Failed to remove tag' });
  }
});

/**
 * DELETE /api/prospects/:id
 * Permanently remove a prospect (and its product links). Tenant- and visibility-scoped.
 */
router.delete('/:id', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);

    const existing = await prospectService.getProspectRow(pool, req.params.id);
    if (!existing || String(existing.TenantId) !== String(tenantId)) {
      return res.status(404).json({ success: false, message: 'Prospect not found' });
    }
    const allowed = await canAccessProspect(pool, req, existing.AgentId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });

    await prospectService.deleteProspect(pool, { prospectId: req.params.id, tenantId });
    return res.json({ success: true, message: 'Prospect deleted' });
  } catch (err) {
    console.error('❌ [prospects] delete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete prospect' });
  }
});

module.exports = router;
