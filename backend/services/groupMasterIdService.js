/**
 * AllAboard Master Group ID Service
 *
 * Manages AllAboardMasterGroupId on oe.Groups and AllAboardGroupId on
 * oe.GroupLocations.
 *
 * Master group ID format: exactly 6 digits (e.g. 482913), unique per tenant.
 * New IDs are assigned randomly (not sequential) to reduce guessability.
 * Location ID format: master ID, or master + "-01", "-02" … for multi-location.
 *
 * Location assignment rules:
 *  - 1 location  → AllAboardGroupId = AllAboardMasterGroupId (unless IsGroupIdOverride=1)
 *  - 2+ locations → suffix -01, -02 … ordered IsPrimary DESC, CreatedDate ASC
 *                   (locations with IsGroupIdOverride=1 are left untouched)
 */

'use strict';

const crypto = require('crypto');
const { getPool, sql } = require('../config/database');
const logger = require('../config/logger');

const SLUG_REGEX = /^[A-Za-z0-9\-]{1,100}$/;
const MASTER_GROUP_ID_REGEX = /^\d{6}$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the string conforms to the allowed location/suffix pattern.
 */
function isValidGroupIdSlug(value) {
    if (typeof value !== 'string') return false;
    return SLUG_REGEX.test(value);
}

/** Master group IDs are exactly six digits (000001–999999). */
function isValidMasterGroupId(value) {
    if (typeof value !== 'string') return false;
    return MASTER_GROUP_ID_REGEX.test(value);
}

function formatMasterGroupId(num) {
    const n = Number(num);
    if (!Number.isInteger(n) || n < 1 || n > 999999) {
        throw new Error(`Master group ID out of range: ${num}`);
    }
    return String(n).padStart(6, '0');
}

/**
 * @deprecated Name slugs are no longer used for master IDs; kept for legacy callers/tests.
 */
function slugifyGroupName(groupName) {
    return (groupName || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || 'GROUP';
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

async function isMasterGroupIdUniqueInTenant(pool, tenantId, identifier, excludeGroupId) {
    const req = pool.request()
        .input('TenantId', sql.UniqueIdentifier, tenantId)
        .input('Identifier', sql.NVarChar(100), identifier);

    let query = `
        SELECT COUNT(*) AS cnt
        FROM oe.Groups
        WHERE TenantId = @TenantId
          AND AllAboardMasterGroupId = @Identifier
    `;
    if (excludeGroupId) {
        req.input('ExcludeGroupId', sql.UniqueIdentifier, excludeGroupId);
        query += ' AND GroupId <> @ExcludeGroupId';
    }

    const result = await req.query(query);
    return result.recordset[0].cnt === 0;
}

async function isLocationGroupIdUniqueInGroup(pool, groupId, identifier, excludeLocationId) {
    const req = pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId)
        .input('Identifier', sql.NVarChar(100), identifier);

    let query = `
        SELECT COUNT(*) AS cnt
        FROM oe.GroupLocations
        WHERE GroupId = @GroupId
          AND AllAboardGroupId = @Identifier
    `;
    if (excludeLocationId) {
        req.input('ExcludeLocationId', sql.UniqueIdentifier, excludeLocationId);
        query += ' AND LocationId <> @ExcludeLocationId';
    }

    const result = await req.query(query);
    return result.recordset[0].cnt === 0;
}

/**
 * Random unused 6-digit master group ID for a tenant (retries on collision).
 */
async function assignNextMasterGroupIdForTenant(pool, tenantId) {
    const maxAttempts = 50;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidate = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        const unique = await isMasterGroupIdUniqueInTenant(pool, tenantId, candidate, null);
        if (unique) {
            return candidate;
        }
    }
    throw new Error('No unused 6-digit master group IDs remain for this tenant.');
}

