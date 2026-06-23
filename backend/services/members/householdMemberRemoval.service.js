'use strict';

const crypto = require('crypto');
const { sql } = require('../../config/database');
const { getUserRoles } = require('../../middleware/auth');
const UserEmailService = require('../shared/user-email.service');

function isPrivileged(userRoles) {
  return (
    userRoles.includes('Admin') ||
    userRoles.includes('SysAdmin') ||
    userRoles.includes('TenantAdmin')
  );
}

/** Dependent / placeholder addresses — do not rename */
function isNoEmailPlaceholder(email) {
  const e = String(email || '').trim().toLowerCase();
  return !e || e.includes('@noemail.com');
}

function isAlreadyRemovedPrefixed(email) {
  return /^removed_/i.test(String(email || '').trim());
}

function shouldRenameEmail(email) {
  if (isNoEmailPlaceholder(email)) return false;
  if (isAlreadyRemovedPrefixed(email)) return false;
  return true;
}

/**
 * Discarded login: removed_<6hex>_<timeBase36>_<originalLocal>@domain
 * Keeps the original mailbox name for support/history; short uniqueness segment vs raw unix ms + long hex.
 * Truncates if local part + prefix exceeds 64 chars (RFC common limit).
 */
function computeRemovedEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return null;
  const local = normalized.slice(0, at).replace(/\s/g, '');
  const domain = normalized.slice(at + 1).replace(/\s/g, '');
  if (!local || !domain) return null;
  const id = crypto.randomBytes(3).toString('hex');
  const t = Date.now().toString(36);
  const prefix = `removed_${id}_${t}_`;
  let newLocal = `${prefix}${local}`;
  const MAX_LOCAL = 64;
  if (newLocal.length > MAX_LOCAL) {
    const hash = crypto.randomBytes(4).toString('hex');
    newLocal = `${prefix}${hash}_${local.slice(0, 12)}`.slice(0, MAX_LOCAL);
  }
  return `${newLocal}@${domain}`;
}

async function pickAvailableRenamedEmail(pool, rawEmail, userId) {
  let attempts = 0;
  while (attempts < 25) {
    attempts += 1;
    const candidate = computeRemovedEmail(rawEmail);
    if (!candidate) return null;
    const avail = await UserEmailService.checkEmailAvailable(candidate, userId);
    if (avail.available) return candidate;
  }
  return null;
}

async function loadRemovalAnchor(pool, req, memberId) {
  const userRoles = getUserRoles(req.user);

  const request = pool.request();
  request.input('memberId', sql.UniqueIdentifier, memberId);
  // Match GET /api/members/:id tenant scope — oe.Members.TenantId is not always populated when GroupId/user tenant defines access.
  let q = `
    SELECT m.MemberId, m.UserId, m.HouseholdId, m.GroupId, m.TenantId, m.AgentId,
           u.Email, u.FirstName, u.LastName,
           CASE m.RelationshipType WHEN 'P' THEN 'Primary' WHEN 'S' THEN 'Spouse' WHEN 'C' THEN 'Child' ELSE 'Unknown' END AS RelationshipDescription
    FROM oe.Members m
    JOIN oe.Users u ON m.UserId = u.UserId
    LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
    WHERE m.MemberId = @memberId
  `;
  if (!userRoles.includes('SysAdmin')) {
    q += ` AND (g.TenantId = @tenantId OR (m.GroupId IS NULL AND u.TenantId = @tenantId))`;
    request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
  }

  const res = await request.query(q);
  if (res.recordset.length === 0) {
    return { error: { status: 404, message: 'Member not found or access denied' } };
  }

  const anchor = res.recordset[0];

  if (!isPrivileged(userRoles)) {
    const scopeReq = pool.request();
    scopeReq.input('memberId', sql.UniqueIdentifier, memberId);
    const scopeRes = await scopeReq.query(`
      SELECT m.AgentId, m.TenantId
      FROM oe.Members m
      WHERE m.MemberId = @memberId
    `);
    if (scopeRes.recordset.length === 0) {
      return { error: { status: 404, message: 'Member not found or access denied' } };
    }
    const row = scopeRes.recordset[0];
    if (String(row.TenantId).toLowerCase() !== String(req.user.TenantId).toLowerCase()) {
      return { error: { status: 403, message: 'Not authorized to delete this member' } };
    }

    const viewerReq = pool.request();
    viewerReq.input('userId', sql.UniqueIdentifier, req.user.UserId);
    const viewerRes = await viewerReq.query(`
      SELECT AgentId, AgencyId FROM oe.Agents WHERE UserId = @userId AND Status = 'Active'
    `);
    if (viewerRes.recordset.length === 0) {
      return { error: { status: 403, message: 'Not authorized to delete this member' } };
    }
    const viewerAgentId = viewerRes.recordset[0].AgentId;
    const viewerAgencyId = viewerRes.recordset[0].AgencyId;

    if (userRoles.includes('AgencyOwner')) {
      if (!row.AgentId) {
        return { error: { status: 403, message: 'Not authorized to delete this member' } };
      }
      const maReq = pool.request();
      maReq.input('memberAgentId', sql.UniqueIdentifier, row.AgentId);
      const maRes = await maReq.query(`
        SELECT AgencyId FROM oe.Agents WHERE AgentId = @memberAgentId AND Status = 'Active'
      `);
      const memberAgencyId = maRes.recordset[0]?.AgencyId;
      if (
        !viewerAgencyId ||
        !memberAgencyId ||
        String(memberAgencyId).toLowerCase() !== String(viewerAgencyId).toLowerCase()
      ) {
        return { error: { status: 403, message: 'Not authorized to delete this member' } };
      }
    } else if (userRoles.includes('Agent')) {
      if (!row.AgentId || String(row.AgentId).toLowerCase() !== String(viewerAgentId).toLowerCase()) {
        return { error: { status: 403, message: 'Not authorized to delete this member' } };
      }
    } else {
      return { error: { status: 403, message: 'Not authorized to delete this member' } };
    }
  }

  return { anchor };
}

