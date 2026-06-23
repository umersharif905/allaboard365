const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const {
  authenticate,
  authorize,
  getUserRoles,
  requireActiveRoleTenantAdminOrSysAdmin,
  requireActiveRoleTenantAdmin
} = require('../../../middleware/auth');
const { loadTrainingSeedDataFromFrontendMock } = require('../../../utils/trainingSeedData');

const ORG_SCOPE = 'Organization';

async function getLibraryRow(pool) {
  const request = pool.request();
  request.input('Scope', sql.NVarChar(50), ORG_SCOPE);
  const result = await request.query(`
    SELECT TOP 1
      TrainingLibraryId,
      Scope,
      PackagesJson,
      ModulesJson,
      Version,
      CreatedDate,
      ModifiedDate
    FROM oe.TrainingLibrary
    WHERE Scope = @Scope
  `);
  return result.recordset[0] || null;
}

/**
 * Removes a module id from every package's moduleAssignments and reorders `order`.
 * @returns {{ nextPackages: any[], removedFromPackages: Array<{ id: string, title: string }> }}
 */
function stripModuleFromAllPackages(packagesRaw, moduleId) {
  const targetId = String(moduleId);
  const removedFromPackages = [];
  const nextPackages = Array.isArray(packagesRaw)
    ? packagesRaw.map(pkg => {
        if (!pkg || !Array.isArray(pkg.moduleAssignments)) {
          return pkg;
        }
        const hadAssignment = pkg.moduleAssignments.some(
          a => a && String(a.moduleId) === targetId
        );
        if (!hadAssignment) {
          return pkg;
        }
        removedFromPackages.push({
          id: String(pkg.id || ''),
          title: pkg.title || String(pkg.id || '')
        });
        const filtered = pkg.moduleAssignments.filter(
          a => a && String(a.moduleId) !== targetId
        );
        const reordered = [...filtered]
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .map((assignment, index) => ({
            ...assignment,
            order: index + 1
          }));
        return { ...pkg, moduleAssignments: reordered };
      })
    : [];
  return { nextPackages, removedFromPackages };
}

