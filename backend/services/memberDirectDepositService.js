// backend/services/memberDirectDepositService.js
//
// Member Direct Deposit (reimbursement destination) records.
// One row per bank account; only one IsActive=1 per member at a time.
//
// ACH numbers are encrypted at rest with AES-256-GCM via encryptionService;
// a Last4 column lets the UI render without decrypting.
//
// Sources:
//   - 'PublicFormSubmission' — auto-extracted from a sharing form payload
//   - 'TenantAdminEntry'     — entered manually via tenant-admin UI

const { getPool, sql } = require('../config/database');
const encryptionService = require('./encryptionService');

const ACCOUNT_TYPES = new Set(['Checking', 'Savings']);

/** Map a free-text bank-account-type into the enum, or null if invalid. */
function normalizeAccountType(raw) {
    if (!raw) return null;
    const s = String(raw).trim().toLowerCase();
    if (s === 'checking' || s === 'check' || s === 'c') return 'Checking';
    if (s === 'savings' || s === 'saving' || s === 's') return 'Savings';
    return null;
}

/** Strip everything except digits. */
function digitsOnly(s) {
    return String(s || '').replace(/\D/g, '');
}

function last4(s) {
    const d = digitsOnly(s);
    return d.length >= 4 ? d.slice(-4) : d.padStart(4, '0');
}

/**
 * Validate raw ACH inputs. Throws on failure with a clear message that's
 * safe to log (no actual values).
 */
function validateAchInputs({ accountHolderName, bankName, bankAccountType, routingNumber, accountNumber }) {
    if (!accountHolderName || !String(accountHolderName).trim()) {
        throw new Error('Account holder name is required');
    }
    if (!bankName || !String(bankName).trim()) {
        throw new Error('Bank name is required');
    }
    const normType = normalizeAccountType(bankAccountType);
    if (!normType) {
        throw new Error("Bank account type must be 'Checking' or 'Savings'");
    }
    const r = digitsOnly(routingNumber);
    if (r.length !== 9) {
        throw new Error('Routing number must be 9 digits');
    }
    const a = digitsOnly(accountNumber);
    if (a.length < 4 || a.length > 17) {
        throw new Error('Account number must be 4–17 digits');
    }
    return {
        accountHolderName: String(accountHolderName).trim().slice(0, 200),
        bankName: String(bankName).trim().slice(0, 200),
        bankAccountType: normType,
        routingNumber: r,
        accountNumber: a
    };
}

/**
 * Field names used on the public sharing form template for ACH inputs.
 * Centralised here so the form-template editor and the back-end stay in sync.
 */
const PAYLOAD_FIELDS = Object.freeze({
    accountHolderName: 'dd_accountHolderName',
    bankName: 'dd_bankName',
    bankAccountType: 'dd_accountType',
    routingNumber: 'dd_routingNumber',
    accountNumber: 'dd_accountNumber'
});

/** Returns true if any of the dd_* keys are present (non-empty) on the payload. */
function payloadHasDirectDepositFields(payload) {
    if (!payload || typeof payload !== 'object') return false;
    return Object.values(PAYLOAD_FIELDS).some((k) => {
        const v = payload[k];
        return v != null && String(v).trim() !== '';
    });
}

/**
 * Return a shallow copy of payload with the dd_* keys removed. Used to
 * sanitize the payload before it's encrypted into PublicFormSubmissions, so
 * banking data only lives in oe.MemberDirectDeposits.
 *
 * @returns {{ sanitizedPayload: Record<string, unknown>, redactedKeys: string[] }}
 */
function redactDirectDepositFields(payload) {
    if (!payload || typeof payload !== 'object') {
        return { sanitizedPayload: payload, redactedKeys: [] };
    }
    const sanitized = { ...payload };
    const redacted = [];
    for (const k of Object.values(PAYLOAD_FIELDS)) {
        if (k in sanitized) {
            delete sanitized[k];
            redacted.push(k);
        }
    }
    return { sanitizedPayload: sanitized, redactedKeys: redacted };
}

/**
 * Find the household primary for a given member. Returns the primary's
 * MemberId, or the input memberId if no primary is found (defensive — the
 * caller has already established the member exists, so worst case we attach
 * to the submitter).
 *
 * Convention: oe.Members.RelationshipType = 'P' marks the household primary.
 */
async function resolveHouseholdPrimaryMemberId(pool, tenantId, memberId) {
    const r = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`
            SELECT TOP 1 p.MemberId
            FROM oe.Members m
            INNER JOIN oe.Members p
                ON p.HouseholdId = m.HouseholdId
                AND p.TenantId = m.TenantId
            WHERE m.MemberId = @memberId
              AND m.TenantId = @tenantId
              AND p.RelationshipType = 'P'
        `);
    return r.recordset[0]?.MemberId || memberId;
}

/**
 * Insert a new direct-deposit row and deactivate any prior active rows for
 * the same member, in a single transaction.
 *
 * Per design decision (always insert + rotate), we do not dedupe on bank info
 * here — every successful submission produces a fresh row. This keeps the
 * audit trail honest and avoids decrypting on the submission hot path.
 *
 * @returns {Promise<{ directDepositId: string, memberId: string, isActive: true }>}
 */
