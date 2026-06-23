// backend/services/prospect.service.js
// Prospects CRM business logic (Phase 1).
//
// Identity dedupe: email-primary, phone-fallback (normalized).
// Member matching is "suggest, agent confirms": we detect a likely member match
// and store it in SuggestedMemberId; we never auto-set MemberId/Status='Closed'.
// Status lifecycle: New -> Contacted -> Proposal Sent -> Closed -> Lost.

const crypto = require('crypto');
const { getPool, sql, rawSql } = require('../config/database');

const PROSPECT_STATUSES = ['New', 'Contacted', 'Proposal Sent', 'Closed', 'Lost'];
const PROSPECT_SOURCES = ['Manual', 'Proposal', 'Quote', 'ApiIngest', 'MightyWELL Website'];

// Inbound channels that should trigger the centralized "new prospect" agent email.
// Agent-self-created sources (Manual/Proposal/Quote) intentionally do NOT notify.
const NOTIFY_SOURCES = ['MightyWELL Website', 'ApiIngest'];

// Allowed tag color palette keys (mapped to Tailwind classes on the frontend).
const TAG_COLORS = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'];

// Whitelisted sort columns for the prospect list (key -> SQL ORDER BY expression).
const PROSPECT_SORTS = {
  createdDate: 'p.CreatedDate',
  name: 'p.LastName, p.FirstName',
  status: 'p.Status',
  premium: 'p.PremiumAmount',
  followUp: 'p.NextFollowUpDate',
  lastContacted: 'p.LastContactedDate',
  source: 'p.Source',
};

/**
 * Normalize an email for dedupe/matching: trim + lowercase. Returns null if empty.
 */
function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const cleaned = email.trim().toLowerCase();
  return cleaned.length ? cleaned : null;
}

/**
 * Normalize a phone for dedupe/matching: strip non-digits, drop a leading US
 * country code, and keep the last 10 digits. Returns null if fewer than 10 digits.
 */
function normalizePhone(raw) {
  if (!raw && raw !== 0) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 10) return null;
  // Drop leading '1' country code on 11-digit US numbers, then take last 10.
  return digits.slice(-10);
}

/**
 * SQL expression that reduces oe.Users.PhoneNumber to its last 10 digits so it can
 * be compared against a normalized prospect phone. T-SQL has no regex, so we strip
 * the common formatting characters then take RIGHT(...,10).
 */
const MEMBER_PHONE_LAST10 =
  "RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(u.PhoneNumber,''),'(',''),')',''),'-',''),' ',''),'+',''),'.',''), 10)";

/**
 * Find a member in the tenant whose email (primary) or phone (fallback) matches the
 * given normalized values. Returns the MemberId or null. Does NOT mutate anything.
 */
async function suggestMemberMatch(pool, { tenantId, emailNormalized, phoneNormalized }) {
  if (!tenantId || (!emailNormalized && !phoneNormalized)) return null;

  if (emailNormalized) {
    const r = pool.request();
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('emailNorm', sql.NVarChar, emailNormalized);
    const byEmail = await r.query(`
      SELECT TOP 1 m.MemberId
      FROM oe.Members m
      JOIN oe.Users u ON u.UserId = m.UserId
      WHERE m.TenantId = @tenantId
        AND LOWER(LTRIM(RTRIM(u.Email))) = @emailNorm
      ORDER BY m.CreatedDate DESC
    `);
    if (byEmail.recordset.length) return byEmail.recordset[0].MemberId;
  }

  if (phoneNormalized) {
    const r = pool.request();
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('phoneNorm', sql.NVarChar, phoneNormalized);
    const byPhone = await r.query(`
      SELECT TOP 1 m.MemberId
      FROM oe.Members m
      JOIN oe.Users u ON u.UserId = m.UserId
      WHERE m.TenantId = @tenantId
        AND ${MEMBER_PHONE_LAST10} = @phoneNorm
      ORDER BY m.CreatedDate DESC
    `);
    if (byPhone.recordset.length) return byPhone.recordset[0].MemberId;
  }

  return null;
}

/**
 * Look up an existing prospect in the tenant by normalized email (primary) then
 * normalized phone (fallback). Returns the prospect row or null.
 */
async function findProspectByIdentity(pool, { tenantId, emailNormalized, phoneNormalized }) {
  if (emailNormalized) {
    const r = pool.request();
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('emailNorm', sql.NVarChar, emailNormalized);
    const byEmail = await r.query(`
      SELECT TOP 1 * FROM oe.Prospects
      WHERE TenantId = @tenantId AND EmailNormalized = @emailNorm
      ORDER BY CreatedDate ASC
    `);
    if (byEmail.recordset.length) return byEmail.recordset[0];
  }

  if (phoneNormalized) {
    const r = pool.request();
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('phoneNorm', sql.NVarChar, phoneNormalized);
    const byPhone = await r.query(`
      SELECT TOP 1 * FROM oe.Prospects
      WHERE TenantId = @tenantId AND PhoneNormalized = @phoneNorm
      ORDER BY CreatedDate ASC
    `);
    if (byPhone.recordset.length) return byPhone.recordset[0];
  }

  return null;
}

/**
 * Attach products to a prospect (idempotent per ProductId via the unique constraint).
 */
async function upsertProspectProducts(pool, prospectId, products, source) {
  if (!Array.isArray(products) || products.length === 0) return;
  for (const p of products) {
    const productId = typeof p === 'string' ? p : p.productId;
    if (!productId) continue;
    const premium = typeof p === 'object' && p.premiumAmount != null ? p.premiumAmount : null;
    const r = pool.request();
    r.input('prospectId', sql.UniqueIdentifier, prospectId);
    r.input('productId', sql.UniqueIdentifier, productId);
    r.input('premium', sql.Decimal(18, 2), premium);
    r.input('source', sql.NVarChar, source || 'Manual');
    // Insert only if this product isn't already linked to the prospect.
    await r.query(`
      IF NOT EXISTS (SELECT 1 FROM oe.ProspectProducts WHERE ProspectId = @prospectId AND ProductId = @productId)
      INSERT INTO oe.ProspectProducts (ProspectProductId, ProspectId, ProductId, PremiumAmount, Source, CreatedDate)
      VALUES (NEWID(), @prospectId, @productId, @premium, @source, GETUTCDATE())
    `);
  }
}

/**
 * Find-or-create a prospect using email-primary / phone-fallback dedupe.
 * On match: fills in missing contact fields, appends products, refreshes the
 * suggested member match, and returns the existing prospect (created=false).
 * On no match: inserts a new prospect (created=true).
 *
 * @returns {Promise<{ prospect: object, created: boolean }>}
 */
