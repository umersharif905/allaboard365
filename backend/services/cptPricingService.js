// services/cptPricingService.js
// Proxy client for the internal MightyWELL pricing API
// (pricing.mightywellhealth.com — CMS hospital MRF prices + computed
// Medicare allowed amounts). Credentials stay server-side; the frontend
// only ever talks to /api/me/vendor/pricing/*.
//
// Spec: docs/superpowers/specs/2026-06-09-procedure-pricing-design.md

const axios = require('axios');

const TARGET_MIN_PCT = 1.5;  // 150% of Medicare — lower bound of negotiation range
const TARGET_MAX_PCT = 2.0;  // 200% of Medicare — upper bound

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // key -> { expires, data }

function getBaseUrl() {
    return (process.env.PRICING_API_URL || 'https://pricing.mightywellhealth.com').replace(/\/+$/, '');
}

function getAuth() {
    const username = process.env.PRICING_API_USER;
    const password = process.env.PRICING_API_PASS;
    if (!username || !password) {
        const err = new Error('Pricing API credentials not configured (PRICING_API_USER / PRICING_API_PASS)');
        err.code = 'PRICING_NOT_CONFIGURED';
        throw err;
    }
    return { username, password };
}

async function apiGet(path, params = {}) {
    const cleanParams = Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );
    const key = `${path}?${new URLSearchParams(cleanParams).toString()}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) {
        return hit.data;
    }

    const response = await axios.get(`${getBaseUrl()}${path}`, {
        params: cleanParams,
        auth: getAuth(),
        timeout: 20000
    });

    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, data: response.data });
    // Opportunistic sweep so the map doesn't grow unbounded
    if (cache.size > 500) {
        const now = Date.now();
        for (const [k, v] of cache) {
            if (v.expires <= now) cache.delete(k);
        }
    }
    return response.data;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

/**
 * Attach 150%-200% target ranges to a /api/cpt/price response and pick
 * headline numbers off the cheapest eligible site. Office-only codes have an
 * empty totals[]; fall back to the payable professional section.
 */
function computeTargets(priceData) {
    const totals = (priceData.totals || []).map(t => ({
        ...t,
        targetMin: round2(t.total * TARGET_MIN_PCT),
        targetMax: round2(t.total * TARGET_MAX_PCT)
    }));

    let medicareTotal = null;
    let headlineSite = null;
    if (totals.length > 0) {
        const cheapest = totals.reduce((a, b) => (a.total <= b.total ? a : b));
        medicareTotal = round2(cheapest.total);
        headlineSite = cheapest.site;
    } else {
        const professional = (priceData.sections || []).find(
            s => s.kind === 'professional' && s.payable && typeof s.result === 'number'
        );
        if (professional) {
            medicareTotal = round2(professional.result);
            headlineSite = professional.result_label || 'Professional fee';
        }
    }

    return {
        ...priceData,
        totals,
        medicareTotal,
        headlineSite,
        targetMin: medicareTotal !== null ? round2(medicareTotal * TARGET_MIN_PCT) : null,
        targetMax: medicareTotal !== null ? round2(medicareTotal * TARGET_MAX_PCT) : null,
        targetMinPct: TARGET_MIN_PCT,
        targetMaxPct: TARGET_MAX_PCT
    };
}

/**
 * Procedure-name / code search. Merges the Medicare procedure catalog
 * (name -> code resolution) with hospital price matches.
 */
async function searchProcedures({ q, zip, limit = 20 }) {
    const [catalog, hospitalMatches] = await Promise.all([
        apiGet('/api/cpt/procedures', { q, limit }).catch(() => null),
        apiGet('/api/search', { q, zip, limit }).catch(() => null)
    ]);
    return {
        procedures: catalog?.results || catalog?.procedures || catalog || [],
        hospitalMatches: hospitalMatches?.results || []
    };
}

/**
 * Medicare breakdown for a CPT/HCPCS/DRG code with target negotiation
 * ranges attached (per site + headline cheapest-site numbers).
 */
async function getCptPrice(code, { zip, site, anesMin } = {}) {
    const data = await apiGet(`/api/cpt/price/${encodeURIComponent(code)}`, {
        zip,
        site,
        anes_min: anesMin
    });
    return computeTargets(data);
}

/**
 * Hospital asking prices (cash / gross / negotiated, MRF-sourced) for a code,
 * distance-ranked from the member ZIP when given.
 */
async function getHospitalPrices(code, { zip, radius, limit = 25, state } = {}) {
    return apiGet(`/api/procedure/${encodeURIComponent(code)}`, { zip, radius, limit, state });
}

/**
 * Fetch live pricing for a code and shape the snapshot persisted on
 * oe.ShareRequestProcedures. PricingSnapshot keeps the full breakdown so the
 * UI re-renders the exact numbers without refetching.
 */
async function buildSnapshot(code, zip) {
    const priced = await getCptPrice(code, { zip });
    if (!priced.found) {
        const err = new Error(`No Medicare pricing found for code ${code}`);
        err.code = 'CPT_NOT_FOUND';
        throw err;
    }
    return {
        medicareTotal: priced.medicareTotal,
        targetMin: priced.targetMin,
        targetMax: priced.targetMax,
        snapshotZip: zip || null,
        snapshot: {
            code: priced.code,
            description: priced.description,
            zip: priced.zip,
            locality: priced.locality,
            site: priced.site,
            anesMinutesUsed: priced.anes_minutes_used,
            headlineSite: priced.headlineSite,
            medicareTotal: priced.medicareTotal,
            targetMin: priced.targetMin,
            targetMax: priced.targetMax,
            targetMinPct: priced.targetMinPct,
            targetMaxPct: priced.targetMaxPct,
            totals: priced.totals,
            sections: priced.sections
        }
    };
}

module.exports = {
    searchProcedures,
    getCptPrice,
    getHospitalPrices,
    buildSnapshot,
    computeTargets, // exported for tests
    TARGET_MIN_PCT,
    TARGET_MAX_PCT
};
