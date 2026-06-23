# Generate Missing Commissions Feature

## Overview

Add a SysAdmin-only feature in the Commission Simulator to manually generate commissions for payments that don't have corresponding commission rows. This is useful for retroactively creating commissions for historical payments created before the commission trigger was set up.

## Requirements

1. **Backend Endpoint:** Check for payments without commissions (count)
2. **Backend Endpoint:** Generate commissions for payments missing them (batch process)
3. **Frontend UI:** Show "Generate Missing Commissions (x)" button for SysAdmin only
4. **Same Logic:** Use `CommissionService.createCommissionsForPayment()` (same as trigger)

## Implementation Plan

### Backend: Check Missing Commissions

**Endpoint:** `GET /api/commissions/missing`

**Purpose:** Count payments that should have commissions but don't

**Query Logic:**
```sql
SELECT COUNT(*) as MissingCount
FROM oe.Payments p
INNER JOIN oe.Agents a ON p.AgentId = a.AgentId
WHERE p.Status IN ('Completed', 'Draft', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded')
  AND p.AgentId IS NOT NULL
  AND p.Commission IS NOT NULL
  AND p.Commission > 0
  AND a.Status = 'Active'
  AND NOT EXISTS (
    SELECT 1 
    FROM oe.Commissions c 
    WHERE c.PaymentId = p.PaymentId
  )
```

**Response:**
```json
{
  "success": true,
  "missingCount": 15,
  "message": "Found 15 payments without commissions"
}
```

### Backend: Generate Missing Commissions

**Endpoint:** `POST /api/commissions/generate-missing`

**Purpose:** Generate commissions for all payments that are missing them

**Logic:**
1. Find all payments without commissions (same query as above)
2. For each payment, call `CommissionService.createCommissionsForPayment()`
3. Return summary of results

**Request Body:** (optional - could add filters later)
```json
{
  "limit": null, // Optional: limit number of payments to process
  "dryRun": false // Optional: if true, don't create, just return what would be created
}
```

**Response:**
```json
{
  "success": true,
  "processed": 15,
  "created": 45, // Total commission rows created (multiple per payment)
  "failed": 0,
  "errors": []
}
```

