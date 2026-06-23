'use strict';

const { sql } = require('../config/database');
const { buildMemberPortalLoginUrl } = require('../utils/memberPortalUrl');
const MessageQueueService = require('./messageQueue.service');

const MAX_SMS_MEMBERS = 500;

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} tenantId
 */
function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

async function loadTenantForPortalUrl(pool, tenantId) {
  const r = await pool
    .request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT Name, ContactEmail, CustomDomain, DefaultUrlPath, IsDefaultUrlPathVerified, AdvancedSettings
      FROM oe.Tenants
      WHERE TenantId = @tenantId
    `);
  return r.recordset[0] || null;
}

/**
 * Portal URL + tenant display name + support email for outreach copy (no hardcoded brand).
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} tenantId
 * @returns {Promise<{ memberPortalLoginUrl: string, tenantName: string | null, supportEmail: string | null }>}
 */
async function getMemberOutreachDefaults(pool, tenantId) {
  const row = await loadTenantForPortalUrl(pool, tenantId);
  if (!row) {
    return {
      memberPortalLoginUrl: buildMemberPortalLoginUrl({}),
      tenantName: null,
      supportEmail: null
    };
  }
  return {
    memberPortalLoginUrl: buildMemberPortalLoginUrl(row),
    tenantName: trimOrNull(row.Name),
    supportEmail: trimOrNull(row.ContactEmail)
  };
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} tenantId
 * @returns {Promise<string>}
 */
async function getMemberPortalLoginUrlForTenant(pool, tenantId) {
  const ctx = await getMemberOutreachDefaults(pool, tenantId);
  return ctx.memberPortalLoginUrl;
}

/**
 * SMS — why + portal link + help (keep in sync with frontend buildMissingRecurringSmsBody).
 * MessageQueue normalizes phone to E.164.
 * @param {string} portalUrl
 * @param {{ Name?: string|null, ContactEmail?: string|null } | null} tenantRow
 */
function buildMissingRecurringSmsBody(portalUrl, tenantRow) {
  const name = trimOrNull(tenantRow?.Name);
  const lead = name ? `${name}: ` : '';
  let hostLine = '';
  try {
    const u = new URL(portalUrl);
    hostLine = String(u.hostname || '').replace(/^www\./i, '') || portalUrl;
  } catch {
    hostLine = portalUrl;
  }
  return (
    `${lead}Your account is missing a valid payment method, your plan requires this to remain active. Please sign in to our secure portal to add or update your payment information to make sure your plan stays active:\n\n${hostLine}`
  );
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {{ tenantId: string, memberIds: string[], createdBy: string | null }} params
 */
async function queueMissingRecurringSms(pool, params) {
  const { tenantId, createdBy } = params;
  const rawIds = Array.isArray(params.memberIds) ? params.memberIds : [];
  const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const uniqueMemberIds = [...new Set(rawIds.map((x) => String(x).replace(/[{}]/g, '').trim()))]
    .filter((id) => uuidRe.test(id))
    .slice(0, MAX_SMS_MEMBERS);

  if (uniqueMemberIds.length === 0) {
    return {
      queued: 0,
      skippedNoPhone: 0,
      skippedDuplicatePhone: 0,
      skippedNotFound: 0
    };
  }

  const tenantRow = await loadTenantForPortalUrl(pool, tenantId);
  if (!tenantRow) {
    throw new Error('Tenant not found');
  }
  const portalUrl = buildMemberPortalLoginUrl(tenantRow);
  const messageBody = buildMissingRecurringSmsBody(portalUrl, tenantRow);

  const request = pool.request().input('tenantId', sql.UniqueIdentifier, tenantId);
  const placeholders = uniqueMemberIds.map((_, i) => `@mid${i}`);
  uniqueMemberIds.forEach((id, i) => {
    request.input(`mid${i}`, sql.UniqueIdentifier, id);
  });

  const q = `
    SELECT m.MemberId, u.PhoneNumber, u.UserId
    FROM oe.Members m
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.TenantId = @tenantId
      AND m.MemberId IN (${placeholders.join(', ')})
  `;
  const result = await request.query(q);
  const rows = result.recordset || [];

  /** @type {Map<string, { phone: string, userId: string | null }>} */
  const byMember = new Map();
  for (const row of rows) {
    const midKey = String(row.MemberId)
      .replace(/[{}]/g, '')
      .toLowerCase();
    byMember.set(midKey, {
      phone: row.PhoneNumber != null ? String(row.PhoneNumber).trim() : '',
      userId: row.UserId ? String(row.UserId) : null
    });
  }

  let queued = 0;
  let skippedNoPhone = 0;
  let skippedNotFound = 0;
  let skippedDuplicatePhone = 0;
  const seenPhoneDigits = new Set();

  for (const mid of uniqueMemberIds) {
    const info = byMember.get(mid.replace(/[{}]/g, '').toLowerCase());
    if (!info) {
      skippedNotFound++;
      continue;
    }
    const raw = info.phone;
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10) {
      skippedNoPhone++;
      continue;
    }
    if (seenPhoneDigits.has(digits)) {
      skippedDuplicatePhone++;
      continue;
    }
    seenPhoneDigits.add(digits);

    await MessageQueueService.queueMessage({
      tenantId,
      messageType: 'SMS',
      recipientAddress: raw,
      subject: null,
      messageBody,
      status: 'Pending',
      createdBy,
      recipientId: info.userId || null,
      ...MessageQueueService.billingNotificationQueueOptions(),
    });
    queued++;
  }

  return {
    queued,
    skippedNoPhone,
    skippedDuplicatePhone,
    skippedNotFound
  };
}

module.exports = {
  getMemberPortalLoginUrlForTenant,
  getMemberOutreachDefaults,
  buildMissingRecurringSmsBody,
  queueMissingRecurringSms,
  MAX_SMS_MEMBERS
};