function parseAdditionalTenants(raw) {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter(Boolean);
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

/**
 * Tenants the caller may assign packages to. Uses active-tenant context via parent
 * router's requireTenantAccess; SysAdmin can assign across all active tenants (same idea as available-tenants).
 */
async function getAccessibleTenantRows(pool, req) {
  const userId = req.user?.UserId;
  if (!userId) {
    return [];
  }

  const roles = getUserRoles(req.user);
  if (roles.includes('SysAdmin')) {
    const tenantResult = await pool.request().query(`
      SELECT TenantId, Name, Status
      FROM oe.Tenants
      WHERE Status = 'Active'
      ORDER BY Name ASC
    `);
    return tenantResult.recordset || [];
  }

  const userRequest = pool.request();
  userRequest.input('UserId', sql.UniqueIdentifier, userId);
  const userResult = await userRequest.query(`
    SELECT TenantId, AdditionalTenants
    FROM oe.Users
    WHERE UserId = @UserId
  `);

  if (userResult.recordset.length === 0) {
    return [];
  }

  const userRow = userResult.recordset[0];
  const tenantIds = [userRow.TenantId, ...parseAdditionalTenants(userRow.AdditionalTenants)]
    .filter(Boolean)
    .filter(id => id !== '00000000-0000-0000-0000-000000000000');

  const uniqueTenantIds = [...new Set(tenantIds)];
  if (uniqueTenantIds.length === 0) {
    return [];
  }

  const tenantRequest = pool.request();
  const inClause = uniqueTenantIds.map((id, index) => {
    const key = `TenantId${index}`;
    tenantRequest.input(key, sql.UniqueIdentifier, id);
    return `@${key}`;
  }).join(', ');

  const tenantResult = await tenantRequest.query(`
    SELECT TenantId, Name, Status
    FROM oe.Tenants
    WHERE TenantId IN (${inClause})
  `);

  return tenantResult.recordset || [];
}

async function triggerTenantTrainingSync(pool, tenantIds, packageId, actorUserId, reason) {
  // Placeholder hook point until agent-level assignment/progress tables are implemented.
  // Keeping this centralized ensures route behavior is stable once sync internals are added.
  console.log('[TrainingSync] Trigger requested', {
    tenantIds,
    packageId,
    actorUserId,
    reason
  });
}

/** Package IDs with an active assignment to this tenant (training visible for this org). */
async function getPackageIdsAssignedToTenant(pool, tenantId) {
  const r = pool.request();
  r.input('TenantId', sql.UniqueIdentifier, tenantId);
  const result = await r.query(`
    SELECT DISTINCT PackageId
    FROM oe.TenantTrainingPackageAssignments
    WHERE TenantId = @TenantId AND IsActive = 1
  `);
  return new Set((result.recordset || []).map((row) => String(row.PackageId)));
}

function collectModuleIdsFromPackages(packages) {
  const ids = new Set();
  for (const pkg of packages) {
    const assignments = Array.isArray(pkg?.moduleAssignments) ? pkg.moduleAssignments : [];
    for (const a of assignments) {
      if (a && a.moduleId) {
        ids.add(String(a.moduleId));
      }
    }
  }
  return ids;
}

/**
 * Only packages assigned to this tenant + modules those packages reference.
 * Prevents another tenant's catalog from appearing when using tenant switch / TenantAdmin.
 */
function filterLibraryForTenantScope(packages, moduleLibrary, assignedPackageIds) {
  const filteredPackages = (Array.isArray(packages) ? packages : []).filter(
    (p) => p && p.id && assignedPackageIds.has(String(p.id))
  );
  const neededModuleIds = collectModuleIdsFromPackages(filteredPackages);
  const filteredModules = (Array.isArray(moduleLibrary) ? moduleLibrary : []).filter(
    (m) => m && m.id && neededModuleIds.has(String(m.id))
  );
  return { packages: filteredPackages, moduleLibrary: filteredModules };
}

function mergePackagesById(existingList, incomingList) {
  const byId = new Map((Array.isArray(existingList) ? existingList : []).map((p) => [String(p.id), p]));
  for (const pkg of Array.isArray(incomingList) ? incomingList : []) {
    if (pkg && pkg.id) {
      byId.set(String(pkg.id), pkg);
    }
  }
  return Array.from(byId.values());
}

function mergeModulesById(existingList, incomingList) {
  const byId = new Map((Array.isArray(existingList) ? existingList : []).map((m) => [String(m.id), m]));
  for (const mod of Array.isArray(incomingList) ? incomingList : []) {
    if (mod && mod.id) {
      byId.set(String(mod.id), mod);
    }
  }
  return Array.from(byId.values());
}

/**
 * Ensure this tenant has an active assignment for each package they save (new or edited).
 */
async function ensureTenantAssignmentsForPackages(pool, tenantId, packageIds, actorUserId) {
  if (!tenantId || !packageIds.length) return;
  const uid = actorUserId || null;
  for (const packageId of packageIds) {
    if (!packageId) continue;
    const mergeReq = pool.request();
    mergeReq.input('TenantTrainingPackageAssignmentId', sql.UniqueIdentifier, require('crypto').randomUUID());
    mergeReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    mergeReq.input('PackageId', sql.NVarChar(100), String(packageId));
    mergeReq.input('IsActive', sql.Bit, true);
    mergeReq.input('ActorUserId', sql.UniqueIdentifier, uid);
    await mergeReq.query(`
      MERGE oe.TenantTrainingPackageAssignments AS target
      USING (SELECT @TenantId AS TenantId, @PackageId AS PackageId) AS source
      ON target.TenantId = source.TenantId AND target.PackageId = source.PackageId
      WHEN MATCHED THEN
        UPDATE SET
          IsActive = @IsActive,
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @ActorUserId
      WHEN NOT MATCHED THEN
        INSERT (
          TenantTrainingPackageAssignmentId, TenantId, PackageId, IsActive, EffectiveDate,
          CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
        )
        VALUES (
          @TenantTrainingPackageAssignmentId, @TenantId, @PackageId, @IsActive, NULL,
          GETUTCDATE(), GETUTCDATE(), @ActorUserId, @ActorUserId
        );
    `);
  }
}

/**
 * GET /api/me/tenant-admin/training-library
 * Returns organization-scoped training module/package library.
 * Auto-seeds from current frontend mock data the first time.
 */
router.get('/', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireActiveRoleTenantAdminOrSysAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    let row = await getLibraryRow(pool);
    let seeded = false;

    if (!row) {
      const seed = loadTrainingSeedDataFromFrontendMock();

      const insertRequest = pool.request();
      insertRequest.input('TrainingLibraryId', sql.UniqueIdentifier, require('crypto').randomUUID());
      insertRequest.input('Scope', sql.NVarChar(50), ORG_SCOPE);
      insertRequest.input('PackagesJson', sql.NVarChar(sql.MAX), JSON.stringify(seed.packages));
      insertRequest.input('ModulesJson', sql.NVarChar(sql.MAX), JSON.stringify(seed.moduleLibrary));
      insertRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId || null);
      insertRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId || null);
      await insertRequest.query(`
        INSERT INTO oe.TrainingLibrary (
          TrainingLibraryId, Scope, PackagesJson, ModulesJson, Version,
          CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
        )
        VALUES (
          @TrainingLibraryId, @Scope, @PackagesJson, @ModulesJson, 1,
          GETUTCDATE(), GETUTCDATE(), @CreatedBy, @ModifiedBy
        )
      `);

      row = await getLibraryRow(pool);
      seeded = true;
    }

    let packages = row?.PackagesJson ? JSON.parse(row.PackagesJson) : [];
    let moduleLibrary = row?.ModulesJson ? JSON.parse(row.ModulesJson) : [];
    const tenantId = req.tenantId;
    const roles = getUserRoles(req.user);
    const fullLibrary =
      roles.includes('SysAdmin') &&
      (req.query.fullLibrary === 'true' || req.query.fullLibrary === '1');

    const assignedPackageIds = tenantId
      ? await getPackageIdsAssignedToTenant(pool, tenantId)
      : new Set();

    if (!fullLibrary && tenantId) {
      const filtered = filterLibraryForTenantScope(packages, moduleLibrary, assignedPackageIds);
      packages = filtered.packages;
      moduleLibrary = filtered.moduleLibrary;
    }

    const assignmentCountsResult = await pool.request().query(`
      SELECT PackageId, COUNT(1) AS AssignedTenantCount
      FROM oe.TenantTrainingPackageAssignments
      WHERE IsActive = 1
      GROUP BY PackageId
    `);
    const packageAssignmentCounts = {};
    (assignmentCountsResult.recordset || []).forEach((record) => {
      const pid = String(record.PackageId);
      if (!fullLibrary && tenantId && !assignedPackageIds.has(pid)) {
        return;
      }
      packageAssignmentCounts[pid] = Number(record.AssignedTenantCount || 0);
    });

    return res.json({
      success: true,
      data: {
        scope: ORG_SCOPE,
        version: row?.Version || 1,
        packages: Array.isArray(packages) ? packages : [],
        moduleLibrary: Array.isArray(moduleLibrary) ? moduleLibrary : [],
        packageAssignmentCounts,
        seeded,
        libraryScope: fullLibrary ? 'organization' : 'tenant'
      }
    });
  } catch (error) {
    console.error('Error loading training library:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load training library'
    });
  }
});

