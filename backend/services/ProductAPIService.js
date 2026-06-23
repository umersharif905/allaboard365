/**
 * ProductAPIService - Calls external product APIs (e.g. Lyric telehealth) for enrollment sync and deactivation.
 * Uses config from oe.ProductAPIConfigs; stores results in oe.Enrollments (ExternalAPISyncedAt, ExternalAPIResponseJson, etc.)
 */
const axios = require('axios');
const { getLyricStateId } = require('../constants/lyricStates');

/** Sanitize headers for logging (truncate tokens/keys) */
function sanitizeHeadersForLog(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const out = { ...headers };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (typeof v === 'string' && (k.toLowerCase().includes('auth') || k.toLowerCase().includes('key'))) {
      out[k] = v.length > 20 ? `${v.slice(0, 8)}...${v.slice(-4)}` : '***';
    }
  }
  return out;
}

function logProductAPIRequest(label, method, url, headers, body, contentType) {
  const bodyLog = body && typeof body === 'object' ? { ...body } : body;
  console.log(`[ProductAPI] ${label} REQUEST:`, {
    method,
    url,
    contentType: contentType || 'application/json',
    headers: sanitizeHeadersForLog(headers),
    body: bodyLog
  });
}

function logProductAPIResponse(label, status, statusText, data) {
  console.log(`[ProductAPI] ${label} RESPONSE:`, { status, statusText, data });
}

/** Resolve ${VAR} in value from process.env */
function resolveEnvVars(val) {
  if (typeof val !== 'string') return val;
  return val.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name?.trim()] ?? '');
}

/** Token cache: key -> { token, expiresAt } */
const authTokenCache = new Map();
const CACHE_TTL_MS = 23 * 60 * 60 * 1000; // 23 hours

/** Build axios config for API request with proper body encoding */
function buildRequestConfig(method, url, headers, body, contentType) {
  const axiosConfig = {
    method,
    url,
    headers: { ...headers },
    timeout: 30000,
    validateStatus: () => true
  };
  if (method !== 'GET' && body && typeof body === 'object' && Object.keys(body).length > 0) {
    if (contentType === 'multipart/form-data') {
      const FormData = require('form-data');
      const form = new FormData();
      for (const [k, v] of Object.entries(body)) {
        form.append(k, String(v ?? ''));
      }
      axiosConfig.data = form;
      Object.assign(axiosConfig.headers, form.getHeaders());
    } else if (contentType === 'application/x-www-form-urlencoded') {
      axiosConfig.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      axiosConfig.data = new URLSearchParams(body).toString();
    } else {
      axiosConfig.headers['Content-Type'] = 'application/json';
      axiosConfig.data = body;
    }
  } else if (contentType !== 'multipart/form-data') {
    axiosConfig.headers['Content-Type'] = contentType;
  }
  return axiosConfig;
}

/** Lyric planDetailsId: EE→1, ES→2, EC/EF→3 (family size) */
function familySizeIdFromTier(tier) {
  const t = (tier || '').toUpperCase();
  if (t === 'EE') return '1';
  if (t === 'ES') return '2';
  if (t === 'EC' || t === 'EF') return '3';
  return '1';
}

/** Format date to MM/DD/YYYY for Lyric and similar APIs */
function formatDateMMDDYYYY(val) {
  if (!val) return '';
  const d = typeof val === 'string' ? new Date(val) : val;
  if (isNaN(d.getTime())) return String(val);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const y = d.getFullYear();
  return `${m.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}/${y}`;
}

/** Normalize gender to Lyric format: m, f, u */
function normalizeGender(val) {
  const v = (val || '').toString().toUpperCase();
  if (v === 'M' || v === 'MALE') return 'm';
  if (v === 'F' || v === 'FEMALE') return 'f';
  return 'u';
}

