SELECT v.Label, v.Amount, v.Cnt
FROM (
  SELECT 1 AS ord, CAST('NACHA_vendor_payout' AS NVARCHAR(64)) AS Label, CAST(SUM(npd.Amount) AS DECIMAL(18,2)) AS Amount, CAST(NULL AS INT) AS Cnt
  FROM oe.NACHAPaymentDetails npd
  WHERE npd.NACHAId = N'37462924-000B-4EEA-BBDF-1BFB35D0CB48' AND npd.RecipientEntityType = N'Vendor' AND npd.RecipientEntityId = N'ACA4FF18-0023-4AA8-98DF-78AA183535C4'
  UNION ALL
  SELECT 2, 'OLD_join_sum_NetRate', CAST(SUM(e.NetRate) AS DECIMAL(18,2)), COUNT(*)
  FROM (
    SELECT DISTINCT npd.PaymentId
    FROM oe.NACHAPaymentDetails npd
    WHERE npd.NACHAId = N'37462924-000B-4EEA-BBDF-1BFB35D0CB48' AND npd.RecipientEntityType = N'Vendor' AND npd.RecipientEntityId = N'ACA4FF18-0023-4AA8-98DF-78AA183535C4' AND npd.Amount > 0
  ) payments
  INNER JOIN oe.Payments p ON payments.PaymentId = p.PaymentId
  INNER JOIN oe.Enrollments e ON (
    (p.HouseholdId IS NOT NULL AND e.HouseholdId = p.HouseholdId)
    OR (p.GroupId IS NOT NULL AND EXISTS (SELECT 1 FROM oe.Members mx WHERE mx.MemberId = e.MemberId AND mx.GroupId = p.GroupId AND mx.RelationshipType = N'P'))
  )
  INNER JOIN oe.Members m ON e.MemberId = m.MemberId AND m.RelationshipType = N'P'
  INNER JOIN oe.Products pr ON e.ProductId = pr.ProductId AND pr.VendorId = N'ACA4FF18-0023-4AA8-98DF-78AA183535C4'
  WHERE e.EffectiveDate <= p.PaymentDate AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate) AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
  UNION ALL
  SELECT 3, 'NEW_join_plus_enrollment_effective_exception', CAST(SUM(e.NetRate) AS DECIMAL(18,2)), COUNT(*)
  FROM (
    SELECT DISTINCT npd.PaymentId
    FROM oe.NACHAPaymentDetails npd
    WHERE npd.NACHAId = N'37462924-000B-4EEA-BBDF-1BFB35D0CB48' AND npd.RecipientEntityType = N'Vendor' AND npd.RecipientEntityId = N'ACA4FF18-0023-4AA8-98DF-78AA183535C4' AND npd.Amount > 0
  ) payments
  INNER JOIN oe.Payments p ON payments.PaymentId = p.PaymentId
  INNER JOIN oe.Enrollments e ON (
    (p.EnrollmentId IS NOT NULL AND e.EnrollmentId = p.EnrollmentId)
    OR (p.HouseholdId IS NOT NULL AND EXISTS (SELECT 1 FROM oe.Members mh WHERE mh.MemberId = e.MemberId AND mh.HouseholdId = p.HouseholdId AND mh.RelationshipType = N'P'))
    OR (p.GroupId IS NOT NULL AND EXISTS (SELECT 1 FROM oe.Members mx WHERE mx.MemberId = e.MemberId AND mx.GroupId = p.GroupId AND mx.RelationshipType = N'P'))
  )
  INNER JOIN oe.Members m ON e.MemberId = m.MemberId AND m.RelationshipType = N'P'
  INNER JOIN oe.Products pr ON e.ProductId = pr.ProductId AND pr.VendorId = N'ACA4FF18-0023-4AA8-98DF-78AA183535C4'
  WHERE (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate) AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
    AND (e.EffectiveDate <= p.PaymentDate OR (p.GroupId IS NULL AND p.EnrollmentId IS NOT NULL AND e.EnrollmentId = p.EnrollmentId))
) v
ORDER BY v.ord;