/**
 * GET /api/me/tenant-admin/training-library/packages/:packageId/tenant-assignments
 * Returns active tenant assignments for a package and accessible tenant list.
 */
router.get('/packages/:packageId/tenant-assignments', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireActiveRoleTenantAdminOrSysAdmin, async (req, res) => {
  try {
    const { packageId } = req.params;
    const pool = await getPool();
    const accessibleTenants = await getAccessibleTenantRows(pool, req);
    const accessibleTenantIdSet = new Set(accessibleTenants.map(t => String(t.TenantId)));

    const assignmentsRequest = pool.request();
    assignmentsRequest.input('PackageId', sql.NVarChar(100), packageId);
    const assignmentsResult = await assignmentsRequest.query(`
      SELECT TenantTrainingPackageAssignmentId, TenantId, PackageId, IsActive, EffectiveDate, ModifiedDate
      FROM oe.TenantTrainingPackageAssignments
      WHERE PackageId = @PackageId
        AND IsActive = 1
    `);

    const assignments = (assignmentsResult.recordset || []).filter(record =>
      accessibleTenantIdSet.has(String(record.TenantId))
    );

    return res.json({
      success: true,
      data: {
        packageId,
        assignedTenantIds: assignments.map(record => String(record.TenantId)),
        assignments,
        tenants: accessibleTenants
      }
    });
  } catch (error) {
    console.error('Error loading package tenant assignments:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load package tenant assignments'
    });
  }
});

