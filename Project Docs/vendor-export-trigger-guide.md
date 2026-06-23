# Vendor Export - How to Trigger and What It Runs

## Overview

The vendor export system allows you to export member/enrollment data to vendors via SFTP or API. The export uses the **ARM export view** (`oe.v_ARM_Export_Data`) which contains all member data formatted for vendor consumption.

## What Data Does It Export?

The export runs the **`oe.v_ARM_Export_Data`** SQL view, which includes:

- **Member Information**: Name, SSN, DOB, Gender, Address, Phone, Email
- **Enrollment Data**: Enrollment dates, termination dates, effective dates
- **Product Eligibility**: Medical, Dental, Vision, Drug, Life, LTD, STD eligibility flags
- **Coverage Details**: COB flags, volumes, salary, relationship codes
- **Group Information**: Group Number, Location Number
- **Payment Information**: EFT account details (routing, account numbers)

**Total Fields**: 80+ columns matching the ARM Enrollment Import Layout format

## How to Trigger Exports

### 1. Manual Trigger (API Endpoint)

**Endpoint**: `POST /api/vendors/:vendorId/export`

**Example**:
```bash
POST /api/vendors/{vendor-id}/export
Authorization: Bearer <token>
Content-Type: application/json

{
  "enrollmentDateStart": "2025-01-01",  // Optional
  "terminationDateStart": "2025-01-01"  // Optional
}
```

**Response**:
```json
{
  "success": true,
  "message": "Export completed successfully",
  "data": {
    "recordCount": 150,
    "fileName": "vendor-export-20250111-1705123456.csv",
    "fileSize": 245678,
    "methods": [
      {
        "method": "SFTP",
        "success": true,
        "remotePath": "/exports/vendor-export-20250111-1705123456.csv",
        "uploadedAt": "2025-01-11T17:05:12.456Z"
      }
    ],
    "emailSent": true
  }
}
```

### 2. Test Export (Dry Run)

**Endpoint**: `GET /api/vendors/:vendorId/export/test`

This generates the export data but doesn't send it. Useful for testing configuration.

**Example**:
```bash
GET /api/vendors/{vendor-id}/export/test
Authorization: Bearer <token>
```

**Response**:
```json
{
  "success": true,
  "message": "Test export data generated",
  "data": {
    "vendorName": "ARM Insurance",
    "exportMethod": "SFTP",
    "fileFormat": "CSV",
    "recordCount": 150,
    "sampleRecord": { ... },
    "fileName": "vendor-export-20250111-1705123456.csv"
  }
}
```

### 3. Scheduled Exports (Automated)

**Endpoint**: `POST /api/scheduled-jobs/vendor-exports`

There is **no in-process cron** in the app server. An external scheduler (Azure Logic App, cron, etc.) must call this endpoint on a cadence you choose (for example every minute or every hour). The backend then decides which **work items** are due **right now**.

**Security**: When `SCHEDULED_JOB_API_KEY` is set in the backend environment, requests must include header `x-api-key` with that same value. If the env var is unset, the route does not require a key (use only in local/dev).

#### What runs (job-based + legacy)

1. **`oe.VendorScheduledJobs`** (preferred): one row per scheduled job. **`JobType`** = `eligibility_export` (member/eligibility file) or **`payables_export`** (vendor payables CSV for the **latest NACHA** batch that includes that vendor — same data as Accounting → NACHA payables export). Each row has its own schedule, optional comma-separated **email recipients**, optional **SFTP path override**, and `LastRunAt` (updated after a successful run; the same job is not selected again within **2 minutes**). Payables jobs also store **`LastExportedNachaId`** after a successful upload so the same NACHA file is not re-sent until a newer NACHA exists (run migration `sql-changes/add-vendor-scheduled-jobs-last-exported-nacha.sql`).
2. **Legacy `oe.Vendors` schedule**: vendors that still have `ExportSchedule` set on the vendor row **and** have **no** row in `VendorScheduledJobs` are included until you migrate them to jobs (eligibility export only).

Admin UI: **SysAdmin → Vendors → Edit vendor → Scheduled jobs** tab (`GET/POST/PUT/DELETE /api/vendors/:vendorId/scheduled-jobs`). Run migration `sql-changes/add-vendor-scheduled-jobs.sql` so the table exists, plus the follow-up migration for `LastExportedNachaId` if you use payables jobs.