async function recomputeLocationGroupIds(groupId) {
    const pool = await getPool();

    const groupResult = await pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId)
        .query(`
            SELECT AllAboardMasterGroupId
            FROM oe.Groups
            WHERE GroupId = @GroupId
        `);

    if (!groupResult.recordset.length) {
        logger.warn(`[groupMasterIdService] recompute: group ${groupId} not found`);
        return { updated: 0, masterGroupId: null };
    }

    const masterGroupId = groupResult.recordset[0].AllAboardMasterGroupId;
    if (!masterGroupId) {
        return { updated: 0, masterGroupId: null };
    }

    const locResult = await pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId)
        .query(`
            SELECT LocationId, IsPrimary, IsGroupIdOverride, CreatedDate
            FROM oe.GroupLocations
            WHERE GroupId = @GroupId AND Status = 'Active'
            ORDER BY IsPrimary DESC, CreatedDate ASC
        `);

    const locations = locResult.recordset;
    if (!locations.length) {
        return { updated: 0, masterGroupId };
    }

    let updated = 0;
    const isSingle = locations.length === 1;
    let locationIndex = 1;

    for (const loc of locations) {
        if (loc.IsGroupIdOverride) {
            if (!isSingle) locationIndex++;
            continue;
        }

        const assignedId = isSingle
            ? masterGroupId
            : `${masterGroupId}-${String(locationIndex).padStart(2, '0')}`;

        await pool.request()
            .input('LocationId', sql.UniqueIdentifier, loc.LocationId)
            .input('AllAboardGroupId', sql.NVarChar(100), assignedId)
            .query(`
                UPDATE oe.GroupLocations
                SET AllAboardGroupId = @AllAboardGroupId,
                    ModifiedDate = GETDATE()
                WHERE LocationId = @LocationId
            `);

        updated++;
        locationIndex++;
    }

    logger.info(`[groupMasterIdService] recompute: group ${groupId}, masterGroupId=${masterGroupId}, updated ${updated} locations`);
    return { updated, masterGroupId };
}

async function validateMasterGroupId(pool, tenantId, value, excludeGroupId = null) {
    const errors = [];

    if (!isValidMasterGroupId(value)) {
        errors.push('Invalid format. Must be exactly 6 digits (e.g. 000042).');
    }

    if (!errors.length) {
        const unique = await isMasterGroupIdUniqueInTenant(pool, tenantId, value, excludeGroupId);
        if (!unique) {
            errors.push(`"${value}" is already used by another group in this tenant.`);
        }
    }

    return { valid: errors.length === 0, errors };
}

async function validateLocationGroupId(pool, groupId, value, excludeLocationId = null) {
    const errors = [];

    if (!isValidGroupIdSlug(value)) {
        errors.push('Invalid format. Must be 1–100 characters using A-Z, a-z, 0-9, or hyphens.');
    }

    if (!errors.length) {
        const unique = await isLocationGroupIdUniqueInGroup(pool, groupId, value, excludeLocationId);
        if (!unique) {
            errors.push(`"${value}" is already used by another location in this group.`);
        }
    }

    return { valid: errors.length === 0, errors };
}

async function resolveMasterGroupIdForCreate(pool, tenantId, _groupName, providedValue = null) {
    if (providedValue != null && String(providedValue).trim() !== '') {
        const value = String(providedValue).trim();
        if (!isValidMasterGroupId(value)) {
            return {
                ok: false,
                status: 400,
                message: 'AllAboardMasterGroupId: Invalid format. Must be exactly 6 digits (e.g. 000042).'
            };
        }
        const { valid, errors } = await validateMasterGroupId(pool, tenantId, value, null);
        if (!valid) {
            return { ok: false, status: 409, message: errors.join(' ') };
        }
        return { ok: true, value };
    }

    try {
        const value = await assignNextMasterGroupIdForTenant(pool, tenantId);
        return { ok: true, value };
    } catch (err) {
        return { ok: false, status: 409, message: err.message || 'Failed to assign master group ID.' };
    }
}

async function suggestMasterGroupId(pool, groupId) {
    const groupResult = await pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId)
        .query(`SELECT TenantId FROM oe.Groups WHERE GroupId = @GroupId`);

    if (!groupResult.recordset.length) {
        return { suggestion: '000001', available: false };
    }

    const { TenantId: tenantId } = groupResult.recordset[0];
    try {
        const suggestion = await assignNextMasterGroupIdForTenant(pool, tenantId);
        return { suggestion, available: true };
    } catch {
        return { suggestion: '000001', available: false };
    }
}

module.exports = {
    isValidGroupIdSlug,
    isValidMasterGroupId,
    formatMasterGroupId,
    slugifyGroupName,
    assignNextMasterGroupIdForTenant,
    recomputeLocationGroupIds,
    resolveMasterGroupIdForCreate,
    validateMasterGroupId,
    validateLocationGroupId,
    suggestMasterGroupId,
    isMasterGroupIdUniqueInTenant,
    isLocationGroupIdUniqueInGroup,
};