async function loadHouseholdRemovalRows(pool, anchor, req) {
  const userRoles = getUserRoles(req.user);
  const request = pool.request();

  let q = `
    SELECT m.MemberId, m.UserId, m.AgentId, m.TenantId, m.GroupId,
           u.Email, u.FirstName, u.LastName,
           CASE m.RelationshipType WHEN 'P' THEN 'Primary' WHEN 'S' THEN 'Spouse' WHEN 'C' THEN 'Child' ELSE 'Unknown' END AS RelationshipDescription
    FROM oe.Members m
    JOIN oe.Users u ON m.UserId = u.UserId
    LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
    WHERE 1 = 1
  `;

  if (!userRoles.includes('SysAdmin')) {
    request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
    q += ` AND (g.TenantId = @tenantId OR (m.GroupId IS NULL AND u.TenantId = @tenantId))`;
  }

  if (anchor.HouseholdId) {
    request.input('householdId', sql.UniqueIdentifier, anchor.HouseholdId);
    q += ` AND m.HouseholdId = @householdId`;
    if (anchor.GroupId) {
      request.input('groupId', sql.UniqueIdentifier, anchor.GroupId);
      q += ` AND m.GroupId = @groupId`;
    } else {
      q += ` AND m.GroupId IS NULL`;
    }
  } else {
    request.input('memberId', sql.UniqueIdentifier, anchor.MemberId);
    q += ` AND m.MemberId = @memberId`;
  }

  const res = await request.query(q);
  return res.recordset || [];
}

async function assertAgentAccessToAllRows(pool, req, rows) {
  const userRoles = getUserRoles(req.user);
  if (isPrivileged(userRoles)) return { ok: true };

  const viewerReq = pool.request();
  viewerReq.input('userId', sql.UniqueIdentifier, req.user.UserId);
  const viewerRes = await viewerReq.query(`
    SELECT AgentId, AgencyId FROM oe.Agents WHERE UserId = @userId AND Status = 'Active'
  `);
  if (viewerRes.recordset.length === 0) {
    return { ok: false, status: 403, message: 'Not authorized to delete this member' };
  }
  const viewerAgentId = viewerRes.recordset[0].AgentId;
  const viewerAgencyId = viewerRes.recordset[0].AgencyId;

  if (userRoles.includes('AgencyOwner')) {
    for (const row of rows) {
      if (!row.AgentId) {
        return { ok: false, status: 403, message: 'Not authorized to remove one or more household members' };
      }
      const maReq = pool.request();
      maReq.input('memberAgentId', sql.UniqueIdentifier, row.AgentId);
      const maRes = await maReq.query(`
        SELECT AgencyId FROM oe.Agents WHERE AgentId = @memberAgentId AND Status = 'Active'
      `);
      const memberAgencyId = maRes.recordset[0]?.AgencyId;
      if (
        !viewerAgencyId ||
        !memberAgencyId ||
        String(memberAgencyId).toLowerCase() !== String(viewerAgencyId).toLowerCase()
      ) {
        return { ok: false, status: 403, message: 'Not authorized to remove one or more household members' };
      }
    }
    return { ok: true };
  }

  if (userRoles.includes('Agent')) {
    for (const row of rows) {
      if (!row.AgentId || String(row.AgentId).toLowerCase() !== String(viewerAgentId).toLowerCase()) {
        return { ok: false, status: 403, message: 'Not authorized to remove one or more household members' };
      }
    }
    return { ok: true };
  }

  return { ok: false, status: 403, message: 'Not authorized to delete this member' };
}

