// Backend API Endpoints Required for Tenant Management
// Add these endpoints to your Express.js backend

/* 
GET /api/admin/tenants
Query params: search, status, minRevenue, maxRevenue, sortBy, sortOrder, page, limit
Response: {
  tenants: Tenant[],
  total: number,
  page: number,
  totalPages: number
}

GET /api/admin/tenants/:tenantId
Response: Tenant

POST /api/admin/tenants
Body: CreateTenantRequest
Response: Tenant

PUT /api/admin/tenants/:tenantId
Body: UpdateTenantRequest
Response: Tenant

DELETE /api/admin/tenants/:tenantId
Response: void

GET /api/admin/tenants/:tenantId/metrics
Response: TenantMetrics

GET /api/admin/tenants/:tenantId/users
Response: TenantUser[]

POST /api/admin/tenants/bulk-update
Body: { tenantIds: string[], status: string }
Response: void

GET /api/admin/tenants/export
Query params: same as GET /api/admin/tenants
Response: CSV file

Sample SQL Queries for your Azure SQL Database:

-- Get tenants with filters
SELECT 
  t.TenantId,
  t.TenantName,
  t.ContactEmail,
  t.ContactPhone,
  t.Address,
  t.City,
  t.State,
  t.ZipCode,
  t.Status,
  t.CreatedDate as subscriptionDate,
  t.LastModifiedDate as lastActivityDate,
  ISNULL(tm.TotalMembers, 0) as totalMembers,
  ISNULL(tm.MonthlyRevenue, 0) as monthlyRevenue,
  t.CommissionRate,
  ts.PrimaryColor,
  ts.SecondaryColor,
  ts.LogoUrl
FROM oe.Tenants t
LEFT JOIN (
  SELECT 
    TenantId,
    COUNT(*) as TotalMembers,
    SUM(PremiumAmount) as MonthlyRevenue
  FROM oe.Members m
  JOIN oe.Enrollments e ON m.MemberId = e.MemberId
  JOIN oe.ProductPricing pp ON e.ProductId = pp.ProductId
  WHERE m.StatusId = 1
  GROUP BY TenantId
) tm ON t.TenantId = tm.TenantId
LEFT JOIN oe.TenantSettings ts ON t.TenantId = ts.TenantId
WHERE 
  (@search IS NULL OR t.TenantName LIKE '%' + @search + '%' OR t.ContactEmail LIKE '%' + @search + '%')
  AND (@status IS NULL OR t.Status = @status)
  AND (@minRevenue IS NULL OR ISNULL(tm.MonthlyRevenue, 0) >= @minRevenue)
ORDER BY 
  CASE WHEN @sortBy = 'name' AND @sortOrder = 'asc' THEN t.TenantName END ASC,
  CASE WHEN @sortBy = 'name' AND @sortOrder = 'desc' THEN t.TenantName END DESC,
  CASE WHEN @sortBy = 'revenue' AND @sortOrder = 'asc' THEN tm.MonthlyRevenue END ASC,
  CASE WHEN @sortBy = 'revenue' AND @sortOrder = 'desc' THEN tm.MonthlyRevenue END DESC

-- Get tenant metrics
SELECT 
  (SELECT COUNT(*) FROM oe.Members WHERE TenantId = @tenantId) as totalMembers,
  (SELECT COUNT(*) FROM oe.Members WHERE TenantId = @tenantId AND StatusId = 1) as activeMembers,
  (SELECT COUNT(*) FROM oe.Groups WHERE TenantId = @tenantId) as totalGroups,
  (SELECT ISNULL(SUM(Amount), 0) FROM oe.Payments p JOIN oe.Members m ON p.MemberId = m.MemberId WHERE m.TenantId = @tenantId AND MONTH(p.PaymentDate) = MONTH(GETDATE())) as monthlyRevenue,
  (SELECT ISNULL(SUM(Amount), 0) FROM oe.Payments p JOIN oe.Members m ON p.MemberId = m.MemberId WHERE m.TenantId = @tenantId) as totalRevenue,
  (SELECT ISNULL(SUM(CommissionAmount), 0) FROM oe.Commissions c JOIN oe.Members m ON c.MemberId = m.MemberId WHERE m.TenantId = @tenantId) as commissionsPaid,
  (SELECT COUNT(*) FROM oe.Enrollments e JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.TenantId = @tenantId AND MONTH(e.EnrollmentDate) = MONTH(GETDATE())) as enrollmentsThisMonth
*/
