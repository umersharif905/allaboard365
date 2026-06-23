# Vendor Export - Next Steps After SQL Schema

## ✅ Completed

1. **Database Schema** - SQL script run, columns added to `oe.Vendors` table:
   - `SftpHostname`, `SftpPort`, `SftpUsername`, `SftpPassword` (encrypted)
   - `ExportEmailAddress`, `ExportEmailEnabled`
   - `ExportMethod`, `ExportSchedule`, `ExportScheduleDay`, `ExportScheduleTime`
   - `ExportFileFormat`, `ExportFileNameTemplate`
   - `ExportRetryAttempts`, `ExportRetryDelayMinutes`
   - `ExportCompressionEnabled`, `ExportEncryptionEnabled`

2. **Export Service** - `backend/services/vendorExportService.js` created with:
   - `getVendorConfig()` - Retrieves vendor configuration from database
   - `generateExportData()` - Gets data from `oe.v_ARM_Export_Data` view
   - `formatExportData()` - Formats as CSV/JSON/XML/TXT
   - `uploadToSFTP()` - SFTP upload functionality (requires `ssh2-sftp-client`)
   - `executeExport()` - Main export orchestration

3. **API Routes** - Added to `backend/routes/vendors.js`:
   - `POST /api/vendors/:id/export` - Manually trigger export
   - `GET /api/vendors/:id/export/test` - Test export (dry run)

4. **Scheduled Jobs** - Added to `backend/routes/scheduled-jobs.js`:
   - `POST /api/scheduled-jobs/vendor-exports` - Check and run scheduled exports

## 🔨 Next Steps

### 1. Test SFTP Export (Manual)
- Configure a vendor with SFTP settings via frontend
- Call `POST /api/vendors/:id/export` to trigger export
- Verify file is generated and uploaded to SFTP server
- Check email notification (if enabled)

### 2. Install Required Dependencies (if not installed)
```bash
cd backend
npm install ssh2-sftp-client  # For SFTP uploads
npm install archiver           # For ZIP compression
npm install form-data          # For API file uploads
```

### 3. Test Scheduled Exports
- Set up Azure Logic App to call `POST /api/scheduled-jobs/vendor-exports`
- Configure vendor with weekly schedule (day/time)
- Verify exports run automatically

### 4. Error Handling & Logging
- Add retry logic for failed SFTP uploads
- Add logging for export history/audit trail
- Add notification for failed exports

### 5. Frontend Integration
- Ensure frontend can save/load SFTP settings
- Add "Test Export" button in vendor edit modal
- Add export history/logs view

## 📋 Current Status

- **Database**: ✅ Schema ready
- **Backend Service**: ✅ Created, needs testing
- **API Routes**: ✅ Created, needs testing
- **SFTP Upload**: ✅ Code written, needs `ssh2-sftp-client` package
- **Scheduled Jobs**: ✅ Code written, needs Azure Logic App setup
- **Frontend**: ⚠️ Verify SFTP settings can be saved/loaded
