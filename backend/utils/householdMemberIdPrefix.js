/**
 * Swap the leading prefix on a household member display ID while preserving the rest (suffix).
 * Case-insensitive match on fromPrefix; toPrefix is applied as provided by tenant settings.
 */
function swapHouseholdMemberIdPrefix(currentId, fromPrefix, toPrefix) {
  if (currentId == null || fromPrefix == null || toPrefix == null) return null;
  const c = String(currentId).trim();
  const f = String(fromPrefix).trim();
  const t = String(toPrefix).trim();
  if (!c || !f || !t) return null;
  if (f.toUpperCase() === t.toUpperCase()) return c;
  if (c.length < f.length) return null;
  if (c.slice(0, f.length).toUpperCase() !== f.toUpperCase()) return null;
  return t + c.slice(f.length);
}

/**
 * When TenantAdmin changes group membership, determine which prefix swap applies (if any).
 * Returns { fromPrefix, toPrefix } or null when no swap is needed.
 */
function computePrefixSwapForGroupChange({ clearingGroup, memberIDPrefix, individualMemberIDPrefix }) {
  const g = (memberIDPrefix || 'OED').trim();
  const i = individualMemberIDPrefix != null ? String(individualMemberIDPrefix).trim() : '';
  if (!i || i.toUpperCase() === g.toUpperCase()) return null;
  if (clearingGroup) {
    return { fromPrefix: g, toPrefix: i };
  }
  return { fromPrefix: i, toPrefix: g };
}

module.exports = {
  swapHouseholdMemberIdPrefix,
  computePrefixSwapForGroupChange
};