**Schedule matching** (server local time / JS `Date` for day and `HH:mm` for time; monthly day-of-month uses SQL `DAY(SYSUTCDATETIME()) = 1`):

- **Daily**: Runs when the current clock time **equals** `ExportScheduleTime` (e.g. `09:00`). It does **not** run on every invocation of the endpoint unless the external job fires in that same minute.
- **Weekly**: Same time match, and `ExportScheduleDay` must match the current weekday name (`Monday` … `Sunday`).
- **Monthly**: 1st of the month at the configured time.

**Setup Azure Logic App** (example):

1. Create Azure Logic App.
2. Add a **Recurrence** trigger (e.g. every minute, or every hour — finer granularity improves time alignment with `HH:mm`).
3. Add HTTP action:
   - **Method**: POST
   - **URI**: `https://your-backend.azurewebsites.net/api/scheduled-jobs/vendor-exports`
   - **Headers**: `x-api-key: <value of SCHEDULED_JOB_API_KEY>`

The backend returns `data.workItemsProcessed` and per-item `results` (each item is either `kind: 'job'` or `kind: 'legacy'`).

## Export Process Flow

1. **Read Vendor Configuration**
   - Get export method (SFTP/API)
   - Get Group IDs filter (if specified)
   - Get file format (CSV/JSON/XML/TXT)
   - Get compression/encryption settings

2. **Generate Export Data**
   - Query `oe.v_ARM_Export_Data` view
   - Filter by Group IDs (if specified)
   - Filter by date range (if provided)
   - Returns all member records matching criteria

3. **Format Data**
   - Convert to CSV, JSON, XML, or TXT based on vendor settings
   - Apply file naming template

4. **Apply Processing** (if enabled)
   - **Compression**: Create ZIP archive
   - **Encryption**: Encrypt file content

5. **Send Export**
   - **SFTP**: Upload to vendor's SFTP server
   - **API**: POST file to vendor's API endpoint

6. **Send Notification** (if enabled)
   - Email notification to vendor when SFTP file is ready

## Data Source: `oe.v_ARM_Export_Data` View

This view maps OpenEnroll tables to ARM format:

**Source Tables**:
- `oe.Members` - Member information
- `oe.Users` - User/contact information
- `oe.Groups` - Group information
- `oe.GroupLocations` - Location information
- `oe.Enrollments` - Enrollment records
- `oe.Products` - Product information

**Key Mappings**:
- Employee vs Dependent: Based on `RelationshipType` (P = Employee, S/C = Dependent)
- SSN: From `oe.Members.ssn` column
- Eligibility Flags: Based on enrollment status and product types
- Dates: Formatted as MM/dd/yyyy for ARM compatibility

## Example Usage

### Manual Export via Frontend

1. Go to **SysAdmin Portal → Vendors**
2. Click **Edit** on a vendor
3. Go to **Integration** tab
4. Configure export settings (SFTP/API, schedule, etc.)
5. Save vendor
6. Use API endpoint to trigger export manually

### Scheduled Export Setup

1. Configure the vendor **connection** on the **Integration** tab (Export Method, SFTP host/user/password, default paths, etc.).
2. Add one or more rows on the **Scheduled jobs** tab (or rely on legacy schedule fields on the vendor row until migrated).
3. Set `SCHEDULED_JOB_API_KEY` in production and call `POST /api/scheduled-jobs/vendor-exports` from an external scheduler on a short interval so the configured **run time** is hit.

The backend selects due jobs, runs `executeExport` with per-job path/email options when applicable, and sends email notifications per job or vendor rules.

## Dependencies

Install these packages for full functionality:

```bash
npm install csv-stringify      # CSV formatting (already installed)
npm install archiver            # ZIP compression
npm install ssh2-sftp-client   # SFTP uploads
npm install form-data           # API file uploads
npm install axios               # API requests (already installed)
```

## Troubleshooting

### Export returns no data
- Check if Group IDs filter is too restrictive
- Verify date range includes recent enrollments
- Check `oe.v_ARM_Export_Data` view has data

### SFTP upload fails
- Verify SFTP credentials are correct
- Check SFTP server is accessible
- Verify port number (usually 22)
- Check firewall rules

### API send fails
- Verify API base URL is correct
- Check API token is valid
- Verify API endpoint accepts file uploads
- Check network connectivity
