const { getPool, sql } = require('../../config/database');
const { ENROLLMENT_STATUS } = require('../../constants/enrollmentStatus');

/** Statuses that represent real coverage history for continuous-span merging. */
const CONTINUOUS_COVERAGE_STATUSES = [
  ENROLLMENT_STATUS.ACTIVE,
  ENROLLMENT_STATUS.INACTIVE,
  ENROLLMENT_STATUS.TERMINATED,
];

const CONTINUOUS_COVERAGE_STATUSES_SQL = CONTINUOUS_COVERAGE_STATUSES.map((s) => `N'${s}'`).join(', ');

function toDayUTC(value) {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDaysUTC(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function formatMDYFromISO(isoDate) {
  if (!isoDate) return '';
  const [year, month, day] = isoDate.split('-').map(Number);
  return `${month}/${day}/${year}`;
}

function normalizeGuid(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (Buffer.isBuffer(value) && value.length === 16) {
    const hex = value.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`.toLowerCase();
  }
  return String(value).trim().toLowerCase();
}

function normalizeProductType(productType) {
  if (!productType) return null;
  const pt = String(productType).trim();
  if (pt === 'Healthcare' || pt === 'Medical') return 'Medical';
  if (pt === 'Dental') return 'Dental';
  if (pt === 'Vision') return 'Vision';
  return pt;
}

function buildRanges(rows, asOfDay) {
  return rows
    .filter((r) => r.EffectiveDate)
    .map((r) => ({
      start: toDayUTC(r.EffectiveDate),
      end: r.TerminationDate ? toDayUTC(r.TerminationDate) : asOfDay,
      row: r,
    }));
}

/**
 * Merge overlapping or strictly adjacent enrollment spans (gap <= 1 day).
 */
function mergeAdjacentRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start.getTime() <= addDaysUTC(last.end, 1).getTime()) {
      if (range.end.getTime() > last.end.getTime()) last.end = range.end;
      last.members.push(range.row);
    } else {
      merged.push({ start: range.start, end: range.end, members: [range.row] });
    }
  }
  return merged;
}

function findSpanContaining(merged, asOfDay) {
  return merged.find(
    (span) => span.start.getTime() <= asOfDay.getTime() && asOfDay.getTime() <= span.end.getTime()
  );
}

function computeContinuousStartForEnrollments(enrollments, asOfDay) {
  if (!enrollments || enrollments.length === 0) return null;
  const ranges = buildRanges(enrollments, asOfDay);
  if (ranges.length === 0) return null;
  const merged = mergeAdjacentRanges(ranges);
  const span = findSpanContaining(merged, asOfDay);
  if (!span) return null;
  return toISODate(span.start);
}

function isEnrollmentActiveAsOf(row, asOfDay) {
  if (!row.EffectiveDate) return false;
  const eff = toDayUTC(row.EffectiveDate);
  if (eff.getTime() > asOfDay.getTime()) return false;
  if (row.TerminationDate) {
    const term = toDayUTC(row.TerminationDate);
    if (term.getTime() <= asOfDay.getTime()) return false;
  }
  return true;
}

/**
 * Pure lookup builder for unit tests and post-query enrichment.
 * @returns {{ byMemberProduct: Map<string,string>, byMemberProductType: Map<string,string>, byMemberWide: Map<string,string> }}
 */
function computeContinuousCoverageLookups(rows, asOfDate) {
  const asOfDay = toDayUTC(asOfDate || new Date());
  const byMemberProduct = new Map();
  const byMemberProductType = new Map();
  const byMemberWide = new Map();

  const byMember = new Map();
  for (const row of rows || []) {
    const memberId = normalizeGuid(row.MemberId);
    if (!memberId) continue;
    if (!byMember.has(memberId)) byMember.set(memberId, []);
    byMember.get(memberId).push(row);
  }

  for (const [memberId, memberRows] of byMember) {
    const byProduct = new Map();
    for (const row of memberRows) {
      const productId = normalizeGuid(row.ProductId);
      if (!productId) continue;
      if (!byProduct.has(productId)) byProduct.set(productId, []);
      byProduct.get(productId).push(row);
    }

    let memberWideEarliest = null;
    for (const [productId, productRows] of byProduct) {
      const start = computeContinuousStartForEnrollments(productRows, asOfDay);
      if (!start) continue;
      byMemberProduct.set(`${memberId}|${productId}`, start);
      if (!memberWideEarliest || start < memberWideEarliest) {
        memberWideEarliest = start;
      }
    }

    if (memberWideEarliest) {
      byMemberWide.set(memberId, memberWideEarliest);
    }

    for (const typeKey of ['Medical', 'Dental', 'Vision']) {
      const activeProductIds = new Set();
      for (const row of memberRows) {
        if (normalizeProductType(row.ProductType) !== typeKey) continue;
        if (!isEnrollmentActiveAsOf(row, asOfDay)) continue;
        activeProductIds.add(normalizeGuid(row.ProductId));
      }

      let typeEarliest = null;
      for (const productId of activeProductIds) {
        const start = byMemberProduct.get(`${memberId}|${productId}`);
        if (start && (!typeEarliest || start < typeEarliest)) {
          typeEarliest = start;
        }
      }
      if (typeEarliest) {
        byMemberProductType.set(`${memberId}|${typeKey}`, typeEarliest);
      }
    }
  }

  return { byMemberProduct, byMemberProductType, byMemberWide };
}

/**
 * Batched continuous-coverage start dates for eligibility export enrichment.
 * @param {string[]} memberIds
 * @param {{ tenantId?: string|null, effectiveAsOf?: Date|string }} options
 */
async function getContinuousCoverageStarts(memberIds, options = {}) {
  if (!memberIds || memberIds.length === 0) {
    return { byMemberProduct: new Map(), byMemberProductType: new Map(), byMemberWide: new Map() };
  }

  const pool = await getPool();
  const request = pool.request();

  let tenantFilter = '';
  if (options.tenantId) {
    tenantFilter = 'AND m.TenantId = @tenantId';
    request.input('tenantId', sql.UniqueIdentifier, options.tenantId);
  }

  const memberIdParams = memberIds.map((id, idx) => {
    const paramName = `ccMemberId${idx}`;
    request.input(paramName, sql.UniqueIdentifier, id);
    return `@${paramName}`;
  }).join(', ');

  const result = await request.query(`
    SELECT
      e.MemberId,
      e.ProductId,
      e.EffectiveDate,
      e.TerminationDate,
      e.Status,
      p.ProductType
    FROM oe.Enrollments e
    JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
    WHERE e.MemberId IN (${memberIdParams})
      ${tenantFilter}
      AND e.EnrollmentType = 'Product'
      AND e.Status IN (${CONTINUOUS_COVERAGE_STATUSES_SQL})
    ORDER BY e.MemberId, e.ProductId, e.EffectiveDate ASC
  `);

  return computeContinuousCoverageLookups(result.recordset || [], options.effectiveAsOf);
}

module.exports = {
  CONTINUOUS_COVERAGE_STATUSES,
  toDayUTC,
  addDaysUTC,
  toISODate,
  formatMDYFromISO,
  normalizeGuid,
  normalizeProductType,
  buildRanges,
  mergeAdjacentRanges,
  findSpanContaining,
  computeContinuousStartForEnrollments,
  isEnrollmentActiveAsOf,
  computeContinuousCoverageLookups,
  getContinuousCoverageStarts,
};