const PREFILL_MAP = {
  memberEmail: (ctx) => ctx.member?.Email || ctx.member?.email || '',
  memberPhoneNumber: (ctx) => ctx.member?.PhoneNumber || ctx.member?.phoneNumber || '',
  householdMemberID: (ctx) => ctx.member?.HouseholdMemberID || ctx.member?.HouseholdMemberId || '',
  memberFirstName: (ctx) => ctx.member?.FirstName || ctx.member?.firstName || '',
  memberLastName: (ctx) => ctx.member?.LastName || ctx.member?.lastName || '',
  memberDateOfBirth: (ctx) => formatDateMMDDYYYY(ctx.member?.DateOfBirth || ctx.member?.dateOfBirth),
  memberGender: (ctx) => normalizeGender(ctx.member?.Gender || ctx.member?.gender),
  memberZipCode: (ctx) => ctx.member?.Zip || ctx.member?.zip || ctx.member?.ZipCode || ctx.member?.zipCode || '',
  memberCity: (ctx) => ctx.member?.City || ctx.member?.city || '',
  memberState: (ctx) => ctx.member?.State || ctx.member?.state || '',
  lyricStateId: (ctx) => getLyricStateId(ctx.member?.State || ctx.member?.state),
  memberAddress1: (ctx) => ctx.member?.Address || ctx.member?.address || ctx.member?.Address1 || ctx.member?.address1 || '',
  memberAddress2: (ctx) => ctx.member?.Address2 || ctx.member?.address2 || '',
  familySizeId: (ctx) => familySizeIdFromTier(ctx.member?.Tier),
  householdId: (ctx) => (ctx.member?.HouseholdId || ctx.enrollment?.HouseholdId || '')?.toString?.() || '',
  enrollmentId: (ctx) => (ctx.enrollment?.EnrollmentId || ctx.enrollment?.enrollmentId || '')?.toString?.() || '',
  terminationDate: (ctx) => {
    const raw = ctx.enrollment?.TerminationDate || ctx.enrollment?.terminationDate;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (!raw) return formatDateMMDDYYYY(today);
    const d = typeof raw === 'string' ? new Date(raw) : raw;
    if (isNaN(d.getTime())) return formatDateMMDDYYYY(today);
    d.setHours(0, 0, 0, 0);
    return formatDateMMDDYYYY(d < today ? today : d);
  },
  effectiveDate: (ctx) => {
    const raw = ctx.enrollment?.EffectiveDate || ctx.enrollment?.effectiveDate;
    if (!raw) return '';
    const d = typeof raw === 'string' ? new Date(raw) : raw;
    if (isNaN(d.getTime())) return '';
    return formatDateMMDDYYYY(d);
  }
};

/**
 * Substitute prefill values in headers/body
 * @param {Array<{key:string, value:string, prefill:string|null}>} items
 * @param {Object} ctx - { member, enrollment }
 * @param {Object} opts - { authToken?: string } for authToken prefill
 */
function substitutePrefills(items, ctx, opts = {}) {
  if (!items || !Array.isArray(items)) return {};
  const result = {};
  for (const item of items) {
    const key = item.key || item.Key;
    if (!key) continue;
    let val = item.value || item.Value || '';
    const prefillKey = item.prefill || item.Prefill;
    if (prefillKey === 'authToken' && opts.authToken != null) {
      val = key.toLowerCase() === 'authorization' ? `Bearer ${opts.authToken}` : opts.authToken;
    } else if (prefillKey) {
      const fn = PREFILL_MAP[prefillKey] || (prefillKey === 'memberId' ? PREFILL_MAP.householdMemberID : null);
      if (fn) {
        const resolved = fn(ctx) || '';
        val = resolved || val; // use manual value when prefill resolves empty (e.g. test mode, no member)
      }
    }
    result[key] = val;
  }
  return result;
}

/**
 * Extract token from response using responseMapping
 * @param {Object} response - axios response (headers in response.headers, body in response.data)
 * @param {Object} mapping - { tokenPath: 'headers.Authorization', tokenPrefixStrip: 'Bearer ' }
 * Header keys are matched case-insensitively (HTTP headers vary by server).
 */
function extractToken(response, mapping) {
  if (!mapping || !mapping.tokenPath) return null;
  const parts = mapping.tokenPath.split('.');
  let obj = response;
  if (parts[0] === 'headers') obj = response.headers || {};
  else if (parts[0] === 'data' || parts[0] === 'body') obj = response.data || {};
  for (let i = 1; i < parts.length; i++) {
    const key = parts[i];
    if (parts[0] === 'headers' && obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const lower = String(key).toLowerCase();
      const found = Object.entries(obj).find(([k]) => k.toLowerCase() === lower);
      obj = found ? found[1] : undefined;
    } else {
      obj = obj?.[key];
    }
  }
  if (typeof obj !== 'string') return null;
  const prefix = mapping.tokenPrefixStrip || '';
  return prefix ? obj.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '').trim() : obj;
}

