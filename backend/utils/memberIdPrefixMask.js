/**
 * When a product sets IDCardMemberIdPrefixMask and the stored ID starts with a tenant prefix,
 * replace that prefix with the mask for ID cards and eligibility exports.
 * Tries oe.Tenants.MemberIDPrefix first, then oe.Tenants.IndividualMemberIDPrefix when distinct
 * (e.g. MW for groups, SW for individuals — see Unified Tenant Settings).
 */
function applyProductMemberIdPrefixMask(
  storedId,
  tenantMemberIdPrefix,
  productMaskPrefix,
  tenantIndividualMemberIdPrefix
) {
  if (storedId == null || storedId === '') return storedId;
  const s = String(storedId).trim();
  if (!s) return s;
  const mask = productMaskPrefix != null ? String(productMaskPrefix).trim() : '';
  if (!mask) return s;

  const replaceIfPrefix = (rawPrefix) => {
    const p = rawPrefix != null ? String(rawPrefix).trim() : '';
    if (!p) return null;
    if (s.length >= p.length && s.slice(0, p.length).toUpperCase() === p.toUpperCase()) {
      return mask + s.slice(p.length);
    }
    return null;
  };

  const main = replaceIfPrefix(tenantMemberIdPrefix);
  if (main != null) return main;

  const ind = tenantIndividualMemberIdPrefix != null ? String(tenantIndividualMemberIdPrefix).trim() : '';
  const mainP = tenantMemberIdPrefix != null ? String(tenantMemberIdPrefix).trim() : '';
  if (ind && ind.toUpperCase() !== mainP.toUpperCase()) {
    const second = replaceIfPrefix(ind);
    if (second != null) return second;
  }

  return s;
}

module.exports = { applyProductMemberIdPrefixMask };
