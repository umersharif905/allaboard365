// Backend API Endpoints Required for Dashboard
// Add these endpoints to your Express.js backend

/* 
GET /api/admin/dashboard/metrics
Response: {
  totalMembers: number,
  monthlyRevenue: number, 
  totalTenants: number,
  totalCommissions: number,
  membersChange: number,
  revenueChange: number,
  tenantsChange: number,
  commissionsChange: number
}

GET /api/admin/dashboard/recent-enrollments
Response: [{
  memberId: string,
  memberName: string,
  plan: string,
  date: string,
  amount: number
}]

GET /api/admin/dashboard/top-tenants
Response: [{
  tenantName: string,
  totalMembers: number,
  monthlyRevenue: number
}]

GET /api/admin/dashboard/revenue-by-product
Response: [{
  productName: string,
  revenue: number,
  percentage: number
}]

GET /api/admin/dashboard/trending-enrollments
Response: [{
  week: string,
  enrollments: number
}]

Sample SQL Queries for your Azure SQL Database:

-- Dashboard Metrics
SELECT 
  (SELECT COUNT(*) FROM oe.Members WHERE StatusId = 1) as totalMembers,
  (SELECT ISNULL(SUM(Amount), 0) FROM oe.Payments WHERE MONTH(PaymentDate) = MONTH(GETDATE())) as monthlyRevenue,
  (SELECT COUNT(*) FROM oe.Tenants WHERE StatusId = 1) as totalTenants,
  (SELECT ISNULL(SUM(CommissionAmount), 0) FROM oe.Commissions WHERE MONTH(PaymentDate) = MONTH(GETDATE())) as totalCommissions

-- Recent Enrollments
SELECT TOP 10 
  m.MemberId,
  CONCAT(m.FirstName, ' ', m.LastName) as memberName,
  p.ProductName as plan,
  e.EnrollmentDate as date,
  pp.PremiumAmount as amount
FROM oe.Enrollments e
JOIN oe.Members m ON e.MemberId = m.MemberId  
JOIN oe.Products p ON e.ProductId = p.ProductId
JOIN oe.ProductPricing pp ON p.ProductId = pp.ProductId
ORDER BY e.EnrollmentDate DESC
*/
