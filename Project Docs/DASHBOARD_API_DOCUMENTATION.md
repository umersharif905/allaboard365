# DASHBOARD API ENDPOINTS REQUIRED

The following endpoints need to be implemented in your backend to support the dashboard:

## 1. GET /api/admin/dashboard/metrics
Returns overall system metrics

### Response:
```json
{
  "totalMembers": 4920,
  "monthlyRevenue": 99000,
  "totalTenants": 12,
  "totalCommissions": 40500,
  "membersChange": 12.5,
  "revenueChange": 7.2,
  "tenantsChange": 8.3,
  "commissionsChange": 9.3
}
```

### SQL Query Example:
```sql
SELECT 
  (SELECT COUNT(*) FROM oe.Members WHERE StatusId = 1) as totalMembers,
  (SELECT ISNULL(SUM(Amount), 0) FROM oe.Payments WHERE MONTH(PaymentDate) = MONTH(GETDATE())) as monthlyRevenue,
  (SELECT COUNT(*) FROM oe.Tenants WHERE StatusId = 1) as totalTenants,
  (SELECT ISNULL(SUM(CommissionAmount), 0) FROM oe.Commissions WHERE MONTH(PaymentDate) = MONTH(GETDATE())) as totalCommissions
```

## 2. GET /api/admin/dashboard/recent-enrollments
Returns the 10 most recent enrollments

### Response:
```json
[
  {
    "memberId": "uuid",
    "memberName": "John Smith",
    "plan": "Health Premium",
    "date": "2025-01-14",
    "amount": 345.00
  }
]
```

### SQL Query Example:
```sql
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
```

## 3. GET /api/admin/dashboard/top-tenants
Returns top performing tenants by revenue

### Response:
```json
[
  {
    "tenantName": "Acme Health",
    "totalMembers": 1245,
    "monthlyRevenue": 52340
  }
]
```

## 4. GET /api/admin/dashboard/revenue-by-product
Returns revenue breakdown by product type

### Response:
```json
[
  {
    "productName": "Health",
    "revenue": 45000,
    "percentage": 45
  }
]
```

## 5. GET /api/admin/dashboard/trending-enrollments
Returns enrollment counts by week

### Response:
```json
[
  {
    "week": "Week 1",
    "enrollments": 120
  }
]
```

## 6. GET /api/admin/dashboard/monthly-revenue?year=2025
Returns monthly revenue and profit data

### Response:
```json
[
  {
    "name": "Jan",
    "revenue": 65000,
    "profit": 25000
  },
  {
    "name": "Feb",
    "revenue": 68000,
    "profit": 26500
  }
]
```
