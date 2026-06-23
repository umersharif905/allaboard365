const { getPool, sql } = require('../config/database');

const DEFAULT_EMAIL = 'public-forms-system@internal.noreply';
const DEFAULT_USER_ID = 'A0000001-0000-4000-8000-000000000001';

let cachedUserId = null;

/**
 * UserId used for ShareRequest / document CreatedBy when submission is anonymous.
 */
async function getPublicFormsActorUserId() {
    if (cachedUserId) {
        return cachedUserId;
    }
    const envId = process.env.PUBLIC_FORMS_SYSTEM_USER_ID;
    if (envId && /^[0-9a-fA-F-]{36}$/.test(envId)) {
        cachedUserId = envId;
        return cachedUserId;
    }

    const pool = await getPool();
    const r = await pool.request()
        .input('email', sql.NVarChar, DEFAULT_EMAIL)
        .query('SELECT UserId FROM oe.Users WHERE Email = @email');
    if (r.recordset.length > 0) {
        cachedUserId = r.recordset[0].UserId;
        return cachedUserId;
    }

    const r2 = await pool.request()
        .input('userId', sql.UniqueIdentifier, DEFAULT_USER_ID)
        .query('SELECT UserId FROM oe.Users WHERE UserId = @userId');
    if (r2.recordset.length > 0) {
        cachedUserId = r2.recordset[0].UserId;
        return cachedUserId;
    }

    throw new Error('Public forms system user not found. Run sql-changes/allaboard365/2026-03-24-public-sharing-forms.sql or set PUBLIC_FORMS_SYSTEM_USER_ID.');
}

module.exports = {
    getPublicFormsActorUserId,
    DEFAULT_EMAIL,
    DEFAULT_USER_ID
};
