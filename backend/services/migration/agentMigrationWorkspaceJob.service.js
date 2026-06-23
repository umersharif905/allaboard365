'use strict';

const agentMigration = require('./agentMigration.service');

const activeJobs = new Map();

function logWorkspace(batchId, message, extra = '') {
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[agent-migration-workspace ${batchId}] ${message}${suffix}`);
}

function getWorkspaceBuildFromSummary(batch) {
  const summary = agentMigration.parseJsonSafe(batch?.SummaryJson, {}) || {};
  return summary.workspaceBuild || null;
}

function getBuildStatus(batch) {
  const build = getWorkspaceBuildFromSummary(batch);
  const batchStatus = batch?.Status;

  if (build?.phase === 'complete' && build?.result) {
    return {
      status: 'ready',
      progress: build.progress || null,
      workspace: build.result,
      error: null
    };
  }
  if (build?.phase === 'failed' || batchStatus === 'failed') {
    return {
      status: 'failed',
      progress: build?.progress || null,
      workspace: null,
      error: build?.error || 'Workspace build failed'
    };
  }
  if (batchStatus === 'building_workspace' || build?.phase) {
    return {
      status: 'building',
      progress: build?.progress || { phase: 'starting', processed: 0, total: 0 },
      workspace: null,
      error: null
    };
  }
  return {
    status: 'idle',
    progress: null,
    workspace: null,
    error: null
  };
}

async function startWorkspaceBuild(batchId, { force = false } = {}) {
  const batch = await agentMigration.getBatch(batchId);
  if (!batch) {
    const err = new Error('Agent import batch not found');
    err.status = 404;
    throw err;
  }
  if (!batch.TenantId) {
    const err = new Error('TenantId is required before building workspace');
    err.status = 400;
    throw err;
  }

  const existing = getWorkspaceBuildFromSummary(batch);
  if (!force && existing?.phase === 'complete' && existing?.result) {
    logWorkspace(batchId, 'using cached workspace', `brokers=${existing.result?.brokers?.length || 0}`);
    return { started: false, cached: true };
  }

  if (activeJobs.has(batchId)) {
    logWorkspace(batchId, 'build already in progress');
    return { started: false, cached: false };
  }

  await agentMigration.mergeBatchSummaryJson(batchId, (cur) => ({
    ...cur,
    workspaceBuild: {
      phase: 'starting',
      progress: {
        phase: 'starting',
        processed: 0,
        total: 0,
        currentLabel: null,
        currentBrokerId: null,
        startedUtc: new Date().toISOString(),
        updatedUtc: new Date().toISOString()
      },
      result: null,
      error: null
    }
  }));

  await agentMigration.patchBatch(batchId, { status: 'building_workspace' });
  logWorkspace(batchId, 'job started', `tenant=${batch.TenantId} rootBroker=${batch.RootBrokerId}`);

  const jobPromise = (async () => {
    try {
      const workspace = await agentMigration.buildAgentMigrationWorkspace(batchId, {
        enrichProfiles: true,
        onProgress: (progress) => agentMigration.reportWorkspaceBuildProgress(batchId, progress)
      });

      const freshBatch = await agentMigration.getBatch(batchId);
      const importSettingsKey = agentMigration.draftWorkspaceCacheKey(
        freshBatch?.DraftJson ? JSON.parse(freshBatch.DraftJson) : {}
      );

      await agentMigration.mergeBatchSummaryJson(batchId, (cur) => ({
        ...cur,
        workspaceBuild: {
          phase: 'complete',
          progress: {
            phase: 'complete',
            processed: workspace.brokers?.length || 0,
            total: workspace.brokers?.length || 0,
            updatedUtc: new Date().toISOString()
          },
          result: workspace,
          error: null,
          importSettingsKey,
          completedUtc: new Date().toISOString()
        }
      }));

      await agentMigration.patchBatch(batchId, { status: 'ready' });
      logWorkspace(
        batchId,
        'job complete',
        `brokers=${workspace.brokers?.length || 0} create=${workspace.validation?.createCount || 0}`
      );
    } catch (err) {
      logWorkspace(batchId, 'job failed', err.message);
      await agentMigration.mergeBatchSummaryJson(batchId, (cur) => ({
        ...cur,
        workspaceBuild: {
          ...(cur.workspaceBuild || {}),
          phase: 'failed',
          error: err.message || String(err),
          progress: {
            ...(cur.workspaceBuild?.progress || {}),
            phase: 'failed',
            updatedUtc: new Date().toISOString()
          }
        }
      }));
      await agentMigration.patchBatch(batchId, { status: 'failed' });
      throw err;
    } finally {
      activeJobs.delete(batchId);
    }
  })();

  activeJobs.set(batchId, jobPromise);
  jobPromise.catch(() => {});

  return { started: true, cached: false };
}

async function getWorkspaceBuildStatus(batchId) {
  const batch = await agentMigration.getBatch(batchId);
  if (!batch) {
    const err = new Error('Agent import batch not found');
    err.status = 404;
    throw err;
  }
  return getBuildStatus(batch);
}

module.exports = {
  startWorkspaceBuild,
  getWorkspaceBuildStatus,
  getBuildStatus,
  logWorkspace
};
