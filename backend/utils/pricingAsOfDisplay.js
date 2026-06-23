/**
 * Server-side phased pricing filter for agent bundle simulator (mirrors frontend/src/utils/pricingAsOf.ts).
 * Compare YYYY-MM-DD strings extracted from row dates vs as-of anchor.
 */

function extractCalendarYyyyMmDd(input) {
    if (input == null || input === '') return null;
    if (input instanceof Date) {
        if (Number.isNaN(input.getTime())) return null;
        const y = input.getFullYear();
        const m = String(input.getMonth() + 1).padStart(2, '0');
        const d = String(input.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const m = String(input).trim().match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const parsed = new Date(String(input));
    if (Number.isNaN(parsed.getTime())) return null;
    const y = parsed.getFullYear();
    const mo = String(parsed.getMonth() + 1).padStart(2, '0');
    const da = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
}

function normalizeTobaccoKey(v) {
    if (v == null || v === '') return 'NA';
    const u = String(v).trim().toUpperCase();
    if (u === 'Y' || u === 'YES' || u === 'TRUE') return 'Y';
    if (u === 'N' || u === 'NO' || u === 'FALSE') return 'N';
    return 'NA';
}

function tierFingerprint(row) {
    const pid = String(row.ProductId ?? row.ProductName ?? '').trim();
    const tier = String(row.TierType ?? '').trim().toUpperCase();
    const tob = normalizeTobaccoKey(row.TobaccoStatus);
    const label = String(row.Label ?? '').trim();
    const cfg = [1, 2, 3, 4, 5]
        .map((i) => String(row[`ConfigValue${i}`] ?? '').trim())
        .join('|');
    return [pid, tier, tob, row.MinAge ?? '', row.MaxAge ?? '', label, cfg].join('¦');
}

function isPricingRowValidOnYyyyMmDd(row, asOfYyyyMmDd) {
    const eff = extractCalendarYyyyMmDd(row.EffectiveDate);
    if (!eff) return false;
    if (eff > asOfYyyyMmDd) return false;
    const term =
        row.TerminationDate != null && row.TerminationDate !== ''
            ? extractCalendarYyyyMmDd(row.TerminationDate)
            : null;
    if (term != null && term < asOfYyyyMmDd) return false;
    return true;
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} [asOfYyyyMmDd] YYYY-MM-DD; omit or invalid → today's calendar date (server local)
 * @returns {Array}
 */
function filterPricingRowsAsOfYyyyMmDd(rows, asOfYyyyMmDd) {
    let anchor = asOfYyyyMmDd;
    if (!anchor || !/^\d{4}-\d{2}-\d{2}$/.test(String(anchor).trim())) {
        const n = new Date();
        anchor = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    } else {
        anchor = String(anchor).trim();
    }

    const valid = rows.filter((r) => isPricingRowValidOnYyyyMmDd(r, anchor));
    const byFp = new Map();
    for (const r of valid) {
        const fp = tierFingerprint(r);
        const curEff = extractCalendarYyyyMmDd(r.EffectiveDate) ?? '';
        const existing = byFp.get(fp);
        if (!existing) {
            byFp.set(fp, r);
            continue;
        }
        const exEff = extractCalendarYyyyMmDd(existing.EffectiveDate) ?? '';
        if (curEff > exEff) {
            byFp.set(fp, r);
        } else if (curEff === exEff) {
            const curId = String(r.ProductPricingId ?? '');
            const exId = String(existing.ProductPricingId ?? '');
            if (curId > exId) byFp.set(fp, r);
        }
    }
    return Array.from(byFp.values());
}

module.exports = {
    extractCalendarYyyyMmDd,
    filterPricingRowsAsOfYyyyMmDd,
    tierFingerprint,
    isPricingRowValidOnYyyyMmDd
};
