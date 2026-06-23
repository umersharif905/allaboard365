# Backend API Integration for System Settings

## Required Backend Files

### 1. Add to your backend routes:
Create: `backend/routes/admin/systemSettings.js`
Path: D:\developer\pvt\open-enroll\backend\routes\admin\systemSettings.js

### 2. Add to main app.js or server.js:
```javascript
const systemSettingsRoutes = require('./routes/admin/systemSettings');
app.use('/api/admin', systemSettingsRoutes);
```

### 3. Required Dependencies:
- mssql (already installed)
- Express validation middleware
- Authentication/authorization middleware

## Current Project Structure:
- Root: D:\developer\pvt\open-enroll
- Frontend: D:\developer\pvt\open-enroll\frontend
- Backend: D:\developer\pvt\open-enroll\backend

## API Endpoints Created:
- GET /api/admin/system-settings
- PUT /api/admin/system-settings/:key
- PUT /api/admin/system-settings/batch
- GET /api/admin/system-health
- GET /api/admin/health-checks
- POST /api/admin/health-checks/all
- GET /api/admin/system-metrics
- GET /api/admin/backup-history
- POST /api/admin/backup
- GET /api/admin/audit-logs
- GET /api/admin/audit-logs/export
- GET /api/admin/tenant-settings/:tenantId?

## Database Schema Required:
Run the SQL script: system-settings-schema.sql on your Azure SQL database

## Security Considerations:
- All routes require Admin role
- Settings validation rules enforced
- Audit logging for all changes
- Encrypted storage for sensitive settings
