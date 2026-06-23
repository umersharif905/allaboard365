/**
 * Enrollments that represent a real product or bundle (not fees, contributions, etc.).
 * Bundle rows use EnrollmentType = 'Bundle' (see enrollmentWriter.service.js).
 */
const ENROLLMENT_TYPE_PRODUCT_LIKE_SQL =
  '(e.EnrollmentType IS NULL OR e.EnrollmentType IN (\'Product\', \'Bundle\'))';

/**
 * Product filter for member list queries.
 * - Direct: e.ProductId = selected product.
 * - Bundle context: most bundle enrollments store ProductBundleID = bundle product and
 *   ProductId = each component line (EnrollmentType is often still 'Product' in DB).
 *   Filtering by the bundle product must match e.ProductBundleID = @productId, not only ProductId.
 * - When e.ProductId is the bundle product row, ProductBundles links components (second OR).
 * Binds @productId (sql.UniqueIdentifier). Subqueries reference m.MemberId from outer query.
 */
function buildMemberListProductFilterExistsSql() {
  return `(
    EXISTS (
        SELECT 1 FROM oe.Enrollments e
        WHERE e.MemberId = m.MemberId
        AND (e.ProductId = @productId OR e.ProductBundleID = @productId)
        AND (e.Status = 'Active' OR e.Status = 'Pending')
        AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE())
        AND ${ENROLLMENT_TYPE_PRODUCT_LIKE_SQL}
    )
    OR EXISTS (
        SELECT 1 FROM oe.Enrollments e
        INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = e.ProductId AND pb.IncludedProductId = @productId
        WHERE e.MemberId = m.MemberId
        AND (e.Status = 'Active' OR e.Status = 'Pending')
        AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE())
        AND ${ENROLLMENT_TYPE_PRODUCT_LIKE_SQL}
    )
)`;
}

module.exports = {
  buildMemberListProductFilterExistsSql,
  ENROLLMENT_TYPE_PRODUCT_LIKE_SQL,
};
