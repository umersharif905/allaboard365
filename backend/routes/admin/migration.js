'use strict';

const express = require('express');
const router = express.Router();
const { getUserRoles } = require('../../middleware/auth');
const e123Agent = require('../../services/migration/e123Agent.service');
const migrationBatch = require('../../services/migration/migrationBatch.service');
const { mergeBatchImportSettings, parseBatchSummaryJson } = require('../../services/migration/migrationBatchImportSettings');
const e123FetchJob = require('../../services/migration/e123FetchJob.service');
const agentTenantMap = require('../../services/migration/agentTenantMap.service');
const productMapService = require('../../services/migration/productMap.service');
const migrationPreview = require('../../services/migration/migrationPreview.service');
const migrationStatus = require('../../services/migration/migrationStatus.service');
const migrationAgentCatalog = require('../../services/migration/migrationAgentCatalog.service');
const e123AgentIndex = require('../../services/migration/e123AgentIndex.service');
const sharewellAgents = require('../../services/migration/sharewellAgents.service');
const { resolveOrgBrokerId } = require('../../services/migration/orgBrokerResolver.service');
const migrationProductMapping = require('../../services/migration/migrationProductMapping.service');
const migrationAgentMapping = require('../../services/migration/migrationAgentMapping.service');
const e123ProductWizardDraft = require('../../services/migration/e123ProductWizardDraft.service');
const e123CatalogSnapshot = require('../../services/migration/e123CatalogSnapshot.service');
const e123AgentTreeSnapshot = require('../../services/migration/e123AgentTreeSnapshot.service');
const e123PayablesSnapshot = require('../../services/migration/e123PayablesSnapshot.service');
const e123GroupListSnapshot = require('../../services/migration/e123GroupListSnapshot.service');
const agentMigration = require('../../services/migration/agentMigration.service');
const groupMigration = require('../../services/migration/groupMigration.service');
const CommissionLevelService = require('../../services/commissionLevel.service');
const agentMigrationWorkspaceJob = require('../../services/migration/agentMigrationWorkspaceJob.service');
const migrationInstance = require('../../services/migration/migrationInstance.service');
const {
  effectiveInstanceId,
  effectiveTenantId,
  assertTenantInScope,
  assertInstanceInScope,
  assertBatchInScope,
  assertGroupBatchInScope,
  resolveScopedTenants
} = require('../../services/migration/migrationAccess.helpers');
const { runWithE123Config, runWithInstanceE123Config, getE123MemberSearchConfig } = require('../../services/migration/e123Config');
const { MAX_UPLOAD_FILE_BYTES } = require('../../constants/uploadLimits');
const multer = require('multer');

const catalogUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_FILE_BYTES, files: 10 }
});

const agentTreeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_FILE_BYTES, files: 1 }
});

const payablesCsvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_FILE_BYTES, files: 1 }
});

const authorize = (allowedRoles) => (req, res, next) => {
  const userRoles = getUserRoles(req.user);
  if (!allowedRoles.some((role) => userRoles.includes(role))) {
    return res.status(403).json({ success: false, message: 'Insufficient permissions' });
  }
  next();
};

const authorizeSysAdminOnly = (req, res, next) => {
  if (req.migrationContext?.isTenantPortal) {
    return res.status(403).json({ success: false, message: 'Insufficient permissions' });
  }
  return authorize(['SysAdmin'])(req, res, next);
};

const authorizeMigration = (req, res, next) => {
  const userRoles = getUserRoles(req.user);
  if (req.migrationContext?.isTenantPortal) {
    if (userRoles.includes('TenantAdmin') || userRoles.includes('SysAdmin')) {
      return next();
    }
    return res.status(403).json({ success: false, message: 'Insufficient permissions' });
  }
  return authorize(['SysAdmin'])(req, res, next);
};

async function withScopedInstanceE123(req, fn) {
  const instanceId = effectiveInstanceId(req);
  if (instanceId) assertInstanceInScope(req, instanceId);
  return runWithInstanceE123Config(instanceId, fn);
}

