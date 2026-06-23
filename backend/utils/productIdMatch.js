'use strict';

/**
 * Compare product GUIDs safely across MSSQL-driver shapes, `{}` wrappers, and case.
 */
function normalizeProductId(raw) {
  if (raw == null) return '';
  let s =
    typeof raw === 'object' && raw?.toString
      ? String(raw.toString())
      : String(raw);
  s = s.trim().replace(/^\{|\}$/g, '');
  return s.replace(/-/g, '').toLowerCase();
}

function sameProductId(a, b) {
  const na = normalizeProductId(a);
  const nb = normalizeProductId(b);
  if (!na || !nb) return false;
  return na === nb;
}

module.exports = { normalizeProductId, sameProductId };
