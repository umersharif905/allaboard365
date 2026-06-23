'use strict';

const { fetchAllUsersForBroker } = require('./e123Api.service');
const { buildHouseholdsFromE123Pages, computeFetchCoverageStats } = require('./householdNormalizer');
const migrationBatch = require('./migrationBatch.service');
const migrationInstance = require('./migrationInstance.service');
const { runWithE123Config } = require('./e123Config');
const { mergeBatchFetchProgress, parseBatchSummaryJson, getBatchImportSettings } = require('./migrationBatchImportSettings');

const activeFetchJobs = new Map();

function logFetch(batchId, message, extra = '') {
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[migration-fetch ${batchId}] ${message}${suffix}`);
}

async function runFetchJob(batchId) {
  const jobStartedAt = Date.now();
  const batch = await migrationBatch.getBatch(batchId);
  if (!batch) throw new Error('Batch not found');
  if (!batch.RootBrokerId) throw new Error('RootBrokerId is required');

  const logTag = `[batch=${batchId} broker=${batch.RootBrokerId} agent=${batch.RootAgentLabel || '?'}]`;

  logFetch(batchId, 'job started', logTag);

  await migrationBatch.updateBatchWithRetry(batchId, {
    Status: 'fetching',
    FetchError: null,
    FetchPagesCompleted: 0,
    FetchMembersLoaded: 0,
    SummaryJson: mergeBatchFetchProgress(batch?.SummaryJson, {
      phase: 'contacting',
      householdsSaved: 0,
      householdsTotal: 0,
      startedUtc: new Date().toISOString()
    })
  });
  logFetch(batchId, 'status=fetching phase=contacting (awaiting first E123 page)');

  await migrationBatch.clearBatchHouseholds(batchId);

  const executeFetch = async () => {
    let latestSummaryJson = mergeBatchFetchProgress(batch?.SummaryJson, {
      phase: 'contacting',
      householdsSaved: 0,
      householdsTotal: 0
    });

    const e123StartedAt = Date.now();
    logFetch(batchId, 'calling E123 user.getall…');

    const result = await fetchAllUsersForBroker({
      brokerId: batch.RootBrokerId,
      includeDownline: !!batch.IncludeDownline,
      logPrefix: logTag,
      onPage: async (progress) => {
        latestSummaryJson = mergeBatchFetchProgress(latestSummaryJson, {
          phase: 'e123',
          householdsSaved: 0,
          householdsTotal: 0,
          lastPageMs: progress.pageMs
        });
        await migrationBatch.updateBatchWithRetry(batchId, {
          FetchPagesCompleted: progress.pagesCompleted,
          FetchMembersLoaded: progress.membersLoaded,
          FetchLastUserId: progress.lastUserId || null,
          SummaryJson: latestSummaryJson
        });
        logFetch(
          batchId,
          `E123 page ${progress.pagesCompleted} saved to DB`,
          `users=${progress.membersLoaded} (+${progress.usersOnPage} this page, ${progress.pageMs}ms)`
        );
      }
    });

    logFetch(
      batchId,
      `E123 done in ${Date.now() - e123StartedAt}ms`,
      `${result.pagesCompleted} pages, ${result.membersLoaded} raw users`
    );

    const importSettings = getBatchImportSettings(batch);
    const buildStartedAt = Date.now();
    const households = buildHouseholdsFromE123Pages(result, {
      includeTerminatedHouseholds: importSettings.includeTerminatedHouseholds === true
    });
    logFetch(
      batchId,
      `built ${households.length} households in ${Date.now() - buildStartedAt}ms`
    );

    const fetchCoverage = computeFetchCoverageStats(households);

    latestSummaryJson = mergeBatchFetchProgress(latestSummaryJson, {
      phase: 'persisting',
      householdsSaved: 0,
      householdsTotal: households.length
    });
    await migrationBatch.updateBatchWithRetry(batchId, { SummaryJson: latestSummaryJson });
    logFetch(batchId, `persisting ${households.length} households to DB…`);

    const persistStartedAt = Date.now();
    await migrationBatch.insertBatchHouseholds(batchId, households, {
      onProgress: async (saved, total) => {
        latestSummaryJson = mergeBatchFetchProgress(latestSummaryJson, {
          phase: 'persisting',
          householdsSaved: saved,
          householdsTotal: total
        });
        await migrationBatch.updateBatchWithRetry(batchId, { SummaryJson: latestSummaryJson });
        if (saved === total || saved % 200 === 0) {
          logFetch(batchId, `persist progress ${saved}/${total}`);
        }
      }
    });
    logFetch(batchId, `persist done in ${Date.now() - persistStartedAt}ms`);

    await migrationBatch.deselectAlreadyMigratedHouseholds(batchId);
    await migrationBatch.deselectPendingMigrationHouseholds(batchId);
    logFetch(batchId, 'deselect filters applied');

    const readySummary = {
      ...parseBatchSummaryJson(latestSummaryJson),
      fetchCoverage,
      fetchProgress: { phase: 'ready', householdsSaved: households.length, householdsTotal: households.length }
    };
    await migrationBatch.updateBatchWithRetry(batchId, {
      Status: 'ready',
      FetchError: null,
      FetchPagesCompleted: result.pagesCompleted,
      FetchMembersLoaded: households.length,
      WizardStep: 1,
      SummaryJson: JSON.stringify(readySummary)
    });

    logFetch(
      batchId,
      `job complete in ${Date.now() - jobStartedAt}ms`,
      `${households.length} households ready`
    );

    return {
      pagesCompleted: result.pagesCompleted,
      membersLoaded: result.membersLoaded,
      eligibleHouseholds: households.length
    };
  };

  try {
    let fetchResult;
    if (batch.InstanceId) {
      logFetch(batchId, `using migration instance ${batch.InstanceId}`);
      const creds = await migrationInstance.resolveCredentials(batch.InstanceId);
      fetchResult = await runWithE123Config(creds, executeFetch);
    } else {
      fetchResult = await executeFetch();
    }

    return {
      status: 'ready',
      pagesCompleted: fetchResult.pagesCompleted,
      rawUsers: fetchResult.membersLoaded,
      eligibleHouseholds: fetchResult.eligibleHouseholds
    };
  } catch (err) {
    logFetch(batchId, `job FAILED after ${Date.now() - jobStartedAt}ms`, err.message);
    await migrationBatch.updateBatchWithRetry(batchId, {
      Status: 'failed',
      FetchError: err.message,
      SummaryJson: mergeBatchFetchProgress(batch?.SummaryJson, {
        phase: 'failed',
        error: err.message
      })
    });
    throw err;
  } finally {
    activeFetchJobs.delete(batchId);
  }
}

function isFetchJobActive(batchId) {
  return activeFetchJobs.has(batchId);
}

function startFetchJob(batchId) {
  if (activeFetchJobs.has(batchId)) {
    logFetch(batchId, 'start skipped — job already active');
    return activeFetchJobs.get(batchId);
  }
  const promise = runFetchJob(batchId);
  activeFetchJobs.set(batchId, promise);
  return promise;
}

function cancelFetchJob(batchId) {
  activeFetchJobs.delete(batchId);
}

/** Resume fetch when batch is stuck in `fetching` but no in-process job (e.g. server restart). */
function resumeFetchJobIfStale(batchId, batch) {
  if (!batch || batch.Status !== 'fetching') return false;
  if (activeFetchJobs.has(batchId)) return false;
  logFetch(batchId, 'auto-resume — batch fetching but no active job');
  startFetchJob(batchId).catch((err) => {
    console.error('E123 fetch auto-resume failed:', batchId, err.message);
  });
  return true;
}

module.exports = {
  startFetchJob,
  cancelFetchJob,
  runFetchJob,
  isFetchJobActive,
  resumeFetchJobIfStale
};