/** Fetch auth token from auth step config */
async function fetchAuthToken(authStep) {
  if (!authStep?.enabled || !authStep?.endpoint) {
    throw new Error('Auth step not configured');
  }
  const cacheKey = `${authStep.endpoint}|${JSON.stringify(authStep.body || [])}`;
  const cached = authTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  const bodyObj = {};
  for (const item of authStep.body || []) {
    const k = item.key || item.Key;
    if (k) bodyObj[k] = resolveEnvVars(item.value || item.Value || '');
  }
  const method = (authStep.method || 'POST').toUpperCase();
  const axiosConfig = {
    method,
    url: authStep.endpoint.trim(),
    timeout: 15000,
    validateStatus: () => true
  };
  if (authStep.contentType === 'multipart/form-data') {
    const FormData = require('form-data');
    const form = new FormData();
    for (const [k, v] of Object.entries(bodyObj)) {
      form.append(k, String(v ?? ''));
    }
    axiosConfig.data = form;
    Object.assign(axiosConfig, { headers: form.getHeaders() });
  } else if (authStep.contentType === 'application/x-www-form-urlencoded') {
    axiosConfig.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    axiosConfig.data = new URLSearchParams(bodyObj).toString();
  } else {
    axiosConfig.headers = { 'Content-Type': 'application/json' };
    if (method !== 'GET' && Object.keys(bodyObj).length > 0) {
      axiosConfig.data = bodyObj;
    }
  }
  logProductAPIRequest('AUTH', method, authStep.endpoint.trim(), axiosConfig.headers || {}, bodyObj, authStep.contentType);
  const response = await axios(axiosConfig);
  logProductAPIResponse('AUTH', response.status, response.statusText, response.data);
  if (response.status >= 400) {
    const err = new Error(`Auth step failed: ${response.status} ${response.statusText}`);
    err.responseBody = response.data;
    throw err;
  }
  const mapping = authStep.responseMapping || {};
  const resolvedMapping = {
    tokenPath: mapping.tokenPath || 'headers.Authorization',
    tokenPrefixStrip: mapping.tokenPrefixStrip != null ? mapping.tokenPrefixStrip : 'Bearer '
  };
  const token = extractToken({ headers: response.headers, data: response.data }, resolvedMapping);
  if (!token) {
    throw new Error('Auth step: no token found in response');
  }
  authTokenCache.set(cacheKey, { token, expiresAt: Date.now() + CACHE_TTL_MS });
  return token;
}

/**
 * Call the enrollment API for a product/member
 * @param {Object} params
 * @param {string} params.productId
 * @param {Object} params.member - { MemberId, FirstName, LastName, Email, DateOfBirth, HouseholdId } (from Members + Users)
 * @param {Array} params.householdMembers - optional, for future prefills
 * @param {Object} params.config - enrollment config from ProductAPIConfigs.ConfigJson.enrollment
 * @param {Object} params.fullConfig - full ProductAPIConfig (has authStep)
 * @returns {Promise<{ token?: string, rawResponse?: any, memberId?: string }>}
 */
async function callEnrollmentAPI({ productId, member, householdMembers = [], config, fullConfig }) {
  if (!config || !config.enabled || !config.endpoint) {
    throw new Error('Product API enrollment config missing or disabled');
  }
  const ctx = { member, enrollment: null };
  const needsAuth = (config.headers || []).some((h) => (h.prefill || h.Prefill) === 'authToken') ||
    (config.body || []).some((b) => (b.prefill || b.Prefill) === 'authToken');
  let authToken = null;
  if (needsAuth && fullConfig?.authStep?.enabled) {
    authToken = await fetchAuthToken(fullConfig.authStep);
  } else if (needsAuth) {
    throw new Error('Auth Token prefill used but auth step not configured');
  }
  const headers = substitutePrefills(config.headers || [], ctx, { authToken });
  const body = substitutePrefills(config.body || [], ctx, { authToken });
  const method = (config.method || 'POST').toUpperCase();
  const url = config.endpoint;
  const contentType = config.contentType || 'application/json';

  const axiosConfig = buildRequestConfig(method, url, headers, body, contentType);

  logProductAPIRequest('ENROLLMENT', method, url, axiosConfig.headers, body, contentType);
  const response = await axios(axiosConfig);
  logProductAPIResponse('ENROLLMENT', response.status, response.statusText, response.data);
  if (response.status >= 400) {
    const err = new Error(`Product API enrollment failed: ${response.status} ${response.statusText}`);
    err.responseBody = response.data;
    err.responseStatus = response.status;
    throw err;
  }

  const mapping = config.responseMapping || {};
  const token = extractToken(response, mapping) || extractToken({ headers: response.headers, data: response.data }, mapping);

  const result = { token: token || undefined };
  if (response.data && typeof response.data === 'object') {
    result.rawResponse = response.data;
    if (response.data.memberId) result.memberId = response.data.memberId;
    if (response.data.id) result.memberId = result.memberId || response.data.id;
  }
  return result;
}

