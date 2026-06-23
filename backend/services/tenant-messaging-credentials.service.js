'use strict';

const { getPool, sql } = require('../config/database');
const {
  isTenantEmailSendReady,
  platformDefaultFromEmail,
} = require('../utils/tenantEmailFrom');

const MIGHTYWELL_NAME = 'MightyWELL Health';

let defaultTenantIdCache = null;
let defaultTenantMessagingCache = null;
const tenantMessagingCache = new Map();

function parseAdvancedSettings(raw) {
  if (!raw) return {};
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

function pickMessagingBlock(advanced) {
  const m = advanced?.messaging || {};
  return {
    twilioAccountSid: m.twilioAccountSid || m.twilio?.accountSid || null,
    twilioAuthToken: m.twilioAuthToken || m.twilio?.authToken || null,
    twilioPhoneNumber: m.twilioPhoneNumber || m.twilio?.phoneNumber || null,
    sendgridApiKey: m.sendgridApiKey || m.sendgrid?.apiKey || null,
    defaultFromEmail:
      m.defaultFromEmail || m.email?.defaultFromEmail || platformDefaultFromEmail(),
    smsCustomFromPhone: advanced?.sms?.customFromPhone || null,
    emailCustomFromAddress: isTenantEmailSendReady(advanced?.email)
      ? String(advanced.email.customFromAddress).trim()
      : null,
  };
}

function mergeMessaging(base, overlay) {
  const out = { ...base };
  for (const key of Object.keys(overlay || {})) {
    const v = overlay[key];
    if (v != null && String(v).trim() !== '') {
      out[key] = String(v).trim();
    }
  }
  return out;
}

function envPlatformDefaults() {
  return {
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || null,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || null,
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || null,
    sendgridApiKey: process.env.SENDGRID_API_KEY || null,
    defaultFromEmail: platformDefaultFromEmail(),
    smsCustomFromPhone: null,
    emailCustomFromAddress: null,
  };
}

async function loadTenantMessagingRow(tenantId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TenantId, Name, AdvancedSettings
      FROM oe.Tenants
      WHERE TenantId = @tenantId
    `);
  return result.recordset[0] || null;
}

async function resolveDefaultTenantId() {
  if (defaultTenantIdCache) return defaultTenantIdCache;
  const fromEnv = process.env.PLATFORM_DEFAULT_TENANT_ID || process.env.MIGHTYWELL_TENANT_ID;
  if (fromEnv) {
    defaultTenantIdCache = String(fromEnv).trim();
    return defaultTenantIdCache;
  }
  const pool = await getPool();
  const result = await pool.request()
    .input('name', sql.NVarChar, MIGHTYWELL_NAME)
    .query(`
      SELECT TOP 1 TenantId
      FROM oe.Tenants
      WHERE Name = @name
    `);
  if (result.recordset[0]) {
    defaultTenantIdCache = String(result.recordset[0].TenantId);
  }
  return defaultTenantIdCache;
}

/**
 * MightyWELL / platform defaults: env keys + optional overrides from default tenant AdvancedSettings.
 */
async function getDefaultMessagingCredentials() {
  if (defaultTenantMessagingCache) {
    return { ...defaultTenantMessagingCache };
  }

  let merged = envPlatformDefaults();
  const defaultTenantId = await resolveDefaultTenantId();
  if (defaultTenantId) {
    const row = await loadTenantMessagingRow(defaultTenantId);
    if (row) {
      merged = mergeMessaging(merged, pickMessagingBlock(parseAdvancedSettings(row.AdvancedSettings)));
    }
  }

  defaultTenantMessagingCache = merged;
  return { ...merged };
}

/**
 * Per-tenant credentials: tenant AdvancedSettings.messaging → MightyWELL default → env.
 */
async function getTenantMessagingCredentials(tenantId) {
  if (!tenantId) {
    return getDefaultMessagingCredentials();
  }

  const key = String(tenantId).toLowerCase();
  if (tenantMessagingCache.has(key)) {
    return { ...tenantMessagingCache.get(key) };
  }

  const base = await getDefaultMessagingCredentials();
  const row = await loadTenantMessagingRow(tenantId);
  let merged = base;
  if (row) {
    merged = mergeMessaging(base, pickMessagingBlock(parseAdvancedSettings(row.AdvancedSettings)));
  }

  tenantMessagingCache.set(key, merged);
  return { ...merged };
}

function clearMessagingCredentialsCache() {
  defaultTenantMessagingCache = null;
  tenantMessagingCache.clear();
}

module.exports = {
  getDefaultMessagingCredentials,
  getTenantMessagingCredentials,
  resolveDefaultTenantId,
  clearMessagingCredentialsCache,
  pickMessagingBlock,
};
