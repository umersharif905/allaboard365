'use strict';

const axios = require('axios');
const { assertAdminV2Configured } = require('./e123Config');

const E123_AGENT_HTTP_TIMEOUT_MS = 3 * 60 * 1000;

function pickField(obj, ...keys) {
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== '') return obj[key];
    const upper = key.toUpperCase();
    if (obj[upper] != null && obj[upper] !== '') return obj[upper];
    const lower = key.toLowerCase();
    if (obj[lower] != null && obj[lower] !== '') return obj[lower];
  }
  return null;
}

function normalizeAchBankRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const payType = String(pickField(raw, 'paytype', 'PAYTYPE') || '').toUpperCase();
  if (payType && payType !== 'ACH') return null;

  const routingNumber = String(pickField(raw, 'routingnumber', 'ROUTINGNUMBER') || '').replace(/\D/g, '');
  const accountNumber = String(pickField(raw, 'accountnumber', 'ACCOUNTNUMBER') || '').replace(/\D/g, '');
  if (!routingNumber || !accountNumber) return null;

  const accountTypeRaw = String(pickField(raw, 'accounttype', 'ACCOUNTTYPE') || 'C').toUpperCase();
  const accountType = accountTypeRaw === 'S' ? 'Savings' : 'Checking';

  return {
    bankName: pickField(raw, 'bankname', 'BANKNAME') || null,
    routingNumber,
    accountNumber,
    accountNumberLast4: pickField(raw, 'accountnumberlast4', 'ACCOUNTNUMBERLAST4')
      || accountNumber.slice(-4),
    accountType,
    accountName: pickField(raw, 'name', 'NAME', 'signaturename', 'SIGNATURENAME') || null,
    bankAccountId: Number(pickField(raw, 'id', 'ID')) || null,
    payType: 'ACH',
    source: 'e123'
  };
}

function extractBankAccountIdsFromAgentProfile(raw) {
  const ids = new Set();
  if (!raw || typeof raw !== 'object') return ids;

  const candidates = [
    raw.bankaccounts,
    raw.bankAccounts,
    raw.BANKACCOUNTS,
    raw.bank_accounts
  ];
  for (const block of candidates) {
    if (!block) continue;
    if (Array.isArray(block)) {
      for (const item of block) {
        const id = Number(pickField(item, 'id', 'ID'));
        if (Number.isFinite(id) && id > 0) ids.add(id);
      }
      continue;
    }
    if (typeof block === 'object') {
      const count = Number(pickField(block, 'count', 'COUNT')) || 0;
      const url = pickField(block, 'url', 'URL');
      if (count === 1) ids.add(1);
      if (url && typeof url === 'string') {
        const matches = url.match(/bankaccounts\/(\d+)/gi) || [];
        for (const m of matches) {
          const id = Number(m.replace(/\D/g, ''));
          if (Number.isFinite(id) && id > 0) ids.add(id);
        }
      }
    }
  }

  const directId = Number(pickField(raw, 'bankaccountid', 'BANKACCOUNTID', 'defaultBankAccountId'));
  if (Number.isFinite(directId) && directId > 0) ids.add(directId);

  return ids;
}

async function fetchBankAccountById(agentId, bankAccountId) {
  const cfg = assertAdminV2Configured();
  const url = `${cfg.baseUrl}/agents/${encodeURIComponent(agentId)}/bankaccounts/${encodeURIComponent(bankAccountId)}`;
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');

  const response = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    timeout: E123_AGENT_HTTP_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 500
  });

  if (response.status === 404) return null;
  if (response.status >= 400) {
    const err = new Error(`E123 bank account lookup failed (${response.status})`);
    err.status = response.status;
    throw err;
  }

  return normalizeAchBankRecord(response.data);
}

async function fetchAgentProfileRaw(agentId) {
  const cfg = assertAdminV2Configured();
  const url = `${cfg.baseUrl}/agents/${encodeURIComponent(agentId)}`;
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');

  const response = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    timeout: E123_AGENT_HTTP_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 500
  });

  if (response.status === 404) return null;
  if (response.status >= 400) {
    throw new Error(`E123 agent lookup failed (${response.status})`);
  }
  return response.data;
}

/**
 * Discover and fetch the first usable ACH bank account for an E123 broker.
 * Returns { available, ach, reason } — never throws for missing ACH.
 */
async function fetchAgentAchBankInfo(e123BrokerId) {
  const brokerId = Number(e123BrokerId);
  if (!Number.isFinite(brokerId) || brokerId <= 0) {
    return { available: false, ach: null, reason: 'invalid_broker_id' };
  }

  try {
    const profile = await fetchAgentProfileRaw(brokerId);
    if (!profile) {
      return { available: false, ach: null, reason: 'agent_not_found' };
    }

    const discoveredIds = extractBankAccountIdsFromAgentProfile(profile);
    const probeIds = [...discoveredIds, 1, brokerId].filter((id, idx, arr) => arr.indexOf(id) === idx);

    for (const bankAccountId of probeIds) {
      try {
        const ach = await fetchBankAccountById(brokerId, bankAccountId);
        if (ach) {
          return { available: true, ach, reason: null, bankAccountId };
        }
      } catch {
        // try next id
      }
    }

    return { available: false, ach: null, reason: 'no_ach_account_found' };
  } catch (err) {
    return {
      available: false,
      ach: null,
      reason: err.message || 'e123_bank_fetch_failed'
    };
  }
}

module.exports = {
  fetchAgentAchBankInfo,
  fetchBankAccountById,
  normalizeAchBankRecord,
  extractBankAccountIdsFromAgentProfile
};
