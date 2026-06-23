# ===================================================================================================
# SESSION 7: ACCOUNTING SYSTEM - INSTALLATION INSTRUCTIONS
# ===================================================================================================

## 🚀 BACKEND SETUP

### Step 1: Add Routes to Your app.js
Add this line to your backend/src/app.js file (around line 60 where the error was happening):

```javascript
// Add accounting routes
const accountingRoutes = require('./routes/accounting');
app.use('/api/accounting', accountingRoutes);
```

### Step 2: Test the Backend Routes
Restart your backend server and test:
- GET /api/accounting/test - should return success message
- GET /api/accounting/payments - should return payment data
- GET /api/accounting/commissions - should return commission data

## 🎨 FRONTEND SETUP

### Step 3: Add Route to Your React App
Add this route to your React router configuration:

```javascript
import Accounting from './pages/admin/accounting';

// Add to your routes:
<Route path="/admin/accounting" element={<Accounting />} />
```

### Step 4: Test the Frontend
- Navigate to http://localhost:3000/admin/accounting
- Should see the 3-tab accounting interface
- Test each tab: Payments, Commissions, Reports

## 💾 DATABASE SETUP

### Step 5: Run the Final SQL Fix (if needed)
Run this to add sample commission data:

```sql
DECLARE @CommissionCount INT;
SELECT @CommissionCount = COUNT(*) FROM oe.Commissions;

IF @CommissionCount = 0
BEGIN
    INSERT INTO oe.Commissions (
        AgentId, EnrollmentId, Amount, Percentage, Status, CreatedDate, ModifiedDate
    )
    SELECT TOP 5
        e.AgentId, e.EnrollmentId, e.Premium * 0.15, 15.0, 'Earned', GETUTCDATE(), GETUTCDATE()
    FROM oe.Enrollments e
    JOIN oe.Agents a ON e.AgentId = a.AgentId
    WHERE e.Status = 'Active' AND a.Status = 'Active' AND e.Premium > 0 AND e.AgentId IS NOT NULL;
END
```

## ✅ VERIFICATION CHECKLIST

- [ ] Backend starts without errors
- [ ] GET /api/accounting/test returns success
- [ ] Frontend accounting page loads
- [ ] Payments tab shows data
- [ ] Commissions tab shows data  
- [ ] Reports tab shows data
- [ ] No console errors in browser

## 🎯 WHAT YOU GET

### Payment Management:
- View all payment transactions
- Retry failed payments
- Process refunds
- Export payment data

### Commission Management:
- View agent commissions
- Process commission payouts
- Manage commission rates
- Track agent performance

### Financial Reports:
- Revenue analysis by month/tenant/product
- Commission reports by agent
- Reconciliation tools
- Compliance reporting

## 🚀 NEXT STEPS

Your accounting system is now ready! You can:
1. Connect to real payment processors
2. Set up automated commission calculations
3. Configure compliance reporting
4. Add more advanced financial features

Session 7 complete! Ready for Session 8: System Settings & Configuration.
