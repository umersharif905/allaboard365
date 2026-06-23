-- Audit: dependents (S/C) in households where primary has Active ShareWELL product enrollment
-- but the dependent has no Active enrollment for that same product (+ bundle).
-- Vendor: ShareWELL Health/Partners (D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6)
-- Run read-only; safe to run anytime.
DECLARE @VendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6'; -- ShareWELL Health/Partners

SELECT
    prim.HouseholdId,
    p.Name AS ProductName,
    prim.MemberId AS PrimaryMemberId,
    pu.FirstName + ' ' + pu.LastName AS PrimaryName,
    dep.MemberId AS DependentMemberId,
    du.FirstName + ' ' + du.LastName AS DependentName,
    dep.RelationshipType AS DepRel,
    e.EffectiveDate AS PrimaryEffective,
    e.EnrollmentId AS PrimaryEnrollmentId
FROM oe.Enrollments e
INNER JOIN oe.Members prim ON e.MemberId = prim.MemberId
INNER JOIN oe.Users pu ON prim.UserId = pu.UserId
INNER JOIN oe.Products p ON e.ProductId = p.ProductId
INNER JOIN oe.Members dep ON dep.HouseholdId = prim.HouseholdId
    AND dep.RelationshipType IN ('S', 'C')
    AND dep.MemberId <> prim.MemberId
    AND ISNULL(dep.IsTestData, 0) = 0
INNER JOIN oe.Users du ON dep.UserId = du.UserId
WHERE prim.RelationshipType = 'P'
  AND ISNULL(prim.IsTestData, 0) = 0
  AND p.VendorId = @VendorId
  AND e.Status = 'Active'
  AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
  AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
  AND e.ProductId IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM oe.Enrollments e2
      WHERE e2.MemberId = dep.MemberId
        AND e2.ProductId = e.ProductId
        AND ISNULL(e2.ProductBundleID, '00000000-0000-0000-0000-000000000000')
            = ISNULL(e.ProductBundleID, '00000000-0000-0000-0000-000000000000')
        AND e2.Status = 'Active'
  )
ORDER BY pu.LastName, pu.FirstName, du.LastName, p.Name;