async function insertAndActivate(pool, {
    memberId,
    tenantId,
    accountHolderName,
    bankName,
    bankAccountType,
    routingNumber,
    accountNumber,
    source,
    sourceSubmissionId,
    actorUserId
}) {
    const directDepositId = require('crypto').randomUUID();
    const acctEnc = encryptionService.encrypt(accountNumber);
    const routEnc = encryptionService.encrypt(routingNumber);
    const acctLast4 = last4(accountNumber);
    const routLast4 = last4(routingNumber);

    const tx = pool.transaction();
    await tx.begin();
    try {
        // Deactivate any prior active row for this member.
        await tx.request()
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('actorUserId', sql.UniqueIdentifier, actorUserId || null)
            .query(`
                UPDATE oe.MemberDirectDeposits
                SET IsActive = 0,
                    DeactivatedDate = SYSUTCDATETIME(),
                    DeactivatedBy = @actorUserId,
                    ModifiedDate = SYSUTCDATETIME(),
                    ModifiedBy = @actorUserId
                WHERE TenantId = @tenantId
                  AND MemberId = @memberId
                  AND IsActive = 1
            `);

        await tx.request()
            .input('directDepositId', sql.UniqueIdentifier, directDepositId)
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('accountHolderName', sql.NVarChar(200), accountHolderName)
            .input('bankName', sql.NVarChar(200), bankName)
            .input('bankAccountType', sql.NVarChar(20), bankAccountType)
            .input('accountNumberEncrypted', sql.NVarChar(500), acctEnc)
            .input('routingNumberEncrypted', sql.NVarChar(500), routEnc)
            .input('accountNumberLast4', sql.Char(4), acctLast4)
            .input('routingNumberLast4', sql.Char(4), routLast4)
            .input('source', sql.NVarChar(40), source || 'PublicFormSubmission')
            .input('sourceSubmissionId', sql.UniqueIdentifier, sourceSubmissionId || null)
            .input('actorUserId', sql.UniqueIdentifier, actorUserId || null)
            .query(`
                INSERT INTO oe.MemberDirectDeposits (
                    DirectDepositId, MemberId, TenantId,
                    AccountHolderName, BankName, BankAccountType,
                    AccountNumberEncrypted, RoutingNumberEncrypted,
                    AccountNumberLast4, RoutingNumberLast4,
                    IsActive, Source, SourceSubmissionId,
                    CreatedBy
                ) VALUES (
                    @directDepositId, @memberId, @tenantId,
                    @accountHolderName, @bankName, @bankAccountType,
                    @accountNumberEncrypted, @routingNumberEncrypted,
                    @accountNumberLast4, @routingNumberLast4,
                    1, @source, @sourceSubmissionId,
                    @actorUserId
                )
            `);

        await tx.commit();
    } catch (err) {
        try { await tx.rollback(); } catch (rbErr) {
            console.warn('memberDirectDepositService: rollback after insert failure also failed', rbErr.message);
        }
        throw err;
    }

    return { directDepositId, memberId, isActive: true };
}

/**
 * Extract dd_* fields from a public form payload, validate, and persist.
 * Per design decision #2, always rolls up to the household primary's
 * MemberId.
 *
 * No-op (returns null) if the payload doesn't contain DD fields.
 *
 * @param {object} args
 * @param {string} args.memberId           — submitter's resolved member id
 * @param {string} args.tenantId
 * @param {Record<string, unknown>} args.payload
 * @param {string} [args.sourceSubmissionId]
 * @param {string} [args.actorUserId]
 */
async function upsertFromPayload({ memberId, tenantId, payload, sourceSubmissionId, actorUserId }) {
    if (!payloadHasDirectDepositFields(payload)) {
        return null;
    }
    const validated = validateAchInputs({
        accountHolderName: payload[PAYLOAD_FIELDS.accountHolderName],
        bankName: payload[PAYLOAD_FIELDS.bankName],
        bankAccountType: payload[PAYLOAD_FIELDS.bankAccountType],
        routingNumber: payload[PAYLOAD_FIELDS.routingNumber],
        accountNumber: payload[PAYLOAD_FIELDS.accountNumber]
    });

    const pool = await getPool();
    const targetMemberId = await resolveHouseholdPrimaryMemberId(pool, tenantId, memberId);

    return insertAndActivate(pool, {
        memberId: targetMemberId,
        tenantId,
        ...validated,
        source: 'PublicFormSubmission',
        sourceSubmissionId,
        actorUserId
    });
}

/**
 * Manual create — tenant-admin entry path. Validates inputs the same way as
 * the form path and rotates Active. Returns the inserted row.
 */
async function createManual({
    memberId, tenantId,
    accountHolderName, bankName, bankAccountType, routingNumber, accountNumber,
    actorUserId
}) {
    const validated = validateAchInputs({ accountHolderName, bankName, bankAccountType, routingNumber, accountNumber });
    const pool = await getPool();
    return insertAndActivate(pool, {
        memberId,
        tenantId,
        ...validated,
        source: 'TenantAdminEntry',
        sourceSubmissionId: null,
        actorUserId
    });
}

