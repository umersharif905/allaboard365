'use strict';

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const toBoolProductFlag = (v) =>
  v === true || v === 'true' || v === 1 || v === '1' || v === 'yes';

/**
 * When include-fee is on, persist wizard-computed msrpRate / includedProcessingFee from the band payload.
 * Returns null when server-side recalc should run instead.
 */
function resolveMsrpAndIncludedFromWizardBand(componentSum, includeProcessingFee, band) {
  if (!toBoolProductFlag(includeProcessingFee) || !band) return null;

  const base = round2(componentSum);
  const clientMsrp = round2(band.msrpRate ?? band.MSRPRate);
  const clientIncludedRaw = band.includedProcessingFee ?? band.IncludedProcessingFee;
  const clientIncluded =
    clientIncludedRaw != null && clientIncludedRaw !== ''
      ? round2(clientIncludedRaw)
      : null;

  if (!(clientMsrp > 0) || clientMsrp < base - 0.02) return null;

  const includedFee =
    clientIncluded != null && clientIncluded >= 0
      ? clientIncluded
      : round2(Math.max(0, clientMsrp - base));

  return { msrpRate: clientMsrp, includedFee };
}

module.exports = {
  resolveMsrpAndIncludedFromWizardBand,
  round2,
  toBoolProductFlag,
};