/**
 * PUT /api/me/tenant-admin/training-library/packages/:packageId/tenant-assignments
 * Replaces package tenant assignments for accessible tenants.
 */
router.put('/packages/:packageId/tenant-assignments', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireActiveRoleTenantAdminOrSysAdmin, async (req, res) => {
  try {
    const { packageId } = req.params;
    const { tenantIds, effectiveDate } = req.body || {};

    if (!Array.isArray(tenantIds)) {
      return res.status(400).json({
        success: false,
        message: 'tenantIds must be an array'
      });
    }

    const pool = await getPool();
    const accessibleTenants = await getAccessibleTenantRows(pool, req);
    const accessibleTenantIdSet = new Set(accessibleTenants.map(t => String(t.TenantId)));
    const requestedTenantIds = [...new Set(tenantIds.map(id => String(id)))];
    const invalidTenantIds = requestedTenantIds.filter(id => !accessibleTenantIdSet.has(id));

    if (invalidTenantIds.length > 0) {
      return res.status(403).json({
        success: false,
        message: 'One or more tenants are not accessible to this user',
        invalidTenantIds
      });
    }

    const existingRequest = pool.request();
    existingRequest.input('PackageId', sql.NVarChar(100), packageId);
    const existingResult = await existingRequest.query(`
      SELECT TenantId, IsActive
      FROM oe.TenantTrainingPackageAssignments
      WHERE PackageId = @PackageId
    `);

    const existingActiveTenantIds = new Set(
      (existingResult.recordset || [])
        .filter(record => record.IsActive === true || record.IsActive === 1)
        .map(record => String(record.TenantId))
        .filter(id => accessibleTenantIdSet.has(id))
    );
    const requestedTenantIdSet = new Set(requestedTenantIds);

    const toActivate = requestedTenantIds.filter(id => !existingActiveTenantIds.has(id));
    const toDeactivate = [...existingActiveTenantIds].filter(id => !requestedTenantIdSet.has(id));

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      for (const tenantId of requestedTenantIds) {
        const upsertRequest = transaction.request();
        upsertRequest.input('TenantTrainingPackageAssignmentId', sql.UniqueIdentifier, require('crypto').randomUUID());
        upsertRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
        upsertRequest.input('PackageId', sql.NVarChar(100), packageId);
        upsertRequest.input('IsActive', sql.Bit, true);
        upsertRequest.input('EffectiveDate', sql.Date, effectiveDate || null);
        upsertRequest.input('ActorUserId', sql.UniqueIdentifier, req.user.UserId || null);
        await upsertRequest.query(`
          MERGE oe.TenantTrainingPackageAssignments AS target
          USING (SELECT @TenantId AS TenantId, @PackageId AS PackageId) AS source
          ON target.TenantId = source.TenantId AND target.PackageId = source.PackageId
          WHEN MATCHED THEN
            UPDATE SET
              IsActive = @IsActive,
              EffectiveDate = CASE WHEN @EffectiveDate IS NULL THEN target.EffectiveDate ELSE @EffectiveDate END,
              ModifiedDate = GETUTCDATE(),
              ModifiedBy = @ActorUserId
          WHEN NOT MATCHED THEN
            INSERT (
              TenantTrainingPackageAssignmentId, TenantId, PackageId, IsActive, EffectiveDate,
              CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
            )
            VALUES (
              @TenantTrainingPackageAssignmentId, @TenantId, @PackageId, @IsActive, @EffectiveDate,
              GETUTCDATE(), GETUTCDATE(), @ActorUserId, @ActorUserId
            );
        `);
      }

      for (const tenantId of toDeactivate) {
        const deactivateRequest = transaction.request();
        deactivateRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
        deactivateRequest.input('PackageId', sql.NVarChar(100), packageId);
        deactivateRequest.input('ActorUserId', sql.UniqueIdentifier, req.user.UserId || null);
        await deactivateRequest.query(`
          UPDATE oe.TenantTrainingPackageAssignments
          SET
            IsActive = 0,
            ModifiedDate = GETUTCDATE(),
            ModifiedBy = @ActorUserId
          WHERE TenantId = @TenantId
            AND PackageId = @PackageId
            AND IsActive = 1
        `);
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    await triggerTenantTrainingSync(
      pool,
      [...new Set([...toActivate, ...toDeactivate])],
      packageId,
      req.user.UserId || null,
      'package-assignment-save'
    );

    return res.json({
      success: true,
      data: {
        packageId,
        assignedTenantIds: requestedTenantIds,
        activatedCount: toActivate.length,
        deactivatedCount: toDeactivate.length
      }
    });
  } catch (error) {
    console.error('Error saving package tenant assignments:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to save package tenant assignments'
    });
  }
});