/**
 * List all direct deposits for a member. Returns last4-only fields by
 * default — no decryption happens here.
 */
async function listForMember({ memberId, tenantId, includeInactive = true }) {
    const pool = await getPool();
    const r = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT
                DirectDepositId, MemberId, TenantId,
                AccountHolderName, BankName, BankAccountType,
                AccountNumberLast4, RoutingNumberLast4,
                IsActive, Source, SourceSubmissionId,
                DeactivatedDate, DeactivatedBy,
                CreatedDate, CreatedBy, ModifiedDate, ModifiedBy
            FROM oe.MemberDirectDeposits
            WHERE TenantId = @tenantId AND MemberId = @memberId
              AND (@includeInactive = 1 OR IsActive = 1)
            ORDER BY IsActive DESC, CreatedDate DESC
        `.replace('@includeInactive', includeInactive ? '1' : '0'));
    return r.recordset;
}

async function getById({ directDepositId, tenantId }) {
    const pool = await getPool();
    const r = await pool.request()
        .input('directDepositId', sql.UniqueIdentifier, directDepositId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT *
            FROM oe.MemberDirectDeposits
            WHERE TenantId = @tenantId AND DirectDepositId = @directDepositId
        `);
    return r.recordset[0] || null;
}

/**
 * Decrypt and return full account/routing numbers. Caller is responsible for
 * gating access — this should ONLY be called from a route that has verified
 * the user is TenantAdmin/TenantAccounting/SysAdmin and writes an audit
 * log entry.
 */
function decryptRow(row) {
    if (!row) return null;
    return {
        ...row,
        AccountNumber: encryptionService.decrypt(row.AccountNumberEncrypted),
        RoutingNumber: encryptionService.decrypt(row.RoutingNumberEncrypted)
    };
}

/**
 * Activate a row (and deactivate any other active row for the same member),
 * in one transaction. Used by the "Make Active" action on an inactive
 * historical row.
 */
async function setActive({ directDepositId, tenantId, actorUserId }) {
    const pool = await getPool();
    const target = await getById({ directDepositId, tenantId });
    if (!target) {
        const err = new Error('Direct deposit record not found');
        err.statusCode = 404;
        throw err;
    }
    if (target.IsActive) return target;

    const tx = pool.transaction();
    await tx.begin();
    try {
        await tx.request()
            .input('memberId', sql.UniqueIdentifier, target.MemberId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('actorUserId', sql.UniqueIdentifier, actorUserId || null)
            .query(`
                UPDATE oe.MemberDirectDeposits
                SET IsActive = 0,
                    DeactivatedDate = SYSUTCDATETIME(),
                    DeactivatedBy = @actorUserId,
                    ModifiedDate = SYSUTCDATETIME(),
                    ModifiedBy = @actorUserId
                WHERE TenantId = @tenantId
                  AND MemberId = @memberId
                  AND IsActive = 1
            `);
        await tx.request()
            .input('directDepositId', sql.UniqueIdentifier, directDepositId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('actorUserId', sql.UniqueIdentifier, actorUserId || null)
            .query(`
                UPDATE oe.MemberDirectDeposits
                SET IsActive = 1,
                    DeactivatedDate = NULL,
                    DeactivatedBy = NULL,
                    ModifiedDate = SYSUTCDATETIME(),
                    ModifiedBy = @actorUserId
                WHERE TenantId = @tenantId
                  AND DirectDepositId = @directDepositId
            `);
        await tx.commit();
    } catch (err) {
        try { await tx.rollback(); } catch (rbErr) {
            console.warn('memberDirectDepositService.setActive: rollback failed', rbErr.message);
        }
        throw err;
    }
    return getById({ directDepositId, tenantId });
}

/** Mark a row inactive without activating any other. */
async function deactivate({ directDepositId, tenantId, actorUserId }) {
    const pool = await getPool();
    const target = await getById({ directDepositId, tenantId });
    if (!target) {
        const err = new Error('Direct deposit record not found');
        err.statusCode = 404;
        throw err;
    }
    if (!target.IsActive) return target;
    await pool.request()
        .input('directDepositId', sql.UniqueIdentifier, directDepositId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('actorUserId', sql.UniqueIdentifier, actorUserId || null)
        .query(`
            UPDATE oe.MemberDirectDeposits
            SET IsActive = 0,
                DeactivatedDate = SYSUTCDATETIME(),
                DeactivatedBy = @actorUserId,
                ModifiedDate = SYSUTCDATETIME(),
                ModifiedBy = @actorUserId
            WHERE TenantId = @tenantId AND DirectDepositId = @directDepositId
        `);
    return getById({ directDepositId, tenantId });
}

module.exports = {
    PAYLOAD_FIELDS,
    payloadHasDirectDepositFields,
    redactDirectDepositFields,
    upsertFromPayload,
    createManual,
    listForMember,
    getById,
    decryptRow,
    setActive,
    deactivate,
    // exposed for tests
    _internal: { validateAchInputs, normalizeAccountType, last4, resolveHouseholdPrimaryMemberId }
};