**Implementation:**
```javascript
// In backend/routes/commissions.js
router.post('/generate-missing', async (req, res) => {
  try {
    // Check if user is SysAdmin
    if (req.user?.currentRole !== 'SysAdmin') {
      return res.status(403).json({
        success: false,
        message: 'Only SysAdmin can generate missing commissions'
      });
    }

    const { limit, dryRun } = req.body;
    const pool = await getPool();
    const sql = require('mssql');

    // Find payments without commissions
    let query = `
      SELECT 
        p.PaymentId,
        p.HouseholdId,
        p.GroupId,
        p.PaymentDate,
        p.EnrollmentId,
        p.Amount,
        p.AgentId,
        p.Status,
        p.Commission,
        p.OverrideRate,
        p.NetRate,
        e.ProductId
      FROM oe.Payments p
      INNER JOIN oe.Agents a ON p.AgentId = a.AgentId
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId AND e.Status = 'Active'
      WHERE p.Status IN ('Completed', 'Draft', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded')
        AND p.AgentId IS NOT NULL
        AND p.Commission IS NOT NULL
        AND p.Commission > 0
        AND a.Status = 'Active'
        AND NOT EXISTS (
          SELECT 1 
          FROM oe.Commissions c 
          WHERE c.PaymentId = p.PaymentId
        )
      ORDER BY p.PaymentDate ASC
    `;

    if (limit) {
      query += ` TOP ${limit}`;
    }

    const result = await pool.request().query(query);
    const payments = result.recordset;

    if (payments.length === 0) {
      return res.json({
        success: true,
        processed: 0,
        created: 0,
        failed: 0,
        message: 'No payments found without commissions'
      });
    }

    if (dryRun) {
      return res.json({
        success: true,
        processed: payments.length,
        wouldCreate: payments.length,
        message: `Would create commissions for ${payments.length} payments`
      });
    }

    // Process each payment
    const CommissionService = require('../services/commissionService.advances');
    let created = 0;
    let failed = 0;
    const errors = [];

    for (const payment of payments) {
      try {
        // Determine commission status based on payment status
        const commissionStatus = payment.Status === 'Draft' ? 'Draft' : 'Pending';

        // Use same logic as trigger
        const result = await CommissionService.createCommissionsForPayment({
          paymentId: payment.PaymentId,
          householdId: payment.HouseholdId,
          groupId: payment.GroupId,
          paymentDate: payment.PaymentDate,
          enrollmentId: payment.EnrollmentId,
          productId: payment.ProductId,
          paymentAmount: parseFloat(payment.Amount),
          agentId: payment.AgentId,
          tenantId: null, // Will be derived from oe.Agents in commission service
          commission: payment.Commission !== null ? parseFloat(payment.Commission) : null,
          overrideRate: payment.OverrideRate !== null ? parseFloat(payment.OverrideRate) : 0,
          netRate: payment.NetRate !== null ? parseFloat(payment.NetRate) : null,
          commissionStatus: commissionStatus
        });

        created += result.commissionsCreated || 0;
      } catch (error) {
        failed++;
        errors.push({
          paymentId: payment.PaymentId,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      processed: payments.length,
      created: created,
      failed: failed,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});
```

### Frontend: Add UI to Commission Simulator

**Location:** `frontend/src/components/commissions/CommissionSimulator.tsx`

**Changes:**
1. Add state for missing commissions count
2. Fetch missing count on mount (if SysAdmin)
3. Add button "Generate Missing Commissions (x)" - visible only for SysAdmin
4. Add confirmation dialog before generating
5. Show progress/loading state
6. Show success/error message

**Code Structure:**
```typescript
// In CommissionSimulator component
const [missingCommissionsCount, setMissingCommissionsCount] = useState<number | null>(null);
const [generatingMissing, setGeneratingMissing] = useState(false);

// Fetch missing count (SysAdmin only)
useEffect(() => {
  if (isSysAdmin) {
    fetchMissingCommissionsCount();
  }
}, [isSysAdmin]);

const fetchMissingCommissionsCount = async () => {
  try {
    const response = await apiService.get<{ success: boolean; missingCount: number }>('/api/commissions/missing');
    if (response.success) {
      setMissingCommissionsCount(response.missingCount);
    }
  } catch (error) {
    console.error('Failed to fetch missing commissions count:', error);
  }
};

const handleGenerateMissing = async () => {
  if (!missingCommissionsCount || missingCommissionsCount === 0) {
    return;
  }

  // Confirmation dialog
  const confirmed = window.confirm(
    `This will generate commissions for ${missingCommissionsCount} payments. This may take a few moments. Continue?`
  );

  if (!confirmed) return;

  try {
    setGeneratingMissing(true);
    const response = await apiService.post<{
      success: boolean;
      processed: number;
      created: number;
      failed: number;
    }>('/api/commissions/generate-missing', {});

    if (response.success) {
      alert(`Successfully generated ${response.created} commission rows for ${response.processed} payments.`);
      setMissingCommissionsCount(0); // Reset count
      // Optionally refresh commission data
    } else {
      alert(`Error: ${response.message}`);
    }
  } catch (error: any) {
    alert(`Failed to generate commissions: ${error.message}`);
  } finally {
    setGeneratingMissing(false);
  }
};

// In JSX (SysAdmin only):
{isSysAdmin && missingCommissionsCount !== null && missingCommissionsCount > 0 && (
  <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
    <div className="flex items-center justify-between">
      <div>
        <h3 className="text-sm font-medium text-yellow-800">
          Missing Commissions Detected
        </h3>
        <p className="text-sm text-yellow-700 mt-1">
          {missingCommissionsCount} payment(s) found without commission rows.
        </p>
      </div>
      <button
        onClick={handleGenerateMissing}
        disabled={generatingMissing}
        className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 disabled:opacity-50"
      >
        {generatingMissing ? 'Generating...' : `Generate Missing Commissions (${missingCommissionsCount})`}
      </button>
    </div>
  </div>
)}
```

## Security

- ✅ **SysAdmin Only:** Check role on both frontend and backend
- ✅ **Same Logic:** Uses exact same code as trigger (`CommissionService.createCommissionsForPayment()`)
- ✅ **Error Handling:** Catches errors per payment, continues processing
- ✅ **Idempotent:** Safe to run multiple times (checks for existing commissions)

## Testing

1. **Test with production data:**
   - Switch to production database (read-only verification)
   - Count payments without commissions
   - Verify count matches expected

2. **Test generation in dev:**
   - Switch to dev database
   - Create test payments without commissions
   - Run generate-missing endpoint
   - Verify commissions created correctly

3. **Test UI:**
   - Login as SysAdmin
   - Open Commission Simulator
   - Verify "Generate Missing Commissions" button appears
   - Test generation flow

4. **Test non-SysAdmin:**
   - Login as TenantAdmin/Agent
   - Verify button does NOT appear
   - Try to call endpoint directly (should return 403)

## Files to Modify

1. **Backend:**
   - `backend/routes/commissions.js` - Add two new endpoints

2. **Frontend:**
   - `frontend/src/components/commissions/CommissionSimulator.tsx` - Add UI and logic

## Related Files

- `backend/services/commissionService.advances.js` - Commission creation service (used by trigger and this feature)
- `oe_payment_manager/shared/commissionTrigger.js` - Trigger logic (reference for same logic)