/**
 * PUT /api/me/tenant-admin/training-library
 * Saves organization-scoped training module/package library.
 */
router.put('/', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireActiveRoleTenantAdminOrSysAdmin, async (req, res) => {
  try {
    const { packages, moduleLibrary } = req.body || {};

    if (!Array.isArray(packages) || !Array.isArray(moduleLibrary)) {
      return res.status(400).json({
        success: false,
        message: 'packages and moduleLibrary must be arrays'
      });
    }

    const pool = await getPool();
    const existing = await getLibraryRow(pool);

    const previousPackages = existing?.PackagesJson ? JSON.parse(existing.PackagesJson) : [];
    const previousModules = existing?.ModulesJson ? JSON.parse(existing.ModulesJson) : [];
    const mergedPackages = mergePackagesById(previousPackages, packages);
    const mergedModules = mergeModulesById(previousModules, moduleLibrary);

    if (!existing) {
      const insertRequest = pool.request();
      insertRequest.input('TrainingLibraryId', sql.UniqueIdentifier, require('crypto').randomUUID());
      insertRequest.input('Scope', sql.NVarChar(50), ORG_SCOPE);
      insertRequest.input('PackagesJson', sql.NVarChar(sql.MAX), JSON.stringify(mergedPackages));
      insertRequest.input('ModulesJson', sql.NVarChar(sql.MAX), JSON.stringify(mergedModules));
      insertRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId || null);
      insertRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId || null);
      await insertRequest.query(`
        INSERT INTO oe.TrainingLibrary (
          TrainingLibraryId, Scope, PackagesJson, ModulesJson, Version,
          CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
        )
        VALUES (
          @TrainingLibraryId, @Scope, @PackagesJson, @ModulesJson, 1,
          GETUTCDATE(), GETUTCDATE(), @CreatedBy, @ModifiedBy
        )
      `);
    } else {
      const updateRequest = pool.request();
      updateRequest.input('Scope', sql.NVarChar(50), ORG_SCOPE);
      updateRequest.input('PackagesJson', sql.NVarChar(sql.MAX), JSON.stringify(mergedPackages));
      updateRequest.input('ModulesJson', sql.NVarChar(sql.MAX), JSON.stringify(mergedModules));
      updateRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId || null);
      await updateRequest.query(`
        UPDATE oe.TrainingLibrary
        SET
          PackagesJson = @PackagesJson,
          ModulesJson = @ModulesJson,
          Version = ISNULL(Version, 1) + 1,
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @ModifiedBy
        WHERE Scope = @Scope
      `      );
    }

    const tenantId = req.tenantId;
    const incomingPackageIds = (packages || []).map((p) => p && p.id).filter(Boolean);
    if (tenantId && incomingPackageIds.length > 0) {
      await ensureTenantAssignmentsForPackages(pool, tenantId, incomingPackageIds, req.user.UserId);
    }

    const previousPackageById = new Map(
      (Array.isArray(previousPackages) ? previousPackages : []).map(record => [String(record.id), record])
    );
    const changedPackageIds = [];
    for (const nextPackage of packages) {
      const packageId = String(nextPackage?.id || '');
      if (!packageId) {
        continue;
      }
      const before = previousPackageById.get(packageId);
      if (!before || JSON.stringify(before) !== JSON.stringify(nextPackage)) {
        changedPackageIds.push(packageId);
      }
    }

    if (changedPackageIds.length > 0) {
      const tenantIdsToSync = [];
      for (const packageId of changedPackageIds) {
        const tenantsRequest = pool.request();
        tenantsRequest.input('PackageId', sql.NVarChar(100), packageId);
        const tenantsResult = await tenantsRequest.query(`
          SELECT TenantId
          FROM oe.TenantTrainingPackageAssignments
          WHERE PackageId = @PackageId
            AND IsActive = 1
        `);
        (tenantsResult.recordset || []).forEach(record => {
          tenantIdsToSync.push(String(record.TenantId));
        });
      }

      await triggerTenantTrainingSync(
        pool,
        [...new Set(tenantIdsToSync)],
        null,
        req.user.UserId || null,
        'training-library-package-save'
      );
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Error saving training library:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to save training library'
    });
  }
});

