'use strict';

const { getE123MemberSearchConfig } = require('./e123Config');

const RATE_API_URL = process.env.E123_RATE_API_URL
  || 'https://www.1administration.com/api/rate/index.cfc';

function parseRateRows(response) {
  const rows = response?.RATES || response?.rates || [];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => {
      const type = String(row.TYPE ?? row.type ?? 'Product').trim().toLowerCase();
      return type === 'product';
    })
    .map((row) => ({
      benefitId: row.BENEFITID != null && row.BENEFITID !== '' ? String(row.BENEFITID) : null,
      benefitLabel: row.BENEFITLABEL ?? row.benefitlabel ?? null,
      rate: Number(row.RATE ?? row.rate) || 0,
      periodLabel: row.PERIODLABEL ?? row.periodlabel ?? null
    }))
    .filter((row) => row.rate > 0);
}

async function callGetRates({ pdid, brokerId, smoker = false, age = 40, state = 'FL', zipcode = '32801' }) {
  const cfg = getE123MemberSearchConfig();
  if (!cfg.corpid || !cfg.username || !cfg.password || !pdid || !brokerId) {
    return null;
  }

  const payload = JSON.stringify({
    PRODUCT: { PRODUCTID: Number(pdid), AGENTID: Number(brokerId) },
    PRIMARY: {
      age,
      state,
      zipcode,
      bSmoker: smoker ? 1 : 0
    },
    SPOUSE: { age: '', bSmoker: '' },
    CHILDREN: [{ age: '', bSmoker: '' }]
  });

  const body = new URLSearchParams({
    method: 'GetRates',
    Corpid: cfg.corpid,
    Username: cfg.username,
    Password: cfg.password,
    payload
  });

  const res = await fetch(RATE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString()
  });

  if (!res.ok) {
    throw new Error(`E123 GetRates failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data?.BERR === 1 || data?.berr === 1) {
    const msg = Array.isArray(data.ERRORMESSAGE) ? data.ERRORMESSAGE.join('; ') : data.ERRORMESSAGE;
    throw new Error(msg || 'E123 GetRates returned an error');
  }
  return data;
}

async function fetchProductRateGrid(pdid, brokerId, { age = 40, state = 'FL', zipcode = '32801' } = {}) {
  try {
    const [nonSmoker, smoker] = await Promise.all([
      callGetRates({ pdid, brokerId, smoker: false, age, state, zipcode }),
      callGetRates({ pdid, brokerId, smoker: true, age, state, zipcode })
    ]);

    const byBenefit = new Map();
    for (const row of parseRateRows(nonSmoker)) {
      const key = row.benefitId || normalizeRateLabelKey(row.benefitLabel);
      if (!key) continue;
      byBenefit.set(key, {
        benefitId: row.benefitId,
        benefitLabel: row.benefitLabel,
        nonTobaccoRate: row.rate,
        tobaccoRate: null
      });
    }

    for (const row of parseRateRows(smoker)) {
      const key = row.benefitId || normalizeRateLabelKey(row.benefitLabel);
      if (!key) continue;
      const existing = byBenefit.get(key) || {
        benefitId: row.benefitId,
        benefitLabel: row.benefitLabel,
        nonTobaccoRate: null,
        tobaccoRate: null
      };
      existing.tobaccoRate = row.rate;
      byBenefit.set(key, existing);
    }

    return {
      byBenefit,
      rows: [...byBenefit.values()]
    };
  } catch (err) {
    return { byBenefit: new Map(), rows: [], error: err.message };
  }
}

function normalizeRateLabelKey(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || null;
}

function lookupRateForBenefit(rateGrid, benefit) {
  if (!rateGrid?.byBenefit?.size || !benefit) return null;
  const benefitKey = benefit.benefitId != null ? String(benefit.benefitId) : null;
  if (benefitKey && rateGrid.byBenefit.has(benefitKey)) {
    return rateGrid.byBenefit.get(benefitKey);
  }
  const labelKey = normalizeRateLabelKey(benefit.benefitName);
  if (labelKey) {
    for (const [key, value] of rateGrid.byBenefit.entries()) {
      if (key === labelKey || normalizeRateLabelKey(value.benefitLabel) === labelKey) {
        return value;
      }
    }
  }
  return null;
}

module.exports = {
  fetchProductRateGrid,
  parseRateRows,
  lookupRateForBenefit
};