/**
 * Call the deactivation API for a terminated enrollment
 * @param {Object} params
 * @param {string} params.productId
 * @param {Object} params.enrollment - { EnrollmentId, MemberId, HouseholdId }
 * @param {Object} params.member
 * @param {Object} params.config - deactivation config from ProductAPIConfigs.ConfigJson.deactivation
 * @param {Object} params.fullConfig - full ProductAPIConfig (has authStep)
 */
async function callDeactivationAPI({ productId, enrollment, member, config, fullConfig }) {
  if (!config || !config.enabled || !config.endpoint) {
    throw new Error('Product API deactivation config missing or disabled');
  }
  const ctx = { member, enrollment };
  const needsAuth = (config.headers || []).some((h) => (h.prefill || h.Prefill) === 'authToken') ||
    (config.body || []).some((b) => (b.prefill || b.Prefill) === 'authToken');
  let authToken = null;
  if (needsAuth && fullConfig?.authStep?.enabled) {
    authToken = await fetchAuthToken(fullConfig.authStep);
  } else if (needsAuth) {
    throw new Error('Auth Token prefill used but auth step not configured');
  }
  const headers = substitutePrefills(config.headers || [], ctx, { authToken });
  const body = substitutePrefills(config.body || [], ctx, { authToken });
  const method = (config.method || 'POST').toUpperCase();
  const url = config.endpoint;
  const contentType = config.contentType || 'application/json';

  const axiosConfig = buildRequestConfig(method, url, headers, body, contentType);

  logProductAPIRequest('DEACTIVATION', method, url, axiosConfig.headers, body, contentType);
  const response = await axios(axiosConfig);
  logProductAPIResponse('DEACTIVATION', response.status, response.statusText, response.data);
  if (response.status >= 400) {
    const err = new Error(`Product API deactivation failed: ${response.status} ${response.statusText}`);
    err.responseBody = response.data;
    err.responseStatus = response.status;
    throw err;
  }
  return { success: true };
}

/**
 * Call the update API for an existing synced member (e.g. Lyric updateMember)
 * @param {Object} params
 * @param {string} params.productId
 * @param {Object} params.member - from Members + Users
 * @param {Object} params.enrollment - { EnrollmentId, MemberId, HouseholdId, TerminationDate }
 * @param {Object} params.config - update config from ProductAPIConfigs.ConfigJson.update
 * @param {Object} params.fullConfig - full ProductAPIConfig (has authStep)
 * @returns {Promise<{ rawResponse?: any }>}
 */
async function callUpdateAPI({ productId, member, enrollment, config, fullConfig }) {
  if (!config || !config.enabled || !config.endpoint) {
    throw new Error('Product API update config missing or disabled');
  }
  const ctx = { member, enrollment };
  const needsAuth = (config.headers || []).some((h) => (h.prefill || h.Prefill) === 'authToken') ||
    (config.body || []).some((b) => (b.prefill || b.Prefill) === 'authToken');
  let authToken = null;
  if (needsAuth && fullConfig?.authStep?.enabled) {
    authToken = await fetchAuthToken(fullConfig.authStep);
  } else if (needsAuth) {
    throw new Error('Auth Token prefill used but auth step not configured');
  }
  const headers = substitutePrefills(config.headers || [], ctx, { authToken });
  const body = substitutePrefills(config.body || [], ctx, { authToken });
  const method = (config.method || 'POST').toUpperCase();
  const url = config.endpoint;
  const contentType = config.contentType || 'application/json';

  const axiosConfig = buildRequestConfig(method, url, headers, body, contentType);

  logProductAPIRequest('UPDATE', method, url, axiosConfig.headers, body, contentType);
  const response = await axios(axiosConfig);
  logProductAPIResponse('UPDATE', response.status, response.statusText, response.data);
  if (response.status >= 400) {
    const err = new Error(`Product API update failed: ${response.status} ${response.statusText}`);
    err.responseBody = response.data;
    err.responseStatus = response.status;
    throw err;
  }
  const result = {};
  if (response.data && typeof response.data === 'object') {
    result.rawResponse = response.data;
  }
  return result;
}

module.exports = {
  callEnrollmentAPI,
  callDeactivationAPI,
  callUpdateAPI,
  fetchAuthToken,
  substitutePrefills,
  logProductAPIRequest,
  logProductAPIResponse,
  extractToken
};