/**
 * PATCH /api/me/tenant-admin/training-library/modules/:moduleId/archive
 * Soft deletes (archives) a module inside the organization library.
 */
router.patch('/modules/:moduleId/archive', authenticate, authorize(['TenantAdmin']), requireActiveRoleTenantAdmin, async (req, res) => {
  try {
    const { moduleId } = req.params;
    if (!moduleId) {
      return res.status(400).json({
        success: false,
        message: 'moduleId is required'
      });
    }

    const pool = await getPool();
    const existing = await getLibraryRow(pool);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Training library not found'
      });
    }

    const moduleLibrary = existing?.ModulesJson ? JSON.parse(existing.ModulesJson) : [];
    if (!Array.isArray(moduleLibrary)) {
      return res.status(500).json({
        success: false,
        message: 'Training library modules are corrupted'
      });
    }

    const nowIso = new Date().toISOString();
    let found = false;
    const nextModules = moduleLibrary.map(mod => {
      if (!mod || String(mod.id) !== String(moduleId)) {
        return mod;
      }
      found = true;
      if (mod.archived === true) {
        return mod;
      }
      return {
        ...mod,
        archived: true,
        archivedAt: nowIso,
        archivedBy: req.user.UserId || null
      };
    });

    if (!found) {
      return res.status(404).json({
        success: false,
        message: `Module not found: ${moduleId}`
      });
    }

    const packagesRaw = existing?.PackagesJson ? JSON.parse(existing.PackagesJson) : [];
    const { nextPackages, removedFromPackages } = stripModuleFromAllPackages(
      packagesRaw,
      moduleId
    );

    const updateRequest = pool.request();
    updateRequest.input('Scope', sql.NVarChar(50), ORG_SCOPE);
    updateRequest.input('ModulesJson', sql.NVarChar(sql.MAX), JSON.stringify(nextModules));
    updateRequest.input('PackagesJson', sql.NVarChar(sql.MAX), JSON.stringify(nextPackages));
    updateRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId || null);
    await updateRequest.query(`
      UPDATE oe.TrainingLibrary
      SET
        ModulesJson = @ModulesJson,
        PackagesJson = @PackagesJson,
        Version = ISNULL(Version, 1) + 1,
        ModifiedDate = GETUTCDATE(),
        ModifiedBy = @ModifiedBy
      WHERE Scope = @Scope
    `);

    if (removedFromPackages.length > 0) {
      const tenantIdsToSync = [];
      for (const { id: pkgId } of removedFromPackages) {
        if (!pkgId) {
          continue;
        }
        const tenantsRequest = pool.request();
        tenantsRequest.input('PackageId', sql.NVarChar(100), pkgId);
        const tenantsResult = await tenantsRequest.query(`
          SELECT TenantId
          FROM oe.TenantTrainingPackageAssignments
          WHERE PackageId = @PackageId
            AND IsActive = 1
        `);
        (tenantsResult.recordset || []).forEach(record => {
          tenantIdsToSync.push(String(record.TenantId));
        });
      }
      await triggerTenantTrainingSync(
        pool,
        [...new Set(tenantIdsToSync)],
        null,
        req.user.UserId || null,
        'training-library-module-archive'
      );
    }

    return res.json({
      success: true,
      data: {
        moduleId,
        archived: true,
        removedFromPackages
      }
    });
  } catch (error) {
    console.error('Error archiving training module:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to archive module'
    });
  }
});

