const { getPool, sql } = require('../../config/database');
const {
  toDayUTC,
  toISODate,
  buildRanges,
  mergeAdjacentRanges,
  findSpanContaining,
} = require('./continuousCoverage.service');

function emptyResult() {
  return { hasCoverage: false, tenureStartDate: null, daysOnPlan: 0, chain: [] };
}

/**
 * Continuous-coverage tenure for a member's plan history.
 *
 * Plan changes terminate the existing oe.Enrollments row and insert a new row
 * with EffectiveDate = day after the prior TerminationDate. Member Care needs
 * to see the unbroken span, not just the latest row's start date.
 *
 * Algorithm: merge all Product-type enrollment date ranges that are overlapping
 * or strictly adjacent (prior.end + 1 = next.start). The merged span that
 * contains today is the current tenure; its start is the tenure origin.
 *
 * Inputs are filtered to Status IN ('Active','Terminated') and EnrollmentType
 * 'Product' — Cancelled/Denied/PaymentHold/Pending rows and fee rows are
 * ignored. No grace window: a one-day gap breaks the chain.
 */
async function getMemberPlanTenure(memberId, tenantId) {
  if (!memberId) return emptyResult();

  const pool = await getPool();
  const request = pool.request().input('memberId', sql.UniqueIdentifier, memberId);

  // Tenant isolation: oe.Members.TenantId is the canonical column (oe.Enrollments
  // has no TenantId). Pass tenantId=null to skip the filter (SysAdmin case).
  let tenantFilter = '';
  if (tenantId) {
    tenantFilter = 'AND m.TenantId = @tenantId';
    request.input('tenantId', sql.UniqueIdentifier, tenantId);
  }

  const result = await request.query(`
    SELECT
      e.EnrollmentId,
      e.ProductId,
      e.EffectiveDate,
      e.TerminationDate,
      e.Status,
      e.CreatedDate,
      p.Name AS ProductName
    FROM oe.Enrollments e
    JOIN oe.Members m ON e.MemberId = m.MemberId
    LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
    WHERE e.MemberId = @memberId
      ${tenantFilter}
      AND e.EnrollmentType = 'Product'
      AND e.Status IN ('Active', 'Terminated')
    ORDER BY e.EffectiveDate ASC, e.CreatedDate ASC
  `);

  const rows = result.recordset || [];
  if (rows.length === 0) return emptyResult();

  const today = toDayUTC(new Date());
  const ranges = buildRanges(rows, today);
  if (ranges.length === 0) return emptyResult();

  const merged = mergeAdjacentRanges(ranges);
  const currentSpan = findSpanContaining(merged, today);
  if (!currentSpan) return emptyResult();

  const daysOnPlan = Math.floor((today.getTime() - currentSpan.start.getTime()) / 86400000);

  const chain = currentSpan.members
    .slice()
    .sort((a, b) => new Date(a.EffectiveDate) - new Date(b.EffectiveDate))
    .map(r => ({
      enrollmentId: r.EnrollmentId,
      productId: r.ProductId,
      productName: r.ProductName || null,
      effectiveDate: r.EffectiveDate ? toISODate(toDayUTC(r.EffectiveDate)) : null,
      terminationDate: r.TerminationDate ? toISODate(toDayUTC(r.TerminationDate)) : null,
      status: r.Status,
    }));

  return {
    hasCoverage: true,
    tenureStartDate: toISODate(currentSpan.start),
    daysOnPlan,
    chain,
  };
}

module.exports = { getMemberPlanTenure };