async function findOrCreateProspect({
  tenantId,
  agentId = null,
  firstName = null,
  lastName = null,
  email = null,
  phone = null,
  premiumAmount = null,
  referralName = null,
  notes = null,
  products = [],
  source = 'Manual',
  sourceId = null,
  status = 'New',
  createdBy = null,
}) {
  if (!tenantId) throw new Error('tenantId is required to create a prospect');
  const pool = await getPool();

  const emailNormalized = normalizeEmail(email);
  const phoneNormalized = normalizePhone(phone);

  const existing = await findProspectByIdentity(pool, { tenantId, emailNormalized, phoneNormalized });

  if (existing) {
    // Fill gaps without clobbering existing data; refresh member suggestion.
    const suggested = existing.MemberId
      ? null
      : await suggestMemberMatch(pool, { tenantId, emailNormalized, phoneNormalized });

    const r = pool.request();
    r.input('prospectId', sql.UniqueIdentifier, existing.ProspectId);
    r.input('firstName', sql.NVarChar, firstName);
    r.input('lastName', sql.NVarChar, lastName);
    r.input('email', sql.NVarChar, email);
    r.input('emailNorm', sql.NVarChar, emailNormalized);
    r.input('phone', sql.NVarChar, phone);
    r.input('phoneNorm', sql.NVarChar, phoneNormalized);
    r.input('agentId', sql.UniqueIdentifier, agentId);
    r.input('referralName', sql.NVarChar, referralName);
    r.input('premium', sql.Decimal(18, 2), premiumAmount);
    r.input('suggested', sql.UniqueIdentifier, suggested);
    r.input('sourceId', sql.UniqueIdentifier, sourceId);
    await r.query(`
      UPDATE oe.Prospects SET
        FirstName       = COALESCE(FirstName, @firstName),
        LastName        = COALESCE(LastName, @lastName),
        Email           = COALESCE(Email, @email),
        EmailNormalized = COALESCE(EmailNormalized, @emailNorm),
        Phone           = COALESCE(Phone, @phone),
        PhoneNormalized = COALESCE(PhoneNormalized, @phoneNorm),
        AgentId         = COALESCE(AgentId, @agentId),
        ReferralName    = COALESCE(ReferralName, @referralName),
        PremiumAmount   = COALESCE(@premium, PremiumAmount),
        SourceId        = COALESCE(SourceId, @sourceId),
        SuggestedMemberId = CASE WHEN MemberId IS NULL THEN @suggested ELSE SuggestedMemberId END,
        ModifiedDate    = GETUTCDATE()
      WHERE ProspectId = @prospectId
    `);

    await upsertProspectProducts(pool, existing.ProspectId, products, source);
    const refreshed = await getProspectRow(pool, existing.ProspectId);
    return { prospect: refreshed, created: false };
  }

  // No match -> insert new prospect.
  const prospectId = crypto.randomUUID();
  const safeStatus = PROSPECT_STATUSES.includes(status) ? status : 'New';
  const safeSource = sourceId ? source : (PROSPECT_SOURCES.includes(source) ? source : 'Manual');
  const suggested = await suggestMemberMatch(pool, { tenantId, emailNormalized, phoneNormalized });

  const r = pool.request();
  r.input('prospectId', sql.UniqueIdentifier, prospectId);
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  r.input('agentId', sql.UniqueIdentifier, agentId);
  r.input('firstName', sql.NVarChar, firstName);
  r.input('lastName', sql.NVarChar, lastName);
  r.input('email', sql.NVarChar, email);
  r.input('emailNorm', sql.NVarChar, emailNormalized);
  r.input('phone', sql.NVarChar, phone);
  r.input('phoneNorm', sql.NVarChar, phoneNormalized);
  r.input('status', sql.NVarChar, safeStatus);
  r.input('referralName', sql.NVarChar, referralName);
  r.input('premium', sql.Decimal(18, 2), premiumAmount);
  r.input('notes', sql.NVarChar, notes);
  r.input('source', sql.NVarChar, safeSource);
  r.input('sourceId', sql.UniqueIdentifier, sourceId);
  r.input('suggested', sql.UniqueIdentifier, suggested);
  r.input('createdBy', sql.UniqueIdentifier, createdBy);
  await r.query(`
    INSERT INTO oe.Prospects
      (ProspectId, TenantId, AgentId, FirstName, LastName, Email, EmailNormalized,
       Phone, PhoneNormalized, Status, ReferralName, PremiumAmount, Notes, Source, SourceId,
       SuggestedMemberId, CreatedBy, CreatedDate, ModifiedDate)
    VALUES
      (@prospectId, @tenantId, @agentId, @firstName, @lastName, @email, @emailNorm,
       @phone, @phoneNorm, @status, @referralName, @premium, @notes, @source, @sourceId,
       @suggested, @createdBy, GETUTCDATE(), GETUTCDATE())
  `);

  await upsertProspectProducts(pool, prospectId, products, safeSource);
  const created = await getProspectRow(pool, prospectId);

  // Centralized agent notification for inbound channels only (website / API ingest).
  // Non-blocking: must never throw into the caller or delay the insert's return.
  if (agentId && (sourceId || NOTIFY_SOURCES.includes(safeSource))) {
    require('./prospectNotification.service')
      .notifyAgentOfNewProspect({ tenantId, agentId, prospect: created })
      .catch((err) => console.error('[prospect.service] notifyAgentOfNewProspect failed:', err && err.message));
  }

  return { prospect: created, created: true };
}

/**
 * Bump a prospect's status forward to a target only if it isn't already further
 * along (and isn't Closed/Lost). Used by the proposal/quote hooks ("Proposal Sent").
 */
async function advanceStatus(pool, prospectId, targetStatus) {
  if (!PROSPECT_STATUSES.includes(targetStatus)) return;
  const order = PROSPECT_STATUSES.indexOf(targetStatus);
  const r = pool.request();
  r.input('prospectId', sql.UniqueIdentifier, prospectId);
  r.input('target', sql.NVarChar, targetStatus);
  r.input('order', sql.Int, order);
  await r.query(`
    UPDATE oe.Prospects
    SET Status = @target, ModifiedDate = GETUTCDATE()
    WHERE ProspectId = @prospectId
      AND Status NOT IN ('Closed', 'Lost')
      AND (
        CASE Status
          WHEN 'New' THEN 0 WHEN 'Contacted' THEN 1 WHEN 'Proposal Sent' THEN 2
          WHEN 'Closed' THEN 3 WHEN 'Lost' THEN 4 ELSE 0 END
      ) < @order
  `);
}