router.get('/config-status', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req);
    let member = getE123MemberSearchConfig();
    if (instanceId) {
      const creds = await migrationInstance.resolveCredentials(instanceId);
      if (creds?.corpid) {
        member = {
          url: process.env.E123_USER_GETALL_URL || 'https://www.enrollment123.com/api/user.getall/',
          corpid: creds.corpid,
          username: creds.username,
          password: creds.password
        };
      }
    }
    const resolvedOrgBrokerId = instanceId
      ? (await migrationInstance.resolveCredentials(instanceId))?.orgBrokerId || await resolveOrgBrokerId()
      : await resolveOrgBrokerId();
    res.json({
      success: true,
      data: {
        memberSearchConfigured: !!(member.corpid && member.username && member.password),
        adminV2Configured: !!(member.username && member.password),
        sharewellAgentsConfigured: sharewellAgents.isSharewellConfigured(),
        orgBrokerConfigured: !!resolvedOrgBrokerId,
        resolvedOrgBrokerId,
        e123AgentIndexStatus: e123AgentIndex.getIndexStatus(),
        usesInstanceCredentials: !!instanceId
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/instances', authorizeSysAdminOnly, async (req, res) => {
  try {
    const data = await migrationInstance.listInstances({
      includeArchived: req.query.includeArchived === '1'
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/instances/:instanceId', authorizeSysAdminOnly, async (req, res) => {
  try {
    const instance = await migrationInstance.getInstance(req.params.instanceId, { includeSecrets: true });
    if (!instance) return res.status(404).json({ success: false, message: 'Migration instance not found' });
    const tenants = await migrationInstance.getInstanceTenants(req.params.instanceId);
    res.json({ success: true, data: { ...instance, tenants } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/instances', authorizeSysAdminOnly, async (req, res) => {
  try {
    const {
      label,
      e123CorpId,
      e123Username,
      e123Password,
      orgBrokerId,
      orgBrokerLabel,
      enableTenantPortal = false,
      tenantIds = []
    } = req.body || {};
    if (!label?.trim()) {
      return res.status(400).json({ success: false, message: 'label is required' });
    }
    const data = await migrationInstance.createInstance({
      label: label.trim(),
      e123CorpId,
      e123Username,
      e123Password,
      orgBrokerId: orgBrokerId != null ? Number(orgBrokerId) : null,
      orgBrokerLabel,
      enableTenantPortal: !!enableTenantPortal,
      tenantIds,
      createdBy: req.user?.UserId || null
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    const status = err.code === 'TENANT_ALREADY_ASSIGNED' ? 409 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.patch('/instances/:instanceId', authorizeSysAdminOnly, async (req, res) => {
  try {
    const data = await migrationInstance.updateInstance(req.params.instanceId, req.body || {});
    if (!data) return res.status(404).json({ success: false, message: 'Migration instance not found' });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.code === 'TENANT_ALREADY_ASSIGNED' ? 409 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/instances/:instanceId/available-tenants', authorizeSysAdminOnly, async (req, res) => {
  try {
    const data = await migrationInstance.listAvailableTenantsForAssignment(req.params.instanceId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/tenants', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req);
    const data = await resolveScopedTenants(req, instanceId);
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

function enrichAgentOption(opt, appliedMap) {
  const includeDownline = opt.includeDownline !== false;
  const key = `${opt.rootBrokerId}:${includeDownline ? 1 : 0}`;
  const applied = appliedMap.get(key);
  const label = opt.label || opt.rootAgentLabel || `Broker ${opt.rootBrokerId}`;
  return {
    ...opt,
    label,
    includeDownline,
    isOrgRoot: opt.isOrgRoot === true || /full org/i.test(label),
    isOrgDirect: opt.isOrgDirect === true || opt.isOrgRoot === true,
    migrationStatus: applied ? {
      alreadyMigrated: true,
      appliedCount: applied.applyCreateCount,
      tenantName: applied.tenantName,
      appliedUtc: applied.modifiedUtc
    } : { alreadyMigrated: false }
  };
}

router.get('/agents/search', authorizeMigration, async (req, res) => {
  const startedAt = Date.now();
  try {
    const search = String(req.query.q || req.query.search || '').trim();
    const limit = Number(req.query.limit) || 100;
    const topLevelOnly = req.query.topLevelOnly !== '0' && req.query.topLevelOnly !== 'false';
    const instanceId = effectiveInstanceId(req);
    const appliedMap = await migrationStatus.getAppliedAgentImportMap();
    const catalog = await withScopedInstanceE123(req, () =>
      migrationAgentCatalog.searchMigrationAgents({ search, limit, topLevelOnly, instanceId })
    );

    console.log('[migration] agents/search ok', {
      ms: Date.now() - startedAt,
      search: search.slice(0, 40),
      count: catalog.agents?.length || 0,
      source: catalog.source,
      indexBuilding: catalog.indexBuilding
    });

    res.json({
      success: true,
      data: {
        agents: catalog.agents.map((a) => enrichAgentOption(a, appliedMap)),
        totalCount: catalog.totalCount,
        source: catalog.source,
        sharewellConfigured: sharewellAgents.isSharewellConfigured(),
        indexBuilding: catalog.indexBuilding,
        topLevelOnly: catalog.topLevelOnly
      }
    });
  } catch (err) {
    console.warn('[migration] agents/search failed', { ms: Date.now() - startedAt, message: err.message });
    const status = err.code === 'E123_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/agents/options', authorizeMigration, async (req, res) => {
  const startedAt = Date.now();
  console.log('[migration] agents/options start', {
    instanceId: effectiveInstanceId(req) || null,
    topLevelOnly: req.query.topLevelOnly !== '0' && req.query.topLevelOnly !== 'false'
  });
  try {
    const topLevelOnly = req.query.topLevelOnly !== '0' && req.query.topLevelOnly !== 'false';
    const instanceId = effectiveInstanceId(req);
    const [appliedMap, savedMappings, catalog] = await Promise.all([
      migrationStatus.getAppliedAgentImportMap(),
      agentTenantMap.listAgentMappings(),
      withScopedInstanceE123(req, () =>
        migrationAgentCatalog.getMigrationAgentOptions({ search: '', limit: 500, topLevelOnly, instanceId })
      )
    ]);

    console.log('[migration] agents/options ok', {
      ms: Date.now() - startedAt,
      count: catalog.agents?.length || 0,
      totalCount: catalog.agentsTotalCount,
      source: catalog.source,
      indexBuilding: catalog.indexBuilding
    });

    res.json({
      success: true,
      data: {
        presets: catalog.presets.map((p) => enrichAgentOption(p, appliedMap)),
        savedMappings: (savedMappings || []).map((m) => enrichAgentOption({
          rootBrokerId: m.RootBrokerId,
          rootAgentLabel: m.RootAgentLabel,
          includeDownline: !!m.IncludeDownline,
          tenantId: m.TenantId,
          tenantName: m.TenantName
        }, appliedMap)),
        agents: catalog.agents.map((a) => enrichAgentOption(a, appliedMap)),
        agentsTotalCount: catalog.agentsTotalCount,
        source: catalog.source,
        sharewellConfigured: catalog.sharewellConfigured,
        agentTreeConfigured: catalog.agentTreeConfigured,
        agentTreeNodeCount: catalog.agentTreeNodeCount,
        agentTreeExport: catalog.agentTreeExport,
        orgBrokerConfigured: catalog.orgBrokerConfigured,
        memberSearchConfigured: catalog.memberSearchConfigured,
        resolvedOrgBrokerId: catalog.resolvedOrgBrokerId,
        diagnostics: catalog.diagnostics,
        indexBuilding: catalog.indexBuilding,
        indexStatus: catalog.indexStatus,
        topLevelOnly: catalog.topLevelOnly
      }
    });
  } catch (err) {
    console.warn('[migration] agents/options failed', { ms: Date.now() - startedAt, message: err.message });
    const status = err.code === 'E123_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/agents/lookup/:brokerId', authorizeMigration, async (req, res) => {
  try {
    const data = await withScopedInstanceE123(req, () =>
      e123Agent.getAgentWithParentChain(req.params.brokerId)
    );
    res.json({ success: true, data });
  } catch (err) {
    const status = err.code === 'E123_NOT_CONFIGURED' ? 503
      : err.code === 'E123_AGENT_NOT_FOUND' ? 404
        : err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/agent-mappings', authorizeMigration, async (req, res) => {
  try {
    const data = await agentTenantMap.listAgentMappings();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/batches/:batchId/agents/mapping', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    const tenantId = req.query.tenantId || batch.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'tenantId is required' });
    }
    assertTenantInScope(req, tenantId);
    const instanceId = await migrationInstance.resolveInstanceIdForBatch(batch);
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'Migration instance is required for agent mapping' });
    }
    const data = await migrationAgentMapping.buildAgentMappingWorkspace(
      req.params.batchId,
      instanceId,
      tenantId
    );
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/tenants/:tenantId/agents/search', authorizeMigration, async (req, res) => {
  try {
    assertTenantInScope(req, req.params.tenantId);
    const data = await migrationAgentMapping.searchTenantAgents(req.params.tenantId, {
      search: req.query.q || req.query.search || '',
      limit: Number(req.query.limit) || 30
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/agents/maps', authorizeMigration, async (req, res) => {
  try {
    const { instanceId, e123BrokerId, agentId, e123AgentLabel, tenantId } = req.body || {};
    if (!instanceId || !e123BrokerId || !agentId) {
      return res.status(400).json({
        success: false,
        message: 'instanceId, e123BrokerId, and agentId are required'
      });
    }
    assertInstanceInScope(req, instanceId);
    const effectiveTenantId = tenantId || null;
    if (effectiveTenantId) assertTenantInScope(req, effectiveTenantId);
    const data = await migrationAgentMapping.saveManualAgentMap({
      instanceId,
      e123BrokerId: Number(e123BrokerId),
      agentId,
      e123AgentLabel,
      tenantId: effectiveTenantId
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/pending', authorizeMigration, async (req, res) => {
  try {
    const data = await migrationBatch.listPendingMembers(
      Number(req.query.limit) || 100,
      effectiveInstanceId(req),
      effectiveTenantId(req)
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/history', authorizeMigration, async (req, res) => {
  try {
    const data = await migrationBatch.listHistory(
      Number(req.query.limit) || 50,
      effectiveInstanceId(req),
      effectiveTenantId(req)
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/batches', authorizeMigration, async (req, res) => {
  try {
    const {
      rootBrokerId,
      rootAgentLabel,
      includeDownline = true,
      startFetch = true,
      instanceId = null,
      importSettings = null
    } = req.body || {};
    if (!rootBrokerId) {
      return res.status(400).json({ success: false, message: 'rootBrokerId is required' });
    }

    let batch = await migrationBatch.createBatch({
      rootBrokerId: Number(rootBrokerId),
      rootAgentLabel,
      includeDownline: includeDownline !== false,
      createdBy: req.user?.UserId || null,
      instanceId: effectiveInstanceId(req) || instanceId || null
    });

    if (importSettings && typeof importSettings === 'object') {
      batch = await migrationBatch.updateBatch(batch.BatchId, {
        SummaryJson: mergeBatchImportSettings(batch.SummaryJson, importSettings)
      });
    }

    if (startFetch) {
      e123FetchJob.startFetchJob(batch.BatchId).catch((err) => {
        console.error('E123 fetch job failed:', batch.BatchId, err.message);
      });
    }

    res.status(201).json({ success: true, data: batch });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/batches/:batchId', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    e123FetchJob.resumeFetchJobIfStale(req.params.batchId, batch);
    const detail = await migrationBatch.getBatchDetail(req.params.batchId);
    const householdCount = await migrationBatch.countBatchHouseholds(req.params.batchId);
    res.json({ success: true, data: { ...detail, householdCount } });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.patch('/batches/:batchId', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });

    const { wizardStep, tenantId, saveAgentMapping, rootAgentLabel, importSettings } = req.body || {};
    if (tenantId) assertTenantInScope(req, tenantId);
    const scopedTenantId = tenantId || effectiveTenantId(req);
    if (scopedTenantId && req.migrationContext?.isTenantPortal && tenantId && tenantId !== scopedTenantId) {
      return res.status(403).json({ success: false, message: 'Tenant not in scope for this migration portal' });
    }

    const updates = {};
    if (wizardStep != null) updates.WizardStep = Number(wizardStep);
    if (scopedTenantId) updates.TenantId = scopedTenantId;
    else if (tenantId) updates.TenantId = tenantId;
    if (rootAgentLabel) updates.RootAgentLabel = rootAgentLabel;
    if (importSettings && typeof importSettings === 'object') {
      updates.SummaryJson = mergeBatchImportSettings(batch.SummaryJson, importSettings);
    }

    const updated = await migrationBatch.updateBatch(req.params.batchId, updates);

    const mappingTenantId = scopedTenantId || tenantId;
    if (saveAgentMapping && mappingTenantId && batch.RootBrokerId) {
      await agentTenantMap.upsertAgentMapping({
        rootBrokerId: batch.RootBrokerId,
        rootAgentLabel: rootAgentLabel || batch.RootAgentLabel,
        includeDownline: !!batch.IncludeDownline,
        tenantId: mappingTenantId
      });
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/batches/:batchId/fetch-status', authorizeMigration, async (req, res) => {
  try {
    let batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });

    e123FetchJob.resumeFetchJobIfStale(req.params.batchId, batch);

    batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });

    let householdCount = null;
    if (['ready', 'applied', 'applying', 'failed'].includes(batch.Status)) {
      householdCount = await migrationBatch.countBatchHouseholds(req.params.batchId);
    }

    const summary = parseBatchSummaryJson(batch.SummaryJson);
    const fetchProgress = summary.fetchProgress || null;

    res.json({
      success: true,
      data: {
        status: batch.Status,
        pagesCompleted: batch.FetchPagesCompleted,
        membersLoaded: batch.FetchMembersLoaded,
        rawUsersLoaded: batch.Status === 'fetching' ? batch.FetchMembersLoaded : null,
        householdCount,
        fetchError: batch.FetchError,
        wizardStep: batch.WizardStep,
        fetchPhase: fetchProgress?.phase || null,
        householdsSaved: fetchProgress?.householdsSaved ?? null,
        householdsTotal: fetchProgress?.householdsTotal ?? null
      }
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.patch('/batches/:batchId/households/selection', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const { batchHouseholdIds, included, all, search } = req.body || {};
    const includedFlag = included === true || included === 1 || included === 'true' || included === '1'
      ? true
      : (included === false || included === 0 || included === 'false' || included === '0' ? false : true);
    const data = await migrationBatch.updateHouseholdSelection(req.params.batchId, {
      batchHouseholdIds,
      included: includedFlag,
      all: all === true || all === 1 || all === 'true' || all === '1',
      search: search || ''
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/batches/:batchId/households/select-new-only', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const selection = await migrationBatch.selectNewHouseholdsOnly(req.params.batchId);
    res.json({ success: true, data: { selection } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/batches/:batchId/households/select-pending-migration', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const selection = await migrationBatch.selectPendingMigrationHouseholds(req.params.batchId);
    res.json({ success: true, data: { selection } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/batches/:batchId/households/select-by-member-ids', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const { householdMemberIds, replaceSelection } = req.body || {};
    const replace = replaceSelection !== false && replaceSelection !== 0 && replaceSelection !== 'false';
    const data = await migrationBatch.selectHouseholdsByMemberIds(
      req.params.batchId,
      householdMemberIds,
      { replaceSelection: replace }
    );
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/batches/:batchId/households/deselect-premium-mismatches', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    if (!batch.TenantId) {
      return res.status(400).json({ success: false, message: 'Select a tenant before premium comparison' });
    }
    const data = await migrationBatch.deselectPremiumMismatches(req.params.batchId);
    const selection = await migrationBatch.getBatchSelectionSummary(req.params.batchId);
    res.json({ success: true, data: { ...data, selection } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/batches/:batchId/households', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 50;
    const search = req.query.search || '';
    const includePremium = req.query.includePremium === '1' || req.query.includePremium === 'true';
    const data = await migrationBatch.listBatchHouseholdSummaries(req.params.batchId, {
      page,
      pageSize,
      search,
      includePremium
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/batches/:batchId/fetch', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    e123FetchJob.startFetchJob(req.params.batchId).catch((err) => {
      console.error('E123 fetch restart failed:', req.params.batchId, err.message);
    });
    res.json({ success: true, message: 'Fetch started' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/batches/:batchId/products/unmapped', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const instanceId = await migrationInstance.resolveInstanceIdForBatch(batch);
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'Migration instance is required for product mapping' });
    }
    const data = await migrationPreview.getUnmappedProductsForBatch(req.params.batchId, instanceId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/batches/:batchId/products/mapping', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const tenantId = req.query.tenantId || batch.TenantId || null;
    if (tenantId) assertTenantInScope(req, tenantId);
    const instanceId = await migrationInstance.resolveInstanceIdForBatch(batch);
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'Migration instance is required for product mapping' });
    }
    assertInstanceInScope(req, instanceId);
    const data = await migrationProductMapping.getProductMappingWorkspace(req.params.batchId, {
      tenantId,
      instanceId
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/tenants/:tenantId/products/mapping-workspace', authorizeMigration, async (req, res) => {
  try {
    assertTenantInScope(req, req.params.tenantId);
    const { batchId, instanceId: queryInstanceId } = req.query;
    const instanceId = queryInstanceId
      || await migrationInstance.resolveInstanceIdForTenant(req.params.tenantId);
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'Tenant is not assigned to a migration instance' });
    }
    assertInstanceInScope(req, instanceId);
    const data = await migrationProductMapping.getTenantProductMappingWorkspace(
      req.params.tenantId,
      { batchId: batchId || null, instanceId }
    );
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/tenants/:tenantId/products/e123-vendor-routing/:sourceProductKey', authorizeMigration, async (req, res) => {
  try {
    assertTenantInScope(req, req.params.tenantId);
    const { batchId } = req.query;
    const data = await e123ProductWizardDraft.buildE123VendorRoutingPreviewForProduct({
      sourceProductKey: req.params.sourceProductKey,
      batchId: batchId || null,
      vendorBucketOverrides: e123ProductWizardDraft.parseVendorBucketOverrides(req.query.vendorBucketOverrides)
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/tenants/:tenantId/products/e123-wizard-draft/:sourceProductKey', authorizeMigration, async (req, res) => {
  try {
    assertTenantInScope(req, req.params.tenantId);
    const { batchId } = req.query;
    const useTobaccoPricing = req.query.useTobaccoPricing;
    const templateProductId = req.query.templateProductId;
    let templateProductIdOverride = undefined;
    if (templateProductId !== undefined) {
      templateProductIdOverride = templateProductId === 'none' ? null : templateProductId;
    }
    const data = await e123ProductWizardDraft.buildE123ProductWizardDraft({
      tenantId: req.params.tenantId,
      sourceProductKey: req.params.sourceProductKey,
      batchId: batchId || null,
      vendorBucketOverrides: e123ProductWizardDraft.parseVendorBucketOverrides(req.query.vendorBucketOverrides),
      useTobaccoPricingOverride: useTobaccoPricing === undefined
        ? undefined
        : useTobaccoPricing === '1' || useTobaccoPricing === 'true',
      templateProductId: templateProductIdOverride
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.code === 'E123_PRODUCT_NOT_FOUND' ? 404 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/tenants/:tenantId/products/map-summary', authorizeMigration, async (req, res) => {
  try {
    assertTenantInScope(req, req.params.tenantId);
    const instanceId = req.query.instanceId
      || await migrationInstance.resolveInstanceIdForTenant(req.params.tenantId);
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'Tenant is not assigned to a migration instance' });
    }
    assertInstanceInScope(req, instanceId);
    const data = await migrationProductMapping.getProductMapSummary(instanceId);
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/instances/:instanceId/products/map-summary', authorizeMigration, async (req, res) => {
  try {
    assertInstanceInScope(req, req.params.instanceId);
    const data = await migrationProductMapping.getProductMapSummary(req.params.instanceId);
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/e123-catalog/status', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req);
    if (instanceId) assertInstanceInScope(req, instanceId);
    const rootBrokerId = req.query.rootBrokerId ? Number(req.query.rootBrokerId) : null;
    const data = await withScopedInstanceE123(req, () =>
      e123CatalogSnapshot.getCatalogStatus(rootBrokerId, instanceId)
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/e123-catalog/products', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req);
    if (instanceId) assertInstanceInScope(req, instanceId);
    const rootBrokerId = req.query.rootBrokerId ? Number(req.query.rootBrokerId) : null;
    const data = await withScopedInstanceE123(req, () =>
      e123CatalogSnapshot.listCatalogProducts(rootBrokerId, instanceId)
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/e123-catalog/products/:pdid', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req);
    if (instanceId) assertInstanceInScope(req, instanceId);
    const rootBrokerId = req.query.rootBrokerId ? Number(req.query.rootBrokerId) : null;
    const data = await withScopedInstanceE123(req, () =>
      e123CatalogSnapshot.getProductSnapshot(req.params.pdid, rootBrokerId, instanceId)
    );
    if (!data) return res.status(404).json({ success: false, message: 'Product snapshot not found' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/e123-catalog/import', authorizeMigration, catalogUpload.array('files', 10), async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req);
    if (instanceId) assertInstanceInScope(req, instanceId);
    const files = req.files || [];
    const rootBrokerId = req.body?.rootBrokerId ? Number(req.body.rootBrokerId) : null;
    const data = await withScopedInstanceE123(req, async () => {
      let brokerId = rootBrokerId;
      if (!brokerId) {
        brokerId = await e123CatalogSnapshot.resolveCatalogBrokerId(null, instanceId);
      }
      return e123CatalogSnapshot.importCatalogFromUploads({
        files,
        rootBrokerId: brokerId,
        uploadedBy: req.user?.UserId || null
      });
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.code?.startsWith('E123_CATALOG') ? 400 : 500;
    res.status(status).json({ success: false, message: err.message, code: err.code || undefined });
  }
});

router.get('/agent-tree/status', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req);
    if (instanceId) assertInstanceInScope(req, instanceId);
    const data = await e123AgentTreeSnapshot.getAgentTreeStatus(instanceId);
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/agent-tree/children', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req);
    if (instanceId) assertInstanceInScope(req, instanceId);
    const parentAgentId = req.query.parentAgentId != null && String(req.query.parentAgentId).trim() !== ''
      ? Number(req.query.parentAgentId)
      : null;
    const data = await e123AgentTreeSnapshot.listAgentTreeChildren(instanceId, parentAgentId);
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/agent-tree/import', authorizeMigration, agentTreeUpload.single('file'), async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req) || req.body?.instanceId || null;
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'Migration instance is required' });
    }
    assertInstanceInScope(req, instanceId);

    const data = await e123AgentTreeSnapshot.importAgentTreeFromUpload({
      file: req.file,
      instanceId,
      uploadedBy: req.user?.UserId || null
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.code?.startsWith('E123_AGENT_TREE') ? 400 : 500;
    res.status(status).json({ success: false, message: err.message, code: err.code || undefined });
  }
});

router.get('/payables/status', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req);
    if (instanceId) assertInstanceInScope(req, instanceId);
    const data = await e123PayablesSnapshot.getPayablesStatus(instanceId);
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/payables/import', authorizeMigration, payablesCsvUpload.single('file'), async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req) || req.body?.instanceId || null;
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'Migration instance is required' });
    }
    assertInstanceInScope(req, instanceId);
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: 'Payables detail CSV file is required' });
    }

    const data = await e123PayablesSnapshot.importPayablesFromUpload({
      instanceId,
      buffer: req.file.buffer,
      fileName: req.file.originalname || null,
      uploadedBy: req.user?.UserId || null
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message, code: err.code || undefined });
  }
});

router.get('/groups-list/status', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req);
    if (instanceId) assertInstanceInScope(req, instanceId);
    const data = await e123GroupListSnapshot.getGroupsListStatus(instanceId);
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/groups-list/import', authorizeMigration, payablesCsvUpload.single('file'), async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req) || req.body?.instanceId || null;
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'Migration instance is required' });
    }
    assertInstanceInScope(req, instanceId);
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: 'Groups list CSV file is required' });
    }

    const data = await e123GroupListSnapshot.importGroupsListFromUpload({
      instanceId,
      buffer: req.file.buffer,
      fileName: req.file.originalname || null,
      uploadedBy: req.user?.UserId || null
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.code?.startsWith('E123_GROUPS_LIST') ? 400 : (err.status || 500);
    res.status(status).json({ success: false, message: err.message, code: err.code || undefined });
  }
});

router.get('/tenants/:tenantId/subscribed-products', authorizeMigration, async (req, res) => {
  try {
    assertTenantInScope(req, req.params.tenantId);
    const data = await migrationProductMapping.listSubscribedProducts(req.params.tenantId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/products/:productId/pricing', authorizeMigration, async (req, res) => {
  try {
    const data = await migrationProductMapping.listProductPricingRows(req.params.productId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/products/suggest-tier-pricing', authorizeMigration, async (req, res) => {
  try {
    const { productId, tiers } = req.body || {};
    if (!productId || !Array.isArray(tiers)) {
      return res.status(400).json({ success: false, message: 'productId and tiers[] are required' });
    }
    const data = await migrationProductMapping.suggestTierPricingBulk(productId, tiers);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/products/maps/bulk', authorizeMigration, async (req, res) => {
  try {
    const { instanceId, tenantId, mappings } = req.body || {};
    const resolvedInstanceId = instanceId
      || (tenantId ? await migrationInstance.resolveInstanceIdForTenant(tenantId) : null);
    if (!resolvedInstanceId || !Array.isArray(mappings) || mappings.length === 0) {
      return res.status(400).json({ success: false, message: 'instanceId and mappings[] are required' });
    }
    assertInstanceInScope(req, resolvedInstanceId);
    const valid = mappings.every((mapping) =>
      mapping.sourceProductKey
      && (mapping.ignoreImport || mapping.productId)
    );
    if (!valid) {
      return res.status(400).json({
        success: false,
        message: 'Each mapping requires sourceProductKey and either productId or ignoreImport'
      });
    }
    await migrationProductMapping.saveProductMappings({ instanceId: resolvedInstanceId, mappings });
    res.json({ success: true });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/products/maps/unignore', authorizeMigration, async (req, res) => {
  try {
    const { instanceId, tenantId, sourceProductKey } = req.body || {};
    const resolvedInstanceId = instanceId
      || (tenantId ? await migrationInstance.resolveInstanceIdForTenant(tenantId) : null);
    if (!resolvedInstanceId || !sourceProductKey) {
      return res.status(400).json({ success: false, message: 'instanceId and sourceProductKey are required' });
    }
    assertInstanceInScope(req, resolvedInstanceId);
    await migrationProductMapping.clearIgnoredProduct({ instanceId: resolvedInstanceId, sourceProductKey });
    res.json({ success: true });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/products/maps/unsync', authorizeMigration, async (req, res) => {
  try {
    const { instanceId, tenantId, sourceProductKey } = req.body || {};
    const resolvedInstanceId = instanceId
      || (tenantId ? await migrationInstance.resolveInstanceIdForTenant(tenantId) : null);
    if (!resolvedInstanceId || !sourceProductKey) {
      return res.status(400).json({ success: false, message: 'instanceId and sourceProductKey are required' });
    }
    assertInstanceInScope(req, resolvedInstanceId);
    await migrationProductMapping.unsyncProductMapping({ instanceId: resolvedInstanceId, sourceProductKey });
    res.json({ success: true });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/products/maps', authorizeMigration, async (req, res) => {
  try {
    const { instanceId, tenantId } = req.query;
    const resolvedInstanceId = instanceId
      || (tenantId ? await migrationInstance.resolveInstanceIdForTenant(tenantId) : null);
    if (!resolvedInstanceId) {
      return res.status(400).json({ success: false, message: 'instanceId is required' });
    }
    assertInstanceInScope(req, resolvedInstanceId);
    const data = await productMapService.listProductMaps(resolvedInstanceId);
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/products/map', authorizeMigration, async (req, res) => {
  try {
    const {
      instanceId, tenantId, sourceSystem = 'e123', sourceProductKey, sourceBenefitKey,
      sourceProductLabel, productId, productPricingId
    } = req.body || {};
    const resolvedInstanceId = instanceId
      || (tenantId ? await migrationInstance.resolveInstanceIdForTenant(tenantId) : null);
    if (!resolvedInstanceId || !sourceProductKey || !productId) {
      return res.status(400).json({
        success: false,
        message: 'instanceId, sourceProductKey, and productId are required'
      });
    }
    assertInstanceInScope(req, resolvedInstanceId);
    await productMapService.saveProductMap({
      instanceId: resolvedInstanceId,
      sourceSystem,
      sourceProductKey,
      sourceBenefitKey,
      sourceProductLabel,
      productId,
      productPricingId
    });
    res.json({ success: true });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/products/stub', authorizeMigration, async (req, res) => {
  try {
    const { tenantId, name, vendorId, productOwnerId, tierType, configValue1 } = req.body || {};
    if (!tenantId || !name || !vendorId || !productOwnerId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId, name, vendorId, and productOwnerId are required'
      });
    }
    assertTenantInScope(req, tenantId);
    const data = await productMapService.createStubProduct({
      tenantId, name, vendorId, productOwnerId, tierType, configValue1,
      createdBy: req.user?.UserId
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/batches/:batchId/preview', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 50;
    const chunkOffset = req.query.chunkOffset != null ? Number(req.query.chunkOffset) : 0;
    const chunkSize = req.query.chunkSize != null ? Number(req.query.chunkSize) : null;
    const includeSummary = req.query.includeSummary === '1' || req.query.includeSummary === 'true';
    const data = await migrationPreview.previewBatch(req.params.batchId, {
      page,
      pageSize,
      chunkOffset,
      chunkSize,
      includeSummary
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/batches/:batchId/summary', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    if (!batch.TenantId) return res.status(400).json({ success: false, message: 'TenantId required' });
    const instanceId = await migrationInstance.resolveInstanceIdForBatch(batch);
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'Migration instance is required for product mapping' });
    }
    const summary = await migrationPreview.summarizeBatch(req.params.batchId, batch.TenantId, instanceId);
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/batches/:batchId/apply', authorizeMigration, async (req, res) => {
  const batchId = req.params.batchId;
  const force = req.body?.force === true || req.query?.force === '1' || req.query?.force === 'true';
  console.log(`[migration-apply] POST /apply batch=${batchId} force=${force}`);
  try {
    const batch = await assertBatchInScope(req, batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const data = await migrationPreview.startApplyBatch(batchId, req.user?.UserId, { force });
    console.log(`[migration-apply] POST /apply batch=${batchId} accepted applyTotal=${data.applyTotal}`);
    res.json({ success: true, data });
  } catch (err) {
    console.error(`[migration-apply] POST /apply batch=${batchId} rejected:`, err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/batches/:batchId/discard', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });

    const force = req.body?.force === true;
    if (batch.Status === 'fetching') {
      e123FetchJob.cancelFetchJob(req.params.batchId);
    }
    if (batch.Status === 'applying' && force) {
      await migrationPreview.abortApplyJob(req.params.batchId);
    }

    const updated = await migrationBatch.discardBatch(req.params.batchId, { force });
    res.json({
      success: true,
      data: {
        batchId: updated.BatchId,
        status: updated.Status
      }
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/batches/:batchId/release-apply-lock', authorizeMigration, async (req, res) => {
  console.log(`[migration-apply] POST /release-apply-lock batch=${req.params.batchId}`);
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    await migrationPreview.abortApplyJob(req.params.batchId);
    const data = await migrationBatch.releaseApplyLock(req.params.batchId);
    res.json({
      success: true,
      data: {
        batchId: data.BatchId,
        status: data.Status,
        applyProcessed: data.ApplyProcessed,
        applyTotal: data.ApplyTotal
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/batches/:batchId/apply-status', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const snapshot = await migrationPreview.getApplyStatusSnapshot(req.params.batchId);
    if (!snapshot) return res.status(404).json({ success: false, message: 'Batch not found' });
    res.json({
      success: true,
      data: {
        status: snapshot.status,
        applyProcessed: snapshot.applyProcessed,
        applyTotal: snapshot.applyTotal,
        applyCreateCount: snapshot.applyCreateCount,
        applySkipCount: snapshot.applySkipCount,
        applyErrorCount: snapshot.applyErrorCount,
        modifiedUtc: snapshot.modifiedUtc || null,
        results: snapshot.results || null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- Agent migration wizard (E123 -> AB365 agent create) ---

router.post('/agents/migration/batches', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req) || req.body?.instanceId;
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'instanceId is required' });
    }
    assertInstanceInScope(req, instanceId);

    const rootBrokerId = Number(req.body?.rootBrokerId);
    if (!Number.isFinite(rootBrokerId) || rootBrokerId <= 0) {
      return res.status(400).json({ success: false, message: 'rootBrokerId is required' });
    }

    const batch = await agentMigration.createBatch({
      instanceId,
      rootBrokerId,
      rootAgentLabel: req.body?.rootAgentLabel || null,
      includeDownline: req.body?.includeDownline !== false,
      tenantId: req.body?.tenantId || null,
      agencyId: req.body?.agencyId || null,
      createdBy: req.user?.UserId || null
    });
    if (req.body?.draftJson && typeof req.body.draftJson === 'object') {
      await agentMigration.patchBatch(batch.BatchId, { draftJson: req.body.draftJson });
    }

    res.status(201).json({ success: true, data: agentMigration.mapBatchRow(batch) });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.get('/agents/migration/batches/:batchId', authorizeMigration, async (req, res) => {
  try {
    const batch = await agentMigration.getBatch(req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const instanceId = effectiveInstanceId(req);
    if (instanceId && `${batch.InstanceId}`.toLowerCase() !== `${instanceId}`.toLowerCase()) {
      return res.status(403).json({ success: false, message: 'Batch not in scope for this instance' });
    }
    res.json({
      success: true,
      data: {
        batchId: batch.BatchId,
        instanceId: batch.InstanceId,
        rootBrokerId: batch.RootBrokerId,
        rootAgentLabel: batch.RootAgentLabel,
        includeDownline: !!batch.IncludeDownline,
        tenantId: batch.TenantId,
        agencyId: batch.AgencyId,
        wizardStep: batch.WizardStep,
        status: batch.Status,
        draftJson: batch.DraftJson ? JSON.parse(batch.DraftJson) : {},
        summaryJson: batch.SummaryJson ? JSON.parse(batch.SummaryJson) : {}
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post(
  '/agents/migration/batches/:batchId/payables-csv',
  authorizeMigration,
  payablesCsvUpload.single('file'),
  async (req, res) => {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({ success: false, message: 'Payables CSV file is required' });
      }
      const batch = await agentMigration.getBatch(req.params.batchId);
      if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });

      const data = await e123PayablesSnapshot.importPayablesFromUpload({
        instanceId: batch.InstanceId,
        buffer: req.file.buffer,
        fileName: req.file.originalname || null,
        uploadedBy: req.user?.UserId || null
      });
      res.json({ success: true, data, message: 'Payables staged on migration instance (upload via Migration Hub going forward).' });
    } catch (err) {
      res.status(err.status || 500).json({
        success: false,
        message: err.message,
        code: err.code || undefined
      });
    }
  }
);

router.post(
  '/agents/migration/batches/:batchId/commission-roster',
  authorizeMigration,
  payablesCsvUpload.single('file'),
  async (req, res) => {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({ success: false, message: 'Commission roster file is required' });
      }
      const batch = await agentMigration.getBatch(req.params.batchId);
      if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });

      const tenantId = req.body?.tenantId || batch.TenantId;
      if (tenantId) assertTenantInScope(req, tenantId);

      const data = await agentMigration.uploadCommissionRoster(req.params.batchId, {
        buffer: req.file.buffer,
        fileName: req.file.originalname || null,
        tenantId
      });
      res.json({
        success: true,
        data,
        message: `Commission roster loaded (${data.matchedCount}/${data.rowCount} agents matched). Rebuild tree preview to apply.`
      });
    } catch (err) {
      res.status(err.status || 500).json({
        success: false,
        message: err.message,
        code: err.code || undefined
      });
    }
  }
);

router.get('/agents/migration/tenants/:tenantId/commission-groups', authorizeMigration, async (req, res) => {
  try {
    assertTenantInScope(req, req.params.tenantId);
    const groups = await agentMigration.listCommissionGroupsForTenant(req.params.tenantId);
    res.json({ success: true, data: groups });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.patch('/agents/migration/batches/:batchId', authorizeMigration, async (req, res) => {
  try {
    const existing = await agentMigration.getBatch(req.params.batchId);
    if (!existing) return res.status(404).json({ success: false, message: 'Batch not found' });

    const tenantId = req.body?.tenantId ?? undefined;
    if (tenantId) assertTenantInScope(req, tenantId);

    const updated = await agentMigration.patchBatch(req.params.batchId, {
      tenantId,
      agencyId: req.body?.agencyId,
      wizardStep: req.body?.wizardStep,
      draftJson: req.body?.draftJson,
      rootAgentLabel: req.body?.rootAgentLabel,
      status: req.body?.status
    });

    res.json({
      success: true,
      data: {
        batchId: updated.BatchId,
        tenantId: updated.TenantId,
        agencyId: updated.AgencyId,
        wizardStep: updated.WizardStep,
        status: updated.Status
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.get('/agents/migration/tenants/:tenantId/agencies', authorizeMigration, async (req, res) => {
  try {
    assertTenantInScope(req, req.params.tenantId);
    const agencies = await agentMigration.listAgenciesForTenant(req.params.tenantId);
    res.json({ success: true, data: agencies });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.get('/agents/migration/tenants/:tenantId/commission-levels', authorizeMigration, async (req, res) => {
  try {
    assertTenantInScope(req, req.params.tenantId);
    const tenantId = req.params.tenantId;
    const rawLevels = await CommissionLevelService.listTenantLevels(tenantId);
    const flags = await CommissionLevelService.getTenantFlags(tenantId);

    const levels = (rawLevels || []).map((row) => ({
      commissionLevelId: row.CommissionLevelId,
      displayName: row.DisplayName,
      sortOrder: Number(row.SortOrder),
      legacyTierLevel: row.LegacyTierLevel != null ? Number(row.LegacyTierLevel) : null,
      isSystemSeeded: !!row.IsSystemSeeded,
      isActive: !!row.IsActive
    }));

    let effectiveLevels = levels;
    if (flags.useCustomCommissionLevelsOnly) {
      const customOnly = levels.filter((row) => !row.isSystemSeeded);
      if (customOnly.length > 0) effectiveLevels = customOnly;
    }

    res.json({
      success: true,
      data: effectiveLevels,
      meta: {
        useCustomCommissionLevelsOnly: flags.useCustomCommissionLevelsOnly,
        commissionLevelsHybridEnabled: flags.commissionLevelsHybridEnabled,
        totalLevelCount: levels.length,
        effectiveLevelCount: effectiveLevels.length
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/agents/migration/batches/:batchId/build-workspace', authorizeMigration, async (req, res) => {
  try {
    const batch = await agentMigration.getBatch(req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });

    const result = await agentMigrationWorkspaceJob.startWorkspaceBuild(req.params.batchId, {
      force: req.body?.force === true
    });

    const status = await agentMigrationWorkspaceJob.getWorkspaceBuildStatus(req.params.batchId);
    res.json({
      success: true,
      data: {
        started: result.started,
        cached: result.cached,
        ...status
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.get('/agents/migration/batches/:batchId/workspace-status', authorizeMigration, async (req, res) => {
  try {
    const status = await agentMigrationWorkspaceJob.getWorkspaceBuildStatus(req.params.batchId);
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.get('/agents/migration/workspace', authorizeMigration, async (req, res) => {
  try {
    const batchId = req.query?.batchId;
    if (!batchId) {
      return res.status(400).json({ success: false, message: 'batchId query is required' });
    }
    const status = await agentMigrationWorkspaceJob.getWorkspaceBuildStatus(batchId);
    if (status.status === 'ready' && status.workspace) {
      return res.json({ success: true, data: status.workspace });
    }
    if (status.status === 'building') {
      return res.status(202).json({
        success: true,
        data: { building: true, progress: status.progress }
      });
    }
    const workspace = await agentMigration.buildAgentMigrationWorkspace(batchId, { enrichProfiles: false });
    res.json({ success: true, data: workspace });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/agents/migration/preview', authorizeMigration, async (req, res) => {
  try {
    const batchId = req.body?.batchId;
    if (!batchId) {
      return res.status(400).json({ success: false, message: 'batchId is required' });
    }
    const data = await agentMigration.previewAgentMigration(batchId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/agents/migration/apply', authorizeMigration, async (req, res) => {
  try {
    const batchId = req.body?.batchId;
    if (!batchId) {
      return res.status(400).json({ success: false, message: 'batchId is required' });
    }
    const achByBrokerId = req.body?.achByBrokerId || {};
    const data = await agentMigration.applyAgentMigration(batchId, {
      createdBy: req.user?.UserId || null,
      achByBrokerId
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Group migration wizard
// ---------------------------------------------------------------------------

router.get('/groups/migration/prereqs', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req) || req.query?.instanceId;
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'instanceId is required' });
    }
    assertInstanceInScope(req, instanceId);
    const data = await groupMigration.getPrerequisites(instanceId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/groups/migration/batches', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req) || req.body?.instanceId;
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'instanceId is required' });
    }
    assertInstanceInScope(req, instanceId);

    const tenantId = req.body?.tenantId || null;
    if (tenantId) assertTenantInScope(req, tenantId);

    const batch = await groupMigration.createBatch({
      instanceId,
      tenantId,
      rootBrokerId: req.body?.rootBrokerId,
      rootAgentLabel: req.body?.rootAgentLabel || null,
      includeDownline: req.body?.includeDownline !== false,
      createdBy: req.user?.UserId || null
    });
    res.status(201).json({ success: true, data: groupMigration.mapBatchRow(batch) });
  } catch (err) {
    const status = err.status || (err.code === 'GROUPS_LIST_NOT_STAGED' || err.code === 'AGENT_MAP_REQUIRED' || err.code === 'AGENT_TREE_NOT_STAGED' ? 400 : 500);
    res.status(status).json({ success: false, message: err.message, code: err.code || undefined });
  }
});

router.get('/groups/migration/batches/:batchId', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertGroupBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Group migration batch not found' });
    res.json({ success: true, data: groupMigration.mapBatchRow(batch) });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.patch('/groups/migration/batches/:batchId', authorizeMigration, async (req, res) => {
  try {
    const existing = await assertGroupBatchInScope(req, req.params.batchId);
    if (!existing) return res.status(404).json({ success: false, message: 'Group migration batch not found' });

    const tenantId = req.body?.tenantId ?? undefined;
    if (tenantId) assertTenantInScope(req, tenantId);

    const updated = await groupMigration.patchBatch(req.params.batchId, {
      tenantId,
      rootBrokerId: req.body?.rootBrokerId,
      rootAgentLabel: req.body?.rootAgentLabel,
      includeDownline: req.body?.includeDownline,
      wizardStep: req.body?.wizardStep,
      draftJson: req.body?.draftJson,
      status: req.body?.status
    });
    res.json({ success: true, data: groupMigration.mapBatchRow(updated) });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/groups/migration/batches/:batchId/detect', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertGroupBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Group migration batch not found' });

    const data = await groupMigration.detectGroups({
      instanceId: batch.InstanceId,
      batchId: req.params.batchId
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || (err.code === 'GROUPS_LIST_NOT_STAGED' ? 400 : 500);
    res.status(status).json({ success: false, message: err.message, code: err.code || undefined });
  }
});

router.get('/groups/migration/batches/:batchId/preview', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertGroupBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Group migration batch not found' });

    const data = await groupMigration.previewGroupMigrationBatch({ batchId: req.params.batchId });
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.get('/groups/migration/batches/:batchId/preview/:e123BrokerId', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertGroupBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Group migration batch not found' });

    const e123BrokerId = Number(req.params.e123BrokerId);
    if (!Number.isFinite(e123BrokerId) || e123BrokerId <= 0) {
      return res.status(400).json({ success: false, message: 'Valid e123BrokerId is required' });
    }

    const data = await groupMigration.previewMembers({
      instanceId: batch.InstanceId,
      e123BrokerId,
      tenantId: batch.TenantId
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/groups/migration/batches/:batchId/apply', authorizeMigration, async (req, res) => {
  try {
    const batch = await assertGroupBatchInScope(req, req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Group migration batch not found' });

    const groups = req.body?.groups;
    if (!Array.isArray(groups) || !groups.length) {
      return res.status(400).json({ success: false, message: 'groups[] array is required' });
    }

    const data = await groupMigration.applyGroupMigration({
      batchId: req.params.batchId,
      groups,
      createdBy: req.user?.UserId || null
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.get('/agents/migration/bank-accounts/:e123BrokerId', authorizeMigration, async (req, res) => {
  try {
    const instanceId = effectiveInstanceId(req) || req.query?.instanceId;
    if (!instanceId) {
      return res.status(400).json({ success: false, message: 'instanceId is required' });
    }
    assertInstanceInScope(req, instanceId);

    const brokerId = Number(req.params.e123BrokerId);
    const data = await agentMigration.fetchAchForBroker(instanceId, brokerId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

module.exports = router;
