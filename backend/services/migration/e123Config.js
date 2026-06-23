'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const migrationInstance = require('./migrationInstance.service');

const e123ConfigStore = new AsyncLocalStorage();

function runWithE123Config(config, fn) {
  return e123ConfigStore.run(config || null, fn);
}

async function runWithInstanceE123Config(instanceId, fn) {
  if (instanceId) {
    const creds = await migrationInstance.resolveCredentials(instanceId);
    if (creds?.username && creds?.password) {
      const config = { ...creds, instanceId };
      if (!config.orgBrokerId) {
        const orgBrokerDiscovery = require('./orgBrokerDiscovery.service');
        orgBrokerDiscovery.ensureOrgBrokerDiscovery(instanceId);
      }
      return runWithE123Config(config, fn);
    }
  }
  return fn();
}

function getActiveE123Override() {
  return e123ConfigStore.getStore() || null;
}

function getE123MemberSearchConfig() {
  const override = getActiveE123Override();
  if (override?.corpid && override?.username && override?.password) {
    return {
      url: process.env.E123_USER_GETALL_URL || 'https://www.enrollment123.com/api/user.getall/',
      corpid: override.corpid,
      username: override.username,
      password: override.password
    };
  }
  return {
    url: process.env.E123_USER_GETALL_URL || 'https://www.enrollment123.com/api/user.getall/',
    corpid: process.env.E123_CORPID || '',
    username: process.env.E123_USERNAME || '',
    password: process.env.E123_PASSWORD || ''
  };
}

function getE123AdminV2Config() {
  const member = getE123MemberSearchConfig();
  return {
    baseUrl: (process.env.E123_ADMIN_V2_BASE || 'https://api.1administration.com/v2').replace(/\/$/, ''),
    username: member.username,
    password: member.password
  };
}

function assertMemberSearchConfigured() {
  const cfg = getE123MemberSearchConfig();
  if (!cfg.corpid || !cfg.username || !cfg.password) {
    const err = new Error(
      'E123 member search is not configured. Add credentials to the migration instance or set E123_CORPID, E123_USERNAME, and E123_PASSWORD in backend/.env'
    );
    err.code = 'E123_NOT_CONFIGURED';
    throw err;
  }
  return cfg;
}

function assertAdminV2Configured() {
  const cfg = getE123AdminV2Config();
  if (!cfg.username || !cfg.password) {
    const err = new Error(
      'E123 Admin v2 is not configured. Add credentials to the migration instance or set E123_USERNAME and E123_PASSWORD in backend/.env'
    );
    err.code = 'E123_NOT_CONFIGURED';
    throw err;
  }
  return cfg;
}

function getE123OrgBrokerId() {
  const override = getActiveE123Override();
  if (override?.orgBrokerId) {
    const id = Number(override.orgBrokerId);
    return Number.isFinite(id) && id > 0 ? id : null;
  }
  if (override?.instanceId) {
    const orgBrokerDiscovery = require('./orgBrokerDiscovery.service');
    const discovered = orgBrokerDiscovery.getDiscoveredOrgBrokerId(override.instanceId);
    if (discovered) return discovered;
  }
  const raw = process.env.E123_ORG_BROKER_ID;
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function getE123OrgBrokerLabelOverride() {
  const override = getActiveE123Override();
  if (override?.orgBrokerLabel) return String(override.orgBrokerLabel).trim();
  const label = process.env.E123_ORG_BROKER_LABEL;
  return label ? String(label).trim() : null;
}

function assertOrgBrokerConfigured() {
  const id = getE123OrgBrokerId();
  if (!id) {
    const err = new Error(
      'E123 org broker is not configured. Set org broker on the migration instance or E123_ORG_BROKER_ID in backend/.env'
    );
    err.code = 'E123_ORG_BROKER_NOT_CONFIGURED';
    throw err;
  }
  return id;
}

module.exports = {
  runWithE123Config,
  runWithInstanceE123Config,
  getActiveE123Override,
  getE123MemberSearchConfig,
  getE123AdminV2Config,
  getE123OrgBrokerId,
  getE123OrgBrokerLabelOverride,
  assertMemberSearchConfigured,
  assertAdminV2Configured,
  assertOrgBrokerConfigured
};
