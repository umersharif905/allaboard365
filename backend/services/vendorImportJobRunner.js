'use strict';

const { v4: uuidv4 } = require('uuid');

function errorMessageFromUnknown(err, fallback = 'Import failed') {
  if (!err) return fallback;
  if (typeof err === 'string') {
    const t = err.trim();
    return t && t !== '[object Object]' ? t : fallback;
  }
  if (err instanceof Error && typeof err.message === 'string' && err.message.trim()) {
    return err.message.trim() === '[object Object]' ? fallback : err.message.trim();
  }
  if (typeof err === 'object' && typeof err.message === 'string' && err.message.trim()) {
    return err.message.trim();
  }
  try {
    const s = JSON.stringify(err);
    if (s && s !== '{}' && s !== 'null') return s;
  } catch {
    /* ignore */
  }
  return fallback;
}

const jobs = new Map();
const JOB_TTL_MS = 35 * 60 * 1000;

function pruneJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (job.updatedAt < cutoff) jobs.delete(id);
  }
}

function createJob(meta = {}) {
  pruneJobs();
  const jobId = uuidv4();
  const now = Date.now();
  const job = {
    jobId,
    status: 'running',
    phase: 'start',
    message: 'Starting…',
    current: null,
    total: null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    ...meta,
  };
  jobs.set(jobId, job);
  return jobId;
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: Date.now() });
  jobs.set(jobId, job);
  return job;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function runJob(jobId, worker) {
  setImmediate(async () => {
    try {
      const result = await worker((event) => {
        updateJob(jobId, {
          status: 'running',
          phase: event.phase || 'progress',
          message: event.message || '',
          current: event.current ?? null,
          total: event.total ?? null,
        });
        const suffix = event.current != null && event.total != null
          ? ` (${event.current}/${event.total})`
          : '';
        console.log(`[vendor-import-job ${jobId.slice(0, 8)}] ${event.message || event.phase}${suffix}`);
      });
      updateJob(jobId, {
        status: 'done',
        message: 'Complete',
        result,
      });
    } catch (err) {
      const msg = errorMessageFromUnknown(err);
      console.error(`[vendor-import-job ${jobId.slice(0, 8)}] failed:`, msg);
      updateJob(jobId, {
        status: 'error',
        message: msg,
        error: msg,
      });
    }
  });
}

module.exports = {
  createJob,
  updateJob,
  getJob,
  runJob,
};
