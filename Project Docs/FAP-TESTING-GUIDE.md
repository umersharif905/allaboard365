# FAP Management System - Testing Guide

## ✅ Database Setup Complete
The SQL schema has been successfully run. All FAP tables are created.

## 🧪 Testing Steps

### Step 1: Start Backend Server
```bash
cd backend
npm run dev
# or
npm start
```

Verify you see in the console:
```
✅ Mounted /api/me/vendor routes (profile, products, payments, documents, users, share-requests, providers, members, npi, email-templates, fap)
✅ Mounted FAP routes
```

### Step 2: Start Frontend (if not already running)
```bash
cd frontend
npm start
```

### Step 3: Access the Vendor Portal

1. **Login** as a Vendor Admin or Vendor Agent user
2. **Navigate to Providers**: 
   - URL: `http://localhost:3000/vendor/providers` (or your frontend URL)
   - Or use the navigation menu

### Step 4: Test Provider Uniqueness Fix

1. **Create a Provider**:
   - Click "Add Provider"
   - Name: "Mayo Clinic"
   - City: "Rochester"
   - State: "MN"
   - Save

2. **Create Another Provider with Same Name**:
   - Click "Add Provider" again
   - Name: "Mayo Clinic" (same name)
   - City: "Jacksonville"
   - State: "FL" (different location)
   - Save
   - ✅ Should succeed (previously would have failed)

3. **Try Duplicate Name + Location**:
   - Click "Add Provider"
   - Name: "Mayo Clinic"
   - City: "Rochester"
   - State: "MN"
   - Save
   - ❌ Should fail with error about duplicate

### Step 5: Access Provider Profile

1. **Click on any provider card** in the Providers list
2. You should see:
   - **Overview Tab**: Basic provider information
   - **FAP Management Tab**: New FAP features

### Step 6: Test FAP Management Features

#### A. FAP Overview Section
1. Click **FAP Management** tab
2. Click **Overview** sub-section
3. You should see:
   - FAP Program Information section
   - Summary stats cards (Total Submissions, Approved, Average Discount, Overall Score)
   - "Edit Settings" button

#### B. FAP Settings (if needed)
1. Click "Edit Settings" in Overview
2. Fill in FAP program details:
   - FAP Website URL
   - Primary Contact Name/Phone/Email
   - Expected Processing Time
   - Required Documentation
3. Save

#### C. FAP Documents
1. Click **Documents** sub-section
2. Click **Upload Document**
3. Select a file (PDF, DOC, etc.)
4. Fill in:
   - Document Name
   - Document Type (dropdown)
   - Description (optional)
5. Click upload
6. ✅ Document should appear in the list
7. Test **Download** button
8. Test **Delete** button

#### D. FAP Notes
1. Click **Notes** sub-section
2. Click **Add Note**
3. Fill in:
   - Note Type: "Communication"
   - Contact Method: "Phone"
   - Person Contacted: "John Doe"
   - Note: "Discussed FAP application requirements"
   - Next Follow-up Date (optional)
4. Save
5. ✅ Note should appear in timeline
6. Test adding multiple notes

#### E. FAP Rankings
1. Click **Rankings** sub-section
2. Click **Add Rankings** (or **Edit Rankings** if exists)
3. Enter scores (1-10):
   - Fair Pricing Score: 8.5
   - Communication Score: 7.0
   - Negotiation Score: 9.0
4. Add Ranking Notes (optional)
5. Save
6. ✅ Overall Score should calculate automatically: (8.5 × 0.4) + (7.0 × 0.3) + (9.0 × 0.3) = 8.05
7. Verify score colors (green for 8+, yellow for 6-7, red for <6)

#### F. FAP Submissions
1. Click **Submissions** sub-section
2. Click **New Submission**
3. Fill in submission details:
   - Status: "Draft" or "Submitted"
   - Original Bill Amount
   - Submission Notes
   - Member (optional)
4. Save
5. ✅ Submission should appear in list with submission number (FAP-2025-0001)
6. Click on submission to view details
7. Test status filter dropdown
8. Test pagination (if you create multiple submissions)

### Step 7: Test API Endpoints Directly (Optional)

You can test the API endpoints using Postman, curl, or browser:

```bash
# Get FAP Settings
GET /api/me/vendor/providers/{providerId}/fap/settings

# Get FAP Submissions
GET /api/me/vendor/providers/{providerId}/fap/submissions

# Get FAP Documents
GET /api/me/vendor/providers/{providerId}/fap/documents

# Get FAP Notes
GET /api/me/vendor/providers/{providerId}/fap/notes

# Get Provider Ranking
GET /api/me/vendor/providers/{providerId}/fap/ranking

# Get FAP Summary/Analytics
GET /api/me/vendor/providers/{providerId}/fap/summary
```

## 🐛 Troubleshooting

### Issue: "Failed to load provider"
- **Check**: Backend server is running
- **Check**: You're logged in with correct role (VendorAdmin, VendorAgent)
- **Check**: Provider ID exists in database

### Issue: "FAP settings not found"
- **This is normal** - FAP settings are created on first edit
- Click "Edit Settings" to create them

### Issue: "Failed to upload document"
- **Check**: Azure Blob Storage connection string is set in backend `.env`
- **Check**: File size is under 10MB
- **Check**: File type is allowed (PDF, DOC, DOCX, XLS, XLSX, images)

### Issue: Routes not found (404)
- **Check**: Backend console shows "✅ Mounted FAP routes"
- **Check**: You're using the correct URL pattern
- **Check**: Authentication token is valid

### Issue: Database errors
- **Check**: All tables were created successfully
- **Check**: Foreign key constraints are correct
- **Check**: Database connection is working

## 📝 Expected Behavior

### Provider Uniqueness
- ✅ Same name + different location = **ALLOWED**
- ❌ Same name + same location = **BLOCKED**
- ✅ Different name = **ALLOWED**

### FAP Workflow
1. Create/Edit FAP Settings → Configure provider's FAP program
2. Upload Documents → Store FAP-related files
3. Add Notes → Track communications
4. Set Rankings → Score provider performance
5. Create Submissions → Track FAP applications
6. View Analytics → See summary stats

## 🎯 Next Steps (Optional Enhancements)

1. **Complete Submission Forms**: Implement full create/edit modals for submissions
2. **Analytics Dashboard**: Build comprehensive FAP performance dashboard
3. **Feature Toggles**: Add SysAdmin feature flags
4. **Automation**: Add reminder notifications for stale submissions
5. **Export**: Add CSV/PDF export for analytics

## ✅ Success Criteria

You'll know everything is working when:
- ✅ Can create multiple providers with same name (different locations)
- ✅ Can access Provider Profile page
- ✅ Can see FAP Management tab
- ✅ Can upload documents
- ✅ Can add notes
- ✅ Can set rankings
- ✅ Can create submissions
- ✅ Overall score calculates correctly
- ✅ All data persists after page refresh