/**
 * DELETE /api/me/tenant-admin/training-library/modules/:moduleId
 * Permanently removes an archived module from ModulesJson (and strips package references).
 */
router.delete('/modules/:moduleId', authenticate, authorize(['TenantAdmin']), requireActiveRoleTenantAdmin, async (req, res) => {
  try {
    const { moduleId } = req.params;
    if (!moduleId) {
      return res.status(400).json({
        success: false,
        message: 'moduleId is required'
      });
    }

    const pool = await getPool();
    const existing = await getLibraryRow(pool);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Training library not found'
      });
    }

    const moduleLibrary = existing?.ModulesJson ? JSON.parse(existing.ModulesJson) : [];
    if (!Array.isArray(moduleLibrary)) {
      return res.status(500).json({
        success: false,
        message: 'Training library modules are corrupted'
      });
    }

    const target = moduleLibrary.find(m => m && String(m.id) === String(moduleId));
    if (!target) {
      return res.status(404).json({
        success: false,
        message: `Module not found: ${moduleId}`
      });
    }
    if (target.archived !== true) {
      return res.status(400).json({
        success: false,
        message: 'Only archived modules can be permanently deleted. Archive the module first.'
      });
    }

    const nextModules = moduleLibrary.filter(m => !m || String(m.id) !== String(moduleId));
    const packagesRaw = existing?.PackagesJson ? JSON.parse(existing.PackagesJson) : [];
    const { nextPackages, removedFromPackages } = stripModuleFromAllPackages(
      packagesRaw,
      moduleId
    );

    const updateRequest = pool.request();
    updateRequest.input('Scope', sql.NVarChar(50), ORG_SCOPE);
    updateRequest.input('ModulesJson', sql.NVarChar(sql.MAX), JSON.stringify(nextModules));
    updateRequest.input('PackagesJson', sql.NVarChar(sql.MAX), JSON.stringify(nextPackages));
    updateRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId || null);
    await updateRequest.query(`
      UPDATE oe.TrainingLibrary
      SET
        ModulesJson = @ModulesJson,
        PackagesJson = @PackagesJson,
        Version = ISNULL(Version, 1) + 1,
        ModifiedDate = GETUTCDATE(),
        ModifiedBy = @ModifiedBy
      WHERE Scope = @Scope
    `);

    if (removedFromPackages.length > 0) {
      const tenantIdsToSync = [];
      for (const { id: pkgId } of removedFromPackages) {
        if (!pkgId) {
          continue;
        }
        const tenantsRequest = pool.request();
        tenantsRequest.input('PackageId', sql.NVarChar(100), pkgId);
        const tenantsResult = await tenantsRequest.query(`
          SELECT TenantId
          FROM oe.TenantTrainingPackageAssignments
          WHERE PackageId = @PackageId
            AND IsActive = 1
        `);
        (tenantsResult.recordset || []).forEach(record => {
          tenantIdsToSync.push(String(record.TenantId));
        });
      }
      await triggerTenantTrainingSync(
        pool,
        [...new Set(tenantIdsToSync)],
        null,
        req.user.UserId || null,
        'training-library-module-permanent-delete'
      );
    }

    return res.json({
      success: true,
      data: {
        moduleId,
        removedFromPackages
      }
    });
  } catch (error) {
    console.error('Error permanently deleting training module:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to permanently delete module'
    });
  }
});

module.exports = router;