async function buildEmailChangePlan(pool, rows) {
  const membersSetInactive = rows.map((r) => ({
    memberId: r.MemberId,
    userId: r.UserId,
    firstName: r.FirstName,
    lastName: r.LastName,
    relationship: r.RelationshipDescription,
  }));

  const emailChanges = [];
  const seenUser = new Set();

  for (const r of rows) {
    if (!shouldRenameEmail(r.Email)) continue;
    if (seenUser.has(String(r.UserId).toLowerCase())) continue;
    seenUser.add(String(r.UserId).toLowerCase());

    const fromEmail = String(r.Email || '').trim();
    const toEmail = await pickAvailableRenamedEmail(pool, fromEmail, r.UserId);
    if (!toEmail) {
      return {
        error: {
          status: 500,
          message: 'Could not allocate a unique removed_* email; try again or contact support.',
        },
      };
    }
    emailChanges.push({
      memberId: r.MemberId,
      userId: r.UserId,
      firstName: r.FirstName,
      lastName: r.LastName,
      relationship: r.RelationshipDescription,
      fromEmail,
      toEmail,
    });
  }

  return { membersSetInactive, emailChanges };
}

/**
 * Preview household removal (inactive members + emails renamed except @noemail.com / already removed_*).
 */
async function getHouseholdRemovalPreview(pool, req, anchorMemberId) {
  const anchorResult = await loadRemovalAnchor(pool, req, anchorMemberId);
  if (anchorResult.error) return anchorResult;

  const rows = await loadHouseholdRemovalRows(pool, anchorResult.anchor, req);
  const scope = await assertAgentAccessToAllRows(pool, req, rows);
  if (!scope.ok) {
    return { error: { status: scope.status, message: scope.message } };
  }

  const plan = await buildEmailChangePlan(pool, rows);
  if (plan.error) return plan;

  return {
    data: {
      membersSetInactive: plan.membersSetInactive,
      emailChanges: plan.emailChanges,
    },
  };
}

/**
 * Transaction: rename emails (Users + Agents), set all target Members inactive.
 */
async function executeHouseholdRemoval(pool, req, anchorMemberId, modifiedByUserId) {
  const anchorResult = await loadRemovalAnchor(pool, req, anchorMemberId);
  if (anchorResult.error) return anchorResult;

  const rows = await loadHouseholdRemovalRows(pool, anchorResult.anchor, req);
  const scope = await assertAgentAccessToAllRows(pool, req, rows);
  if (!scope.ok) {
    return { error: { status: scope.status, message: scope.message } };
  }

  const plan = await buildEmailChangePlan(pool, rows);
  if (plan.error) return plan;

  const transaction = pool.transaction();
  await transaction.begin();
  try {
    const seenEmailUser = new Set();
    for (const ec of plan.emailChanges) {
      const key = String(ec.userId).toLowerCase();
      if (seenEmailUser.has(key)) continue;
      seenEmailUser.add(key);

      const ur = transaction.request();
      ur.input('userId', sql.UniqueIdentifier, ec.userId);
      ur.input('email', sql.NVarChar, ec.toEmail);
      ur.input('modifiedBy', sql.UniqueIdentifier, modifiedByUserId);
      await ur.query(`
        UPDATE oe.Users
        SET Email = @email, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
        WHERE UserId = @userId
      `);

      const ar = transaction.request();
      ar.input('userId', sql.UniqueIdentifier, ec.userId);
      ar.input('email', sql.NVarChar, ec.toEmail);
      ar.input('modifiedBy', sql.UniqueIdentifier, modifiedByUserId);
      await ar.query(`
        UPDATE oe.Agents
        SET Email = @email, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
        WHERE UserId = @userId
      `);
    }

    for (const r of rows) {
      const mr = transaction.request();
      mr.input('memberId', sql.UniqueIdentifier, r.MemberId);
      mr.input('modifiedBy', sql.UniqueIdentifier, modifiedByUserId);
      await mr.query(`
        UPDATE oe.Members
        SET Status = 'Inactive',
            ModifiedDate = GETDATE(),
            ModifiedBy = @modifiedBy
        WHERE MemberId = @memberId
      `);
    }

    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }

  return {
    data: {
      membersUpdated: rows.length,
      emailChanges: plan.emailChanges,
    },
  };
}

module.exports = {
  getHouseholdRemovalPreview,
  executeHouseholdRemoval,
  shouldRenameEmail,
  isNoEmailPlaceholder,
};
