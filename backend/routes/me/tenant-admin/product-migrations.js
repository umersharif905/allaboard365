/**
 * Product pricing migration (tenant admin) — candidates preview + bulk apply via plan modification engine.
 * Mounted at /api/me/tenant-admin/product-migrations
 */
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const requireTenantAccess = require('../../../middleware/requireTenantAccess');
const {
  findCandidates,
  applyMigrations,
  listTenantsOfferingProduct,
  tenantCanSellProduct,
  MAX_MIGRATION_MEMBER_IDS
} = require('../../../services/product-migrations/productMigrationService');

function parseTenantIdsParam(q) {
  if (q == null || q === '') return null;
  if (Array.isArray(q)) return q.map((s) => String(s).trim()).filter(Boolean);
  return String(q)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function migrationAudit(payload) {
  try {
    console.log(`[product-migration-audit] ${JSON.stringify(payload)}`);
  } catch (_) {}
}

/**
 * @returns {Promise<{ allowedTenantIds: string[], offeringTenants: { tenantId: string, name: string }[], migrationRole: string } | { error: string }>}
 */
async function resolveAllowedTenantIds(pool, productId, reqTenantId, user, requestedTenantIds) {
  const isSysAdmin = getUserRoles(user).includes('SysAdmin');
  const prodRes = await pool
    .request()
    .input('productId', sql.UniqueIdentifier, productId)
    .query(`SELECT ProductId, ProductOwnerId FROM oe.Products WHERE ProductId = @productId`);
  if (!prodRes.recordset.length) return { error: 'not_found' };

  const productRow = prodRes.recordset[0];
  const ownerLc = String(productRow.ProductOwnerId || '').toLowerCase();
  const ctxLc = String(reqTenantId || '').toLowerCase();
  const isOwner = ownerLc === ctxLc;

  const offering = await listTenantsOfferingProduct(pool, productId);
  const offeringLc = new Map(offering.map((t) => [String(t.tenantId).toLowerCase(), t.tenantId]));

  if (isSysAdmin) {
    const reqList =
      requestedTenantIds && requestedTenantIds.length > 0
        ? requestedTenantIds
        : offering.map((t) => t.tenantId);
    const allowed = [];
    for (const r of reqList) {
      const k = String(r).toLowerCase();
      if (offeringLc.has(k)) allowed.push(offeringLc.get(k));
    }
    if (!allowed.length) return { error: 'bad_tenants' };
    return { allowedTenantIds: allowed, offeringTenants: offering, migrationRole: 'sysadmin' };
  }

  if (isOwner) {
    const reqList =
      requestedTenantIds && requestedTenantIds.length > 0
        ? requestedTenantIds
        : offering.map((t) => t.tenantId);
    const allowed = [];
    for (const r of reqList) {
      const k = String(r).toLowerCase();
      if (offeringLc.has(k)) allowed.push(offeringLc.get(k));
    }
    if (!allowed.length) return { error: 'bad_tenants' };
    return { allowedTenantIds: allowed, offeringTenants: offering, migrationRole: 'owner' };
  }

  const canSell = await tenantCanSellProduct(pool, productId, reqTenantId);
  if (!canSell) return { error: 'forbidden' };

  if (requestedTenantIds && requestedTenantIds.length > 0) {
    if (
      requestedTenantIds.length !== 1 ||
      String(requestedTenantIds[0]).toLowerCase() !== ctxLc
    ) {
      return { error: 'carrier_scope' };
    }
  }

  if (!offeringLc.has(ctxLc)) return { error: 'forbidden' };

  return { allowedTenantIds: [reqTenantId], offeringTenants: offering, migrationRole: 'carrier' };
}

/** Tenants offering this product + whether caller may pick multiple (product owner / SysAdmin). */
router.get(
  '/:productId/tenants',
  authorize(['TenantAdmin', 'SysAdmin']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const { productId } = req.params;
      const tenantId = req.tenantId || req.user?.TenantId;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }
      const pool = await getPool();
      const resolved = await resolveAllowedTenantIds(pool, productId, tenantId, req.user, null);
      if (resolved.error === 'not_found') {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }
      if (resolved.error === 'forbidden' || resolved.error === 'bad_tenants') {
        return res.status(403).json({ success: false, message: 'Product not accessible for migration' });
      }
      const isMulti =
        resolved.migrationRole === 'owner' || resolved.migrationRole === 'sysadmin';
      const ctxLc = String(tenantId || '').toLowerCase();
      const tenantsOut =
        resolved.migrationRole === 'carrier'
          ? (resolved.offeringTenants || []).filter(
              (t) => String(t.tenantId || '').toLowerCase() === ctxLc
            )
          : resolved.offeringTenants || [];
      return res.json({
        success: true,
        data: {
          tenants: tenantsOut,
          canSelectMultipleTenants: isMulti,
          defaultTenantIds: tenantsOut.map((t) => t.tenantId)
        }
      });
    } catch (e) {
      console.error('[product-migrations] GET tenants', e);
      return res.status(500).json({
        success: false,
        message: e?.message || 'Failed to load tenants for product'
      });
    }
  }
);