/**
 * Confirm an agent-approved member link: sets MemberId, flips status to Closed,
 * stamps ClosedDate, clears the suggestion. Validates the member is in tenant.
 * @returns {Promise<boolean>} true if linked, false if member not found in tenant.
 */
async function confirmMemberLink(pool, { prospectId, memberId, tenantId }) {
  const check = pool.request();
  check.input('memberId', sql.UniqueIdentifier, memberId);
  check.input('tenantId', sql.UniqueIdentifier, tenantId);
  const member = await check.query(`
    SELECT TOP 1 MemberId FROM oe.Members WHERE MemberId = @memberId AND TenantId = @tenantId
  `);
  if (!member.recordset.length) return false;

  const r = pool.request();
  r.input('prospectId', sql.UniqueIdentifier, prospectId);
  r.input('memberId', sql.UniqueIdentifier, memberId);
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  await r.query(`
    UPDATE oe.Prospects
    SET MemberId = @memberId,
        SuggestedMemberId = NULL,
        Status = 'Closed',
        ClosedDate = GETUTCDATE(),
        ModifiedDate = GETUTCDATE()
    WHERE ProspectId = @prospectId AND TenantId = @tenantId
  `);
  return true;
}

/**
 * Candidate recipient addresses that identify a prospect in the message tables:
 * the lowercased email, plus the phone as E.164 (+1XXXXXXXXXX) and bare last-10.
 */
function prospectAddressCandidates(prospect) {
  const candidates = [];
  if (prospect.Email) candidates.push(prospect.Email.trim().toLowerCase());
  const last10 = prospect.PhoneNormalized || normalizePhone(prospect.Phone);
  if (last10) {
    candidates.push(`+1${last10}`);
    candidates.push(last10);
  }
  return candidates;
}

/**
 * Communications (email + SMS) for a prospect: any message threaded by ProspectId, or
 * sent to one of the prospect's addresses. Merges sent history (oe.MessageHistory) with
 * still-pending queue rows (oe.MessageQueue), newest first, in the message-center shape.
 */
async function getProspectCommunications(pool, { prospectId, tenantId }) {
  const prospect = await getProspectRow(pool, prospectId);
  if (!prospect || String(prospect.TenantId) !== String(tenantId)) return null;

  const candidates = prospectAddressCandidates(prospect);
  const request = pool.request();
  request.input('prospectId', sql.UniqueIdentifier, prospectId);
  request.input('tenantId', sql.UniqueIdentifier, tenantId);

  // Match by ProspectId OR lowercased recipient address.
  let addressClause = '';
  if (candidates.length) {
    const names = candidates.map((_, i) => `@addr${i}`);
    candidates.forEach((c, i) => request.input(`addr${i}`, sql.NVarChar, c));
    addressClause = ` OR LOWER(RecipientAddress) IN (${names.join(', ')})`;
  }

  const history = await request.query(`
    SELECT
      mh.HistoryId        AS historyId,
      mh.MessageId        AS messageId,
      mh.RecipientAddress AS recipientAddress,
      mh.MessageType      AS messageType,
      mh.Subject          AS subject,
      mh.Status           AS status,
      mh.SentDate         AS sentDate,
      'Sent'              AS source
    FROM oe.MessageHistory mh
    WHERE mh.TenantId = @tenantId AND (mh.ProspectId = @prospectId${addressClause})
    ORDER BY mh.SentDate DESC
  `);

  // Pending queue rows (not yet in history).
  const queueReq = pool.request();
  queueReq.input('prospectId', sql.UniqueIdentifier, prospectId);
  queueReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  let qAddressClause = '';
  if (candidates.length) {
    const names = candidates.map((_, i) => `@qaddr${i}`);
    candidates.forEach((c, i) => queueReq.input(`qaddr${i}`, sql.NVarChar, c));
    qAddressClause = ` OR LOWER(RecipientAddress) IN (${names.join(', ')})`;
  }
  const queue = await queueReq.query(`
    SELECT
      mq.MessageId        AS messageId,
      mq.RecipientAddress AS recipientAddress,
      mq.MessageType      AS messageType,
      mq.Subject          AS subject,
      mq.Status           AS status,
      mq.CreatedDate      AS sentDate,
      'Queued'            AS source
    FROM oe.MessageQueue mq
    WHERE mq.TenantId = @tenantId
      AND mq.Status IN ('Pending', 'Processing', 'Failed')
      AND (mq.ProspectId = @prospectId${qAddressClause})
    ORDER BY mq.CreatedDate DESC
  `);

  const sentIds = new Set((history.recordset || []).map((r) => String(r.messageId)));
  const pending = (queue.recordset || []).filter((r) => !sentIds.has(String(r.messageId)));
  return [...pending, ...(history.recordset || [])];
}

/**
 * After sending, thread the message back to the prospect by stamping ProspectId on the
 * queue row and/or history row (immediate sends land in history). Best-effort.
 */
async function tagMessageWithProspect(pool, messageId, prospectId) {
  if (!messageId || !prospectId) return;
  try {
    const r = pool.request();
    r.input('messageId', sql.UniqueIdentifier, messageId);
    r.input('prospectId', sql.UniqueIdentifier, prospectId);
    await r.query(`
      UPDATE oe.MessageQueue SET ProspectId = @prospectId WHERE MessageId = @messageId AND ProspectId IS NULL;
      UPDATE oe.MessageHistory SET ProspectId = @prospectId WHERE MessageId = @messageId AND ProspectId IS NULL;
    `);
  } catch (err) {
    console.warn('[prospect.service] tagMessageWithProspect failed:', err.message);
  }
}

/**
 * Split a full name into first/last on the first space (best-effort).
 */
