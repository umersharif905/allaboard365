'use strict';

const migrationInstance = require('./migrationInstance.service');
const { runWithE123Config } = require('./e123Config');
const { resolveOrgBrokerId } = require('./orgBrokerResolver.service');

const stateByKey = new Map();

function instanceKey(instanceId) {
  return String(instanceId || 'default');
}

function getState(instanceId) {
  return stateByKey.get(instanceKey(instanceId)) || null;
}

function getDiscoveredOrgBrokerId(instanceId) {
  const id = getState(instanceId)?.id;
  return Number.isFinite(id) && id > 0 ? id : null;
}

function isOrgBrokerDiscoveryPending(instanceId) {
  return !!getState(instanceId)?.promise;
}

function getOrgBrokerDiscoveryError(instanceId) {
  return getState(instanceId)?.error || null;
}

function ensureOrgBrokerDiscovery(instanceId) {
  if (!instanceId) return Promise.resolve(null);

  const key = instanceKey(instanceId);
  const existing = stateByKey.get(key);
  if (existing?.id) return Promise.resolve(existing.id);
  if (existing?.promise) return existing.promise;

  const state = {};
  state.promise = migrationInstance.resolveCredentials(instanceId)
    .then(async (creds) => {
      if (!creds?.username || !creds?.password) {
        state.error = 'E123 credentials missing on migration instance';
        return null;
      }
      return runWithE123Config({ ...creds, instanceId }, () => resolveOrgBrokerId());
    })
    .then((id) => {
      state.id = Number.isFinite(id) && id > 0 ? id : null;
      if (!state.id && !state.error) {
        state.error = 'Could not discover org broker from E123';
      }
      delete state.promise;
      if (state.id) {
        console.log('[org-broker-discovery] resolved org broker', { instanceId, orgBrokerId: state.id });
      } else {
        console.warn('[org-broker-discovery] failed', { instanceId, error: state.error });
      }
      return state.id;
    })
    .catch((err) => {
      state.error = err?.message || String(err);
      delete state.promise;
      console.warn('[org-broker-discovery] error', { instanceId, error: state.error });
      return null;
    });

  stateByKey.set(key, state);
  return state.promise;
}

module.exports = {
  ensureOrgBrokerDiscovery,
  getDiscoveredOrgBrokerId,
  isOrgBrokerDiscoveryPending,
  getOrgBrokerDiscoveryError
};
