const { getPool, sql } = require('../config/database');
const MessageQueueService = require('./messageQueue.service');

const IMPROVE_EMAIL = 'improve@allaboard365.com';

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Look up member + user by email (case-insensitive). If no member row, falls back to user-only.
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function findMemberContextByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    return null;
  }

  const pool = await getPool();
  const memberResult = await pool.request()
    .input('email', sql.NVarChar, normalized)
    .query(`
      SELECT TOP 1
        m.MemberId,
        m.HouseholdMemberID,
        u.FirstName,
        u.LastName,
        u.PhoneNumber,
        u.Email,
        m.TenantId
      FROM oe.Members m
      INNER JOIN oe.Users u ON m.UserId = u.UserId
      WHERE LOWER(LTRIM(RTRIM(u.Email))) = @email
      ORDER BY m.CreatedDate DESC
    `);

  if (memberResult.recordset[0]) {
    return { ...memberResult.recordset[0], _source: 'member' };
  }

  const userResult = await pool.request()
    .input('email', sql.NVarChar, normalized)
    .query(`
      SELECT TOP 1
        u.FirstName,
        u.LastName,
        u.PhoneNumber,
        u.Email,
        u.TenantId
      FROM oe.Users u
      WHERE LOWER(LTRIM(RTRIM(u.Email))) = @email
      ORDER BY u.CreatedDate DESC
    `);

  if (userResult.recordset[0]) {
    return { ...userResult.recordset[0], HouseholdMemberID: null, _source: 'user' };
  }

  return null;
}

/**
 * Queue notification to improve@ for account deletion request.
 * @param {string} requesterEmail
 * @returns {Promise<string>} Message ID
 */
async function queueImproveNotification(requesterEmail) {
  const trimmed = String(requesterEmail || '').trim();
  const ctx = await findMemberContextByEmail(trimmed);

  const householdMemberId = ctx && (ctx.HouseholdMemberID != null && String(ctx.HouseholdMemberID).trim() !== '')
    ? String(ctx.HouseholdMemberID).trim()
    : null;
  const firstName = ctx && ctx.FirstName != null ? String(ctx.FirstName).trim() : '';
  const lastName = ctx && ctx.LastName != null ? String(ctx.LastName).trim() : '';
  const name = [firstName, lastName].filter(Boolean).join(' ') || null;
  const phone = ctx && ctx.PhoneNumber != null && String(ctx.PhoneNumber).trim() !== ''
    ? String(ctx.PhoneNumber).trim()
    : null;

  const matchLines = [];
  if (ctx) {
    const isMember = ctx._source === 'member';
    matchLines.push(`<p><strong>Account match in system:</strong> Yes (${isMember ? 'member record' : 'user record only'})</p>`);
    matchLines.push(`<p><strong>Household member ID:</strong> ${householdMemberId ? escapeHtml(householdMemberId) : '(not on file)'}</p>`);
    matchLines.push(`<p><strong>Name:</strong> ${name ? escapeHtml(name) : '(not on file)'}</p>`);
    matchLines.push(`<p><strong>Phone:</strong> ${phone ? escapeHtml(phone) : '(not on file)'}</p>`);
  } else {
    matchLines.push('<p><strong>Account match in system:</strong> No user or member record for this email.</p>');
  }

  const subject = `Account cancellation request: ${trimmed}`;
  const htmlContent = `
    <p><strong>Account cancellation request</strong></p>
    <p><strong>Email submitted:</strong> ${escapeHtml(trimmed)}</p>
    ${matchLines.join('\n')}
    <p>Follow up with the member to confirm account cancellation.</p>
  `;

  const textLines = [
    'Account cancellation request',
    `Email submitted: ${trimmed}`,
    ctx
      ? `Account match in system: Yes (${ctx._source === 'member' ? 'member record' : 'user record only'})`
      : 'Account match in system: No user or member record for this email.'
  ];
  if (ctx) {
    textLines.push(`Household member ID: ${householdMemberId || '(not on file)'}`);
    textLines.push(`Name: ${name || '(not on file)'}`);
    textLines.push(`Phone: ${phone || '(not on file)'}`);
  }
  textLines.push('Follow up with the member to confirm account cancellation.');
  const textContent = textLines.join('\n');

  return MessageQueueService.queueEmail({
    tenantId: ctx && ctx.TenantId ? ctx.TenantId : null,
    toEmail: IMPROVE_EMAIL,
    toName: 'Improve',
    subject,
    htmlContent,
    textContent,
    createdBy: null,
    recipientId: null
  });
}

module.exports = {
  findMemberContextByEmail,
  queueImproveNotification
};