function splitName(name) {
  if (!name || typeof name !== 'string') return { firstName: null, lastName: null };
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Called when a proposal or quote is sent: find-or-create the prospect (no dup),
 * advance status to "Proposal Sent", and return the prospect id. Safe to call from a
 * try/catch in the proposal routes — failures here must not break the send.
 *
 * @returns {Promise<string|null>} the prospect id, or null on failure.
 */
async function recordProposalProspect({ tenantId, agentId, name, email, phone, source = 'Proposal', createdBy }) {
  try {
    const { firstName, lastName } = splitName(name);
    const { prospect } = await findOrCreateProspect({
      tenantId, agentId, firstName, lastName, email, phone,
      source, status: 'Proposal Sent', createdBy,
    });
    const pool = await getPool();
    await advanceStatus(pool, prospect.ProspectId, 'Proposal Sent');
    await stampLastContacted(pool, prospect.ProspectId);
    return prospect.ProspectId;
  } catch (err) {
    console.warn('[prospect.service] recordProposalProspect failed:', err.message);
    return null;
  }
}

/**
 * Proposals + quotes associated with a prospect. Proposals match by ProspectId or by
 * the prospect's email/phone; quotes match by ProspectId. Returned newest-first,
 * unified into { kind, id, name, status, premium, sentDate, pdfUrl }.
 */
async function getProspectProposals(pool, { prospectId, tenantId }) {
  const prospect = await getProspectRow(pool, prospectId);
  if (!prospect || String(prospect.TenantId) !== String(tenantId)) return null;

  const candidates = prospectAddressCandidates(prospect); // lowercased email + phone forms
  const propReq = pool.request();
  propReq.input('prospectId', sql.UniqueIdentifier, prospectId);
  let propMatch = 'ps.ProspectId = @prospectId';
  if (candidates.length) {
    const emailCands = candidates.filter((c) => c.includes('@'));
    const phoneCands = candidates.filter((c) => !c.includes('@'));
    const ors = [];
    emailCands.forEach((c, i) => { propReq.input(`pemail${i}`, sql.NVarChar, c); ors.push(`LOWER(ps.ProspectEmail) = @pemail${i}`); });
    phoneCands.forEach((c, i) => { propReq.input(`pphone${i}`, sql.NVarChar, c); ors.push(`ps.ProspectPhone = @pphone${i}`); });
    if (ors.length) propMatch += ` OR ${ors.join(' OR ')}`;
  }
  const proposals = await propReq.query(`
    SELECT ps.ProposalSendId AS id, ps.ProspectName AS name, ps.SendMethod AS sendMethod,
           ps.GeneratedPdfUrl AS pdfUrl, ps.SentDate AS sentDate, pd.Name AS documentName
    FROM oe.ProposalSends ps
    LEFT JOIN oe.ProposalDocuments pd ON pd.ProposalDocumentId = ps.ProposalDocumentId
    WHERE ${propMatch}
    ORDER BY ps.SentDate DESC
  `);

  const quoteReq = pool.request();
  quoteReq.input('prospectId', sql.UniqueIdentifier, prospectId);
  quoteReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  const quotes = await quoteReq.query(`
    SELECT q.QuoteId AS id, q.ProspectName AS name, q.Status AS status,
           q.TotalPremium AS premium, q.CreatedDate AS sentDate
    FROM oe.Quotes q
    WHERE q.TenantId = @tenantId AND q.ProspectId = @prospectId
    ORDER BY q.CreatedDate DESC
  `);

  return {
    proposals: (proposals.recordset || []).map((r) => ({ kind: 'Proposal', ...r })),
    quotes: (quotes.recordset || []).map((r) => ({ kind: 'Quote', ...r })),
  };
}

/**
 * Permanently delete a prospect and its product links within one transaction.
 * Tenant-scoped: only deletes when the row belongs to the given tenant.
 * @returns {Promise<boolean>} true if a prospect row was deleted.
 */
async function deleteProspect(pool, { prospectId, tenantId }) {
  const tx = new rawSql.Transaction(pool);
  await tx.begin();
  try {
    await tx.request()
      .input('prospectId', sql.UniqueIdentifier, prospectId)
      .query(`DELETE FROM oe.ProspectProducts WHERE ProspectId = @prospectId`);

    await tx.request()
      .input('prospectId', sql.UniqueIdentifier, prospectId)
      .query(`DELETE FROM oe.ProspectTagAssignments WHERE ProspectId = @prospectId`);

    const result = await tx.request()
      .input('prospectId', sql.UniqueIdentifier, prospectId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`DELETE FROM oe.Prospects WHERE ProspectId = @prospectId AND TenantId = @tenantId`);

    await tx.commit();
    return (result.rowsAffected?.[0] || 0) > 0;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/**
 * Build a parameterized "IN (@a0,@a1,...)" clause for a list of agent GUIDs.
 * Returns { clause, apply } where apply(request) binds the params.
 */
function buildAgentInClause(agentIds, column) {
  const names = agentIds.map((_, i) => `@agf${i}`);
  const clause = `${column} IN (${names.join(', ')})`;
  const apply = (request) => {
    agentIds.forEach((id, i) => request.input(`agf${i}`, sql.UniqueIdentifier, id));
  };
  return { clause, apply };
}

/**
 * List prospects in a tenant with visibility + filters.
 * @param agentIds null => no agent restriction (TenantAdmin/SysAdmin); array =>
 *                 restrict to these owning agents (Agent / AgencyOwner scope). An
 *                 empty array yields no results.
 */
async function listProspects({
  tenantId,
  agentIds = null,
  status = null,
  source = null,
  sourceId = null,
  search = null,
  tagIds = null,
  followUp = null,
  sortBy = 'createdDate',
  sortDir = 'desc',
  page = 1,
  pageSize = 25,
}) {
  const pool = await getPool();
  const where = ['p.TenantId = @tenantId'];
  const request = pool.request();
  request.input('tenantId', sql.UniqueIdentifier, tenantId);

  if (Array.isArray(agentIds)) {
    if (agentIds.length === 0) {
      return { prospects: [], total: 0, page, pageSize };
    }
    const { clause, apply } = buildAgentInClause(agentIds, 'p.AgentId');
    where.push(clause);
    apply(request);
  }

  if (status && PROSPECT_STATUSES.includes(status)) {
    where.push('p.Status = @status');
    request.input('status', sql.NVarChar, status);
  }

  if (source && String(source).trim()) {
    where.push('p.Source = @source');
    request.input('source', sql.NVarChar, String(source).trim());
  }

  if (sourceId) {
    where.push('p.SourceId = @sourceId');
    request.input('sourceId', sql.UniqueIdentifier, sourceId);
  }

  if (search && search.trim()) {
    where.push(`(
      p.FirstName LIKE @search OR p.LastName LIKE @search OR
      p.Email LIKE @search OR p.Phone LIKE @search OR p.ReferralName LIKE @search
    )`);
    request.input('search', sql.NVarChar, `%${search.trim()}%`);
  }

  applyTagFilter(where, request, tagIds);
  applyFollowUpFilter(where, followUp);

  const whereClause = where.join(' AND ');
  const orderExpr = PROSPECT_SORTS[sortBy] || PROSPECT_SORTS.createdDate;
  const orderDir = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const offset = Math.max(0, (page - 1) * pageSize);
  request.input('offset', sql.Int, offset);
  request.input('pageSize', sql.Int, pageSize);

  const result = await request.query(`
    SELECT COUNT(*) OVER() AS TotalCount,
      p.ProspectId, p.TenantId, p.AgentId, p.FirstName, p.LastName, p.Email, p.Phone,
      p.Status, p.ReferralName, p.PremiumAmount, p.Source, p.SuggestedMemberId,
      p.MemberId, p.GroupProspectId, p.NextFollowUpDate, p.LastContactedDate,
      p.ClosedDate, p.CreatedDate, p.ModifiedDate, p.SourceId,
      ps.Color AS SourceColor,
      agentUser.FirstName AS AgentFirstName, agentUser.LastName AS AgentLastName
    FROM oe.Prospects p
    LEFT JOIN oe.Agents a ON a.AgentId = p.AgentId
    LEFT JOIN oe.Users agentUser ON agentUser.UserId = a.UserId
    LEFT JOIN oe.ProspectSources ps ON ps.SourceId = p.SourceId
    WHERE ${whereClause}
    ORDER BY ${orderExpr} ${orderDir}
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
  `);

  const rows = (result.recordset || []).map(stripTotal);
  const total = (result.recordset && result.recordset.length) ? result.recordset[0].TotalCount : 0;
  await attachTags(pool, rows);
  return { prospects: rows, total, page, pageSize };
}

/**
 * Aggregated prospect insights for the Insights dashboard, scoped by the SAME
 * visibility contract as listProspects: agentIds null => whole tenant (admins);
 * an array => restrict to those owning agents; an empty array => nothing visible.
 *
 * Range defaults to the trailing 12 months (inclusive of the current month).
 * Optional `from` / `to` (Date or ISO string) override the window.
 *
 * @returns {Promise<{
 *   bySourceMonth: Array<{month: string, source: string, count: number}>,
 *   bySource: Array<{source: string, count: number}>,
 *   byStatus: Array<{status: string, count: number}>,
 *   totals: { total: number, newThisMonth: number, sources: number }
 * }>}
 */
async function getProspectStats({ tenantId, agentIds = null, from = null, to = null, sourceId = null, source = null }) {
  const empty = {
    bySourceMonth: [],
    bySource: [],
    byStatus: [],
    totals: { total: 0, newThisMonth: 0, sources: 0, enrolled: 0 },
  };

  const pool = await getPool();

  // Resolve the date window (default: trailing 12 months, inclusive of this month).
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const fromDate = from ? new Date(from) : defaultFrom;
  const toDate = to ? new Date(to) : null;

  // Shared visibility + range WHERE clause, identical scoping to listProspects.
  const where = ['p.TenantId = @tenantId', 'p.CreatedDate >= @from'];
  const request = pool.request();
  request.input('tenantId', sql.UniqueIdentifier, tenantId);
  request.input('from', sql.DateTime2, fromDate);

  if (Array.isArray(agentIds)) {
    if (agentIds.length === 0) return empty;
    const { clause, apply } = buildAgentInClause(agentIds, 'p.AgentId');
    where.push(clause);
    apply(request);
  }
  if (toDate) {
    where.push('p.CreatedDate <= @to');
    request.input('to', sql.DateTime2, toDate);
  }
  if (sourceId) {
    where.push('p.SourceId = @sourceId');
    request.input('sourceId', sql.UniqueIdentifier, sourceId);
  }
  // Built-in/free-text source filter (Proposal, Quote, Manual, ApiIngest, …) for
  // leads that have no named source row (SourceId null).
  if (source) {
    where.push('p.Source = @source');
    request.input('source', sql.NVarChar, source);
  }

  const whereClause = where.join(' AND ');
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  request.input('monthStart', sql.DateTime2, firstOfThisMonth);

  const result = await request.query(`
    SELECT FORMAT(p.CreatedDate, 'yyyy-MM') AS Month, p.Source AS Source, COUNT(*) AS Cnt
    FROM oe.Prospects p
    WHERE ${whereClause}
    GROUP BY FORMAT(p.CreatedDate, 'yyyy-MM'), p.Source
    ORDER BY Month ASC, Source ASC;

    SELECT p.Source AS Source, COUNT(*) AS Cnt,
           SUM(CASE WHEN p.Status = 'Closed' THEN 1 ELSE 0 END) AS Enrolled
    FROM oe.Prospects p
    WHERE ${whereClause}
    GROUP BY p.Source
    ORDER BY Cnt DESC;

    SELECT p.Status AS Status, COUNT(*) AS Cnt
    FROM oe.Prospects p
    WHERE ${whereClause}
    GROUP BY p.Status;

    SELECT
      COUNT(*) AS Total,
      SUM(CASE WHEN p.CreatedDate >= @monthStart THEN 1 ELSE 0 END) AS NewThisMonth,
      COUNT(DISTINCT p.Source) AS Sources,
      SUM(CASE WHEN p.Status = 'Closed' THEN 1 ELSE 0 END) AS Enrolled
    FROM oe.Prospects p
    WHERE ${whereClause};
  `);

  const sets = result.recordsets || [];
  const bySourceMonth = (sets[0] || []).map((r) => ({ month: r.Month, source: r.Source, count: r.Cnt }));
  const bySource = (sets[1] || []).map((r) => ({ source: r.Source, count: r.Cnt, enrolled: r.Enrolled || 0 }));
  const byStatus = (sets[2] || []).map((r) => ({ status: r.Status, count: r.Cnt }));
  const totalsRow = (sets[3] && sets[3][0]) || {};

  return {
    bySourceMonth,
    bySource,
    byStatus,
    totals: {
      total: totalsRow.Total || 0,
      newThisMonth: totalsRow.NewThisMonth || 0,
      sources: totalsRow.Sources || 0,
      enrolled: totalsRow.Enrolled || 0,
    },
  };
}

/**
 * Add an "EXISTS a tag assignment in @tagN" clause when tagIds is a non-empty array
 * (prospect must carry at least one of the selected tags).
 */
function applyTagFilter(where, request, tagIds) {
  if (!Array.isArray(tagIds) || tagIds.length === 0) return;
  const names = tagIds.map((_, i) => `@tagf${i}`);
  tagIds.forEach((id, i) => request.input(`tagf${i}`, sql.UniqueIdentifier, id));
  where.push(`EXISTS (
    SELECT 1 FROM oe.ProspectTagAssignments ptaf
    WHERE ptaf.ProspectId = p.ProspectId AND ptaf.ProspectTagId IN (${names.join(', ')})
  )`);
}

/**
 * Add a NextFollowUpDate clause. 'overdue' = past due, 'upcoming' = now-or-later,
 * 'any' = a follow-up date is set. Anything else is ignored.
 */
function applyFollowUpFilter(where, followUp) {
  switch (followUp) {
    case 'overdue':
      where.push('p.NextFollowUpDate IS NOT NULL AND p.NextFollowUpDate < GETUTCDATE()');
      break;
    case 'upcoming':
      where.push('p.NextFollowUpDate IS NOT NULL AND p.NextFollowUpDate >= GETUTCDATE()');
      break;
    case 'any':
      where.push('p.NextFollowUpDate IS NOT NULL');
      break;
    default:
      break;
  }
}

/**
 * Batch-load tags for a set of prospect rows and attach a `Tags` array to each
 * (each tag: { ProspectTagId, Name, Color }). Mutates rows in place.
 */
async function attachTags(pool, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const ids = rows.map((r) => r.ProspectId);
  const req = pool.request();
  const names = ids.map((_, i) => `@pid${i}`);
  ids.forEach((id, i) => req.input(`pid${i}`, sql.UniqueIdentifier, id));
  const res = await req.query(`
    SELECT pta.ProspectId, t.ProspectTagId, t.Name, t.Color
    FROM oe.ProspectTagAssignments pta
    JOIN oe.ProspectTags t ON t.ProspectTagId = pta.ProspectTagId
    WHERE pta.ProspectId IN (${names.join(', ')})
    ORDER BY t.Name ASC
  `);
  const byProspect = new Map();
  for (const row of res.recordset || []) {
    const key = String(row.ProspectId);
    if (!byProspect.has(key)) byProspect.set(key, []);
    byProspect.get(key).push({ ProspectTagId: row.ProspectTagId, Name: row.Name, Color: row.Color });
  }
  for (const r of rows) {
    r.Tags = byProspect.get(String(r.ProspectId)) || [];
  }
}

function stripTotal(row) {
  const { TotalCount, ...rest } = row;
  return rest;
}

/**
 * All matching prospects (no pagination) for the report, with products rolled up into a
 * single string and agent/member context joined. Same visibility contract as
 * listProspects: agentIds null => whole tenant; array => restrict; empty => none.
 */
async function getProspectsForReport({ tenantId, agentIds = null, status = null, search = null, tagIds = null, followUp = null }) {
  const pool = await getPool();
  const where = ['p.TenantId = @tenantId'];
  const request = pool.request();
  request.input('tenantId', sql.UniqueIdentifier, tenantId);

  if (Array.isArray(agentIds)) {
    if (agentIds.length === 0) return [];
    const { clause, apply } = buildAgentInClause(agentIds, 'p.AgentId');
    where.push(clause);
    apply(request);
  }
  if (status && PROSPECT_STATUSES.includes(status)) {
    where.push('p.Status = @status');
    request.input('status', sql.NVarChar, status);
  }
  if (search && search.trim()) {
    where.push('(p.FirstName LIKE @search OR p.LastName LIKE @search OR p.Email LIKE @search OR p.Phone LIKE @search OR p.ReferralName LIKE @search)');
    request.input('search', sql.NVarChar, `%${search.trim()}%`);
  }
  applyTagFilter(where, request, tagIds);
  applyFollowUpFilter(where, followUp);

  const result = await request.query(`
    SELECT
      p.FirstName, p.LastName, p.Email, p.Phone, p.Status, p.ReferralName,
      p.PremiumAmount, p.Source, p.CreatedDate, p.ClosedDate,
      p.NextFollowUpDate, p.LastContactedDate,
      CASE WHEN p.MemberId IS NOT NULL THEN 'Yes' ELSE 'No' END AS IsMember,
      agentUser.FirstName AS AgentFirstName, agentUser.LastName AS AgentLastName,
      (
        SELECT STRING_AGG(pr.Name, '; ')
        FROM oe.ProspectProducts pp
        LEFT JOIN oe.Products pr ON pr.ProductId = pp.ProductId
        WHERE pp.ProspectId = p.ProspectId
      ) AS Products,
      (
        SELECT STRING_AGG(t.Name, '; ')
        FROM oe.ProspectTagAssignments pta
        JOIN oe.ProspectTags t ON t.ProspectTagId = pta.ProspectTagId
        WHERE pta.ProspectId = p.ProspectId
      ) AS Tags
    FROM oe.Prospects p
    LEFT JOIN oe.Agents a ON a.AgentId = p.AgentId
    LEFT JOIN oe.Users agentUser ON agentUser.UserId = a.UserId
    WHERE ${where.join(' AND ')}
    ORDER BY p.CreatedDate DESC
  `);
  return result.recordset || [];
}

/**
 * Raw single-prospect row (no products / member detail). Internal helper.
 */
async function getProspectRow(pool, prospectId) {
  const r = pool.request();
  r.input('prospectId', sql.UniqueIdentifier, prospectId);
  const result = await r.query(`SELECT * FROM oe.Prospects WHERE ProspectId = @prospectId`);
  return result.recordset[0] || null;
}

/**
 * Full prospect detail: the prospect, its products, and (if linked/suggested)
 * a light member summary for the suggestion banner / member link.
 */
async function getProspect(pool, { prospectId, tenantId }) {
  const r = pool.request();
  r.input('prospectId', sql.UniqueIdentifier, prospectId);
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  const result = await r.query(`
    SELECT p.*, agentUser.FirstName AS AgentFirstName, agentUser.LastName AS AgentLastName
    FROM oe.Prospects p
    LEFT JOIN oe.Agents a ON a.AgentId = p.AgentId
    LEFT JOIN oe.Users agentUser ON agentUser.UserId = a.UserId
    WHERE p.ProspectId = @prospectId AND p.TenantId = @tenantId
  `);
  const prospect = result.recordset[0];
  if (!prospect) return null;

  const productsReq = pool.request();
  productsReq.input('prospectId', sql.UniqueIdentifier, prospectId);
  const products = await productsReq.query(`
    SELECT pp.ProspectProductId, pp.ProductId, pp.PremiumAmount, pp.Source, pp.CreatedDate,
           pr.Name AS ProductName
    FROM oe.ProspectProducts pp
    LEFT JOIN oe.Products pr ON pr.ProductId = pp.ProductId
    WHERE pp.ProspectId = @prospectId
    ORDER BY pp.CreatedDate ASC
  `);

  const memberIdForSummary = prospect.MemberId || prospect.SuggestedMemberId;
  let member = null;
  if (memberIdForSummary) {
    const mReq = pool.request();
    mReq.input('memberId', sql.UniqueIdentifier, memberIdForSummary);
    const mRes = await mReq.query(`
      SELECT TOP 1 m.MemberId, m.Status, u.FirstName, u.LastName, u.Email, u.PhoneNumber
      FROM oe.Members m
      JOIN oe.Users u ON u.UserId = m.UserId
      WHERE m.MemberId = @memberId
    `);
    member = mRes.recordset[0] || null;
  }

  // Tags assigned to this prospect.
  const tagReq = pool.request();
  tagReq.input('prospectId', sql.UniqueIdentifier, prospectId);
  const tagRes = await tagReq.query(`
    SELECT t.ProspectTagId, t.Name, t.Color
    FROM oe.ProspectTagAssignments pta
    JOIN oe.ProspectTags t ON t.ProspectTagId = pta.ProspectTagId
    WHERE pta.ProspectId = @prospectId
    ORDER BY t.Name ASC
  `);

  // Light group-prospect summary if this prospect belongs to a group.
  let group = null;
  if (prospect.GroupProspectId) {
    const gReq = pool.request();
    gReq.input('gid', sql.UniqueIdentifier, prospect.GroupProspectId);
    const gRes = await gReq.query(`
      SELECT TOP 1 GroupProspectId, CompanyName, ContactEmail, TotalEmployees, Status
      FROM oe.GroupProspects WHERE GroupProspectId = @gid
    `);
    group = gRes.recordset[0] || null;
  }

  return { prospect, products: products.recordset || [], member, tags: tagRes.recordset || [], group };
}

/**
 * Stamp LastContactedDate = now on a prospect (best-effort; called when a
 * communication / proposal / quote goes out). Never throws.
 */
async function stampLastContacted(pool, prospectId) {
  if (!prospectId) return;
  try {
    await pool.request()
      .input('prospectId', sql.UniqueIdentifier, prospectId)
      .query(`UPDATE oe.Prospects SET LastContactedDate = GETUTCDATE(), ModifiedDate = GETUTCDATE() WHERE ProspectId = @prospectId`);
  } catch (err) {
    console.warn('[prospect.service] stampLastContacted failed:', err.message);
  }
}

/**
 * Reassign a prospect to a different owning agent. Tenant-scoped.
 * @returns {Promise<boolean>} true if a row was updated.
 */
async function reassignAgent(pool, { prospectId, agentId, tenantId }) {
  const r = pool.request();
  r.input('prospectId', sql.UniqueIdentifier, prospectId);
  r.input('agentId', sql.UniqueIdentifier, agentId || null);
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  const res = await r.query(`
    UPDATE oe.Prospects SET AgentId = @agentId, ModifiedDate = GETUTCDATE()
    WHERE ProspectId = @prospectId AND TenantId = @tenantId
  `);
  return (res.rowsAffected?.[0] || 0) > 0;
}

// ---------------------------------------------------------------------------
// Tags (agency-shared, colored, many-to-many)
// ---------------------------------------------------------------------------

/**
 * List tags visible to the caller: all tenant-wide tags (AgencyId NULL) plus, for a
 * non-admin agent, the tags shared within their agency. Admins (agencyId omitted +
 * isAdmin) see every tag in the tenant.
 */
async function listTags(pool, { tenantId, agencyId = null, isAdmin = false }) {
  const r = pool.request();
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  let scope = '';
  if (!isAdmin) {
    // Tenant-wide tags + this agency's tags.
    r.input('agencyId', sql.UniqueIdentifier, agencyId);
    scope = ' AND (t.AgencyId IS NULL OR t.AgencyId = @agencyId)';
  }
  const res = await r.query(`
    SELECT t.ProspectTagId, t.AgencyId, t.Name, t.Color, t.CreatedDate
    FROM oe.ProspectTags t
    WHERE t.TenantId = @tenantId${scope}
    ORDER BY t.Name ASC
  `);
  return res.recordset || [];
}

/**
 * Create a tag (find-or-create, case-insensitive within the tenant + agency scope).
 * Returns the tag row (existing or new).
 */
async function createTag(pool, { tenantId, agencyId = null, name, color = 'gray', createdBy = null }) {
  const cleanName = (name || '').trim();
  if (!cleanName) throw new Error('Tag name is required');
  const safeColor = TAG_COLORS.includes(color) ? color : 'gray';

  // Reuse an existing tag with the same name in the same scope (case-insensitive).
  const find = pool.request();
  find.input('tenantId', sql.UniqueIdentifier, tenantId);
  find.input('name', sql.NVarChar, cleanName);
  find.input('agencyId', sql.UniqueIdentifier, agencyId);
  const existing = await find.query(`
    SELECT TOP 1 ProspectTagId, AgencyId, Name, Color, CreatedDate
    FROM oe.ProspectTags
    WHERE TenantId = @tenantId
      AND LOWER(Name) = LOWER(@name)
      AND ((AgencyId IS NULL AND @agencyId IS NULL) OR AgencyId = @agencyId)
  `);
  if (existing.recordset.length) return existing.recordset[0];

  const tagId = crypto.randomUUID();
  const r = pool.request();
  r.input('tagId', sql.UniqueIdentifier, tagId);
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  r.input('agencyId', sql.UniqueIdentifier, agencyId);
  r.input('name', sql.NVarChar, cleanName);
  r.input('color', sql.NVarChar, safeColor);
  r.input('createdBy', sql.UniqueIdentifier, createdBy);
  await r.query(`
    INSERT INTO oe.ProspectTags (ProspectTagId, TenantId, AgencyId, Name, Color, CreatedBy, CreatedDate)
    VALUES (@tagId, @tenantId, @agencyId, @name, @color, @createdBy, GETUTCDATE())
  `);
  return { ProspectTagId: tagId, AgencyId: agencyId, Name: cleanName, Color: safeColor, CreatedDate: new Date() };
}

/**
 * Fetch a single tag row scoped to the tenant (for access checks). Null if not found.
 */
async function getTag(pool, { tagId, tenantId }) {
  const r = pool.request();
  r.input('tagId', sql.UniqueIdentifier, tagId);
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  const res = await r.query(`
    SELECT TOP 1 ProspectTagId, TenantId, AgencyId, Name, Color
    FROM oe.ProspectTags WHERE ProspectTagId = @tagId AND TenantId = @tenantId
  `);
  return res.recordset[0] || null;
}

/**
 * Delete a tag (and all its assignments) within one transaction. Tenant-scoped.
 * @returns {Promise<boolean>} true if the tag was deleted.
 */
async function deleteTag(pool, { tagId, tenantId }) {
  const tx = new rawSql.Transaction(pool);
  await tx.begin();
  try {
    await tx.request()
      .input('tagId', sql.UniqueIdentifier, tagId)
      .query(`DELETE FROM oe.ProspectTagAssignments WHERE ProspectTagId = @tagId`);
    const res = await tx.request()
      .input('tagId', sql.UniqueIdentifier, tagId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`DELETE FROM oe.ProspectTags WHERE ProspectTagId = @tagId AND TenantId = @tenantId`);
    await tx.commit();
    return (res.rowsAffected?.[0] || 0) > 0;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/**
 * Assign a tag to a prospect (idempotent via the unique constraint).
 */
async function assignTag(pool, { prospectId, tagId, tenantId, createdBy = null }) {
  const r = pool.request();
  r.input('id', sql.UniqueIdentifier, crypto.randomUUID());
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  r.input('prospectId', sql.UniqueIdentifier, prospectId);
  r.input('tagId', sql.UniqueIdentifier, tagId);
  r.input('createdBy', sql.UniqueIdentifier, createdBy);
  await r.query(`
    IF NOT EXISTS (SELECT 1 FROM oe.ProspectTagAssignments WHERE ProspectId = @prospectId AND ProspectTagId = @tagId)
    INSERT INTO oe.ProspectTagAssignments (ProspectTagAssignmentId, TenantId, ProspectId, ProspectTagId, CreatedBy, CreatedDate)
    VALUES (@id, @tenantId, @prospectId, @tagId, @createdBy, GETUTCDATE())
  `);
}

/**
 * Remove a tag from a prospect.
 */
async function unassignTag(pool, { prospectId, tagId }) {
  const r = pool.request();
  r.input('prospectId', sql.UniqueIdentifier, prospectId);
  r.input('tagId', sql.UniqueIdentifier, tagId);
  await r.query(`DELETE FROM oe.ProspectTagAssignments WHERE ProspectId = @prospectId AND ProspectTagId = @tagId`);
}

// ---------------------------------------------------------------------------
// Group prospects (company-level lead behind a business proposal)
// ---------------------------------------------------------------------------

/**
 * Find-or-create a group prospect for a company. Dedupe: contact email (primary),
 * then normalized company name within the same tenant + owning agent. Returns the
 * GroupProspectId, or null on failure (best-effort, never throws).
 */
async function findOrCreateGroupProspect({ tenantId, agentId = null, companyName, contactName = null, email = null, phone = null, totalEmployees = null, createdBy = null }) {
  try {
    if (!tenantId || !companyName) return null;
    const pool = await getPool();
    const emailNormalized = normalizeEmail(email);
    const phoneNormalized = normalizePhone(phone);
    const companyNorm = String(companyName).trim().toLowerCase();

    // Match by email first, then by company name (scoped to tenant + agent).
    if (emailNormalized) {
      const r = pool.request();
      r.input('tenantId', sql.UniqueIdentifier, tenantId);
      r.input('emailNorm', sql.NVarChar, emailNormalized);
      const byEmail = await r.query(`SELECT TOP 1 GroupProspectId FROM oe.GroupProspects WHERE TenantId = @tenantId AND EmailNormalized = @emailNorm ORDER BY CreatedDate ASC`);
      if (byEmail.recordset.length) return byEmail.recordset[0].GroupProspectId;
    }
    {
      const r = pool.request();
      r.input('tenantId', sql.UniqueIdentifier, tenantId);
      r.input('companyNorm', sql.NVarChar, companyNorm);
      r.input('agentId', sql.UniqueIdentifier, agentId);
      const byName = await r.query(`
        SELECT TOP 1 GroupProspectId FROM oe.GroupProspects
        WHERE TenantId = @tenantId AND CompanyNameNormalized = @companyNorm
          AND ((AgentId IS NULL AND @agentId IS NULL) OR AgentId = @agentId)
        ORDER BY CreatedDate ASC
      `);
      if (byName.recordset.length) return byName.recordset[0].GroupProspectId;
    }

    const groupId = crypto.randomUUID();
    const r = pool.request();
    r.input('groupId', sql.UniqueIdentifier, groupId);
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('agentId', sql.UniqueIdentifier, agentId);
    r.input('companyName', sql.NVarChar, String(companyName).trim());
    r.input('companyNorm', sql.NVarChar, companyNorm);
    r.input('contactName', sql.NVarChar, contactName);
    r.input('email', sql.NVarChar, email);
    r.input('emailNorm', sql.NVarChar, emailNormalized);
    r.input('phone', sql.NVarChar, phone);
    r.input('phoneNorm', sql.NVarChar, phoneNormalized);
    r.input('totalEmployees', sql.Int, totalEmployees != null ? totalEmployees : null);
    r.input('createdBy', sql.UniqueIdentifier, createdBy);
    await r.query(`
      INSERT INTO oe.GroupProspects
        (GroupProspectId, TenantId, AgentId, CompanyName, CompanyNameNormalized, ContactName,
         ContactEmail, EmailNormalized, ContactPhone, PhoneNormalized, TotalEmployees, Status,
         CreatedBy, CreatedDate, ModifiedDate)
      VALUES
        (@groupId, @tenantId, @agentId, @companyName, @companyNorm, @contactName,
         @email, @emailNorm, @phone, @phoneNorm, @totalEmployees, 'Proposal Sent',
         @createdBy, GETUTCDATE(), GETUTCDATE())
    `);
    return groupId;
  } catch (err) {
    console.warn('[prospect.service] findOrCreateGroupProspect failed:', err.message);
    return null;
  }
}

/**
 * Link a prospect to a group prospect (best-effort; only sets it if currently null).
 */
async function linkProspectToGroup(pool, prospectId, groupProspectId) {
  if (!prospectId || !groupProspectId) return;
  try {
    await pool.request()
      .input('prospectId', sql.UniqueIdentifier, prospectId)
      .input('groupId', sql.UniqueIdentifier, groupProspectId)
      .query(`UPDATE oe.Prospects SET GroupProspectId = @groupId, ModifiedDate = GETUTCDATE() WHERE ProspectId = @prospectId AND GroupProspectId IS NULL`);
  } catch (err) {
    console.warn('[prospect.service] linkProspectToGroup failed:', err.message);
  }
}

module.exports = {
  PROSPECT_STATUSES,
  PROSPECT_SOURCES,
  NOTIFY_SOURCES,
  TAG_COLORS,
  normalizeEmail,
  normalizePhone,
  suggestMemberMatch,
  findProspectByIdentity,
  findOrCreateProspect,
  advanceStatus,
  confirmMemberLink,
  deleteProspect,
  listProspects,
  getProspectStats,
  getProspectsForReport,
  getProspect,
  getProspectRow,
  prospectAddressCandidates,
  getProspectCommunications,
  tagMessageWithProspect,
  recordProposalProspect,
  getProspectProposals,
  splitName,
  stampLastContacted,
  reassignAgent,
  listTags,
  createTag,
  getTag,
  deleteTag,
  assignTag,
  unassignTag,
  findOrCreateGroupProspect,
  linkProspectToGroup,
};