router.get(
  '/:productId/candidates',
  authorize(['TenantAdmin', 'SysAdmin']),
  requireTenantAccess,
  async (req, res) => {
    // Long-running per-member preview; no socket timeout (client allows up to ~45m).
    req.setTimeout(0);
    res.setTimeout(0);
    const started = Date.now();
    try {
      const { productId } = req.params;
      const { asOfDate } = req.query;
      const tenantId = req.tenantId || req.user?.TenantId;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }
      const requestedTenants = parseTenantIdsParam(req.query.tenantIds);
      const pool = await getPool();
      const resolved = await resolveAllowedTenantIds(pool, productId, tenantId, req.user, requestedTenants);
      if (resolved.error === 'not_found') {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }
      if (
        resolved.error === 'forbidden' ||
        resolved.error === 'bad_tenants' ||
        resolved.error === 'carrier_scope'
      ) {
        return res.status(403).json({
          success: false,
          message:
            resolved.error === 'carrier_scope'
              ? 'Carriers may only migrate within their active tenant'
              : 'Product not found or not accessible for migration'
        });
      }
      const data = await findCandidates({
        tenantIds: resolved.allowedTenantIds,
        productId,
        asOfDate: typeof asOfDate === 'string' ? asOfDate : undefined
      });
      migrationAudit({
        action: 'candidates',
        productId,
        actingTenantId: tenantId,
        allowedTenantIds: resolved.allowedTenantIds,
        migrationRole: resolved.migrationRole,
        candidateCount: data.candidates?.length ?? 0,
        actingUserId: req.user?.UserId || req.user?.userId,
        durationMs: Date.now() - started
      });
      return res.json({ success: true, data });
    } catch (e) {
      console.error('[product-migrations] GET candidates', e);
      return res.status(500).json({
        success: false,
        message: e?.message || 'Failed to load migration candidates'
      });
    }
  }
);

router.post(
  '/:productId/apply',
  authorize(['TenantAdmin', 'SysAdmin']),
  requireTenantAccess,
  async (req, res) => {
    // Long-running per-member apply; no socket timeout (client allows up to ~45m).
    req.setTimeout(0);
    res.setTimeout(0);
    const started = Date.now();
    try {
      const { productId } = req.params;
      const { memberIds, settings, tenantIds: bodyTenantIdsList } = req.body || {};
      const tenantId = req.tenantId || req.user?.TenantId;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }
      if (!Array.isArray(memberIds)) {
        return res.status(400).json({ success: false, message: 'memberIds array is required' });
      }
      if (memberIds.length === 0) {
        return res.status(400).json({ success: false, message: 'memberIds must not be empty' });
      }
      if (memberIds.length > MAX_MIGRATION_MEMBER_IDS) {
        return res.status(400).json({
          success: false,
          message: `memberIds exceeds maximum (${MAX_MIGRATION_MEMBER_IDS})`
        });
      }
      const actingUserId = req.user?.UserId || req.user?.userId;
      if (!actingUserId) {
        return res.status(401).json({ success: false, message: 'User id missing' });
      }
      const requestedTenants = Array.isArray(bodyTenantIdsList)
        ? bodyTenantIdsList.map((s) => String(s).trim()).filter(Boolean)
        : null;
      const pool = await getPool();
      const resolved = await resolveAllowedTenantIds(pool, productId, tenantId, req.user, requestedTenants);
      if (resolved.error === 'not_found') {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }
      if (
        resolved.error === 'forbidden' ||
        resolved.error === 'bad_tenants' ||
        resolved.error === 'carrier_scope'
      ) {
        return res.status(403).json({
          success: false,
          message:
            resolved.error === 'carrier_scope'
              ? 'Carriers may only migrate within their active tenant'
              : 'Product not found or not accessible for migration'
        });
      }
      const data = await applyMigrations({
        tenantId,
        productId,
        memberIds,
        tenantIds: resolved.allowedTenantIds,
        settings: settings && typeof settings === 'object' ? settings : {},
        actingUserId
      });
      migrationAudit({
        action: 'apply',
        productId,
        actingTenantId: tenantId,
        allowedTenantIds: resolved.allowedTenantIds,
        migrationRole: resolved.migrationRole,
        memberIdsCount: memberIds.length,
        summary: data.summary,
        actingUserId,
        durationMs: Date.now() - started
      });
      return res.json({ success: true, data });
    } catch (e) {
      console.error('[product-migrations] POST apply', e);
      return res.status(500).json({
        success: false,
        message: e?.message || 'Failed to apply migrations'
      });
    }
  }
);

module.exports = router;
