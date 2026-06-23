'use strict';

const {
  tobaccoStatusFromImportRow: tobaccoFromRules,
  importRowDedupeKey: dedupeFromRules,
  normalizeImportRules,
} = require('./vendorImportRules');

function tobaccoStatusFromImportRow(row, importRules) {
  return tobaccoFromRules(row, importRules);
}

function normalizeTobaccoForMatch(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return 'No';
  if (s === 'yes' || s === 'y' || s === 'true' || s === '1') return 'Yes';
  return 'No';
}

function tobaccoRankForPricingPick(tobaccoStatus) {
  const s = String(tobaccoStatus || '').trim().toLowerCase();
  if (s === 'no' || s === 'n/a' || s === '') return 0;
  if (s !== 'yes') return 1;
  return 2;
}

/** Prefer non-tobacco tier when auto-mapping or row has no tobacco signal. */
function pickDefaultNonTobaccoPricingTier(candidates) {
  if (!candidates?.length) return null;
  const sorted = [...candidates].sort(
    (a, b) => tobaccoRankForPricingPick(a.tobaccoStatus) - tobaccoRankForPricingPick(b.tobaccoStatus),
  );
  return sorted[0];
}

/**
 * Pick catalog pricing row for an import row.
 * Row tobacco Yes → Yes tier when present; otherwise default non-tobacco.
 * Row tobacco No / blank → never prefer Yes over No.
 */
function pickPricingTierForTobacco(candidates, preferredTobacco) {
  if (!candidates?.length) return null;
  const want = normalizeTobaccoForMatch(preferredTobacco);
  const exact = candidates.find(
    (t) => normalizeTobaccoForMatch(t.tobaccoStatus) === want,
  );
  if (exact) return exact;
  if (want === 'Yes') {
    return pickDefaultNonTobaccoPricingTier(
      candidates.filter((t) => normalizeTobaccoForMatch(t.tobaccoStatus) === 'Yes'),
    ) || pickDefaultNonTobaccoPricingTier(candidates);
  }
  return pickDefaultNonTobaccoPricingTier(
    candidates.filter((t) => normalizeTobaccoForMatch(t.tobaccoStatus) !== 'Yes'),
  ) || pickDefaultNonTobaccoPricingTier(candidates);
}

function importRowDedupeKey(row, planKey, importRules) {
  return dedupeFromRules(row, planKey, importRules);
}

module.exports = {
  tobaccoStatusFromImportRow,
  normalizeTobaccoForMatch,
  tobaccoRankForPricingPick,
  pickDefaultNonTobaccoPricingTier,
  pickPricingTierForTobacco,
  importRowDedupeKey,
  normalizeImportRules,
};
