# How to Test Vendor CSV Export

## Quick Test Methods

### Method 1: Test Export (Dry Run - Recommended First)

This generates the export data but **doesn't send it**. Use this to verify the data is correct before actually sending.

**Using cURL:**
```bash
curl -X GET "http://localhost:3001/api/vendors/{VENDOR_ID}/export/test" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"
```

**Using Postman/Thunder Client:**
- **Method**: GET
- **URL**: `http://localhost:3001/api/vendors/{VENDOR_ID}/export/test`
- **Headers**:
  - `Authorization: Bearer YOUR_TOKEN`
  - `Content-Type: application/json`

**Response:**
```json
{
  "success": true,
  "message": "Test export data generated",
  "data": {
    "vendorName": "ARM",
    "exportMethod": "SFTP",
    "fileFormat": "CSV",
    "recordCount": 150,
    "sampleRecord": { ... },
    "fileName": "vendor-export-20250111-1705123456.csv"
  }
}
```

### Method 2: Actual Export (Sends File)

This **actually generates and sends** the CSV file via SFTP or API.

**Using cURL:**
```bash
curl -X POST "http://localhost:3001/api/vendors/{VENDOR_ID}/export" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "enrollmentDateStart": "2025-01-01",
    "terminationDateStart": "2025-01-01"
  }'
```

**Using Postman/Thunder Client:**
- **Method**: POST
- **URL**: `http://localhost:3001/api/vendors/{VENDOR_ID}/export`
- **Headers**:
  - `Authorization: Bearer YOUR_TOKEN`
  - `Content-Type: application/json`
- **Body** (optional - for date filtering):
```json
{
  "enrollmentDateStart": "2025-01-01",
  "terminationDateStart": "2025-01-01"
}
```

**Response:**
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

## Prerequisites

Before testing, make sure:

1. **Vendor is configured** with:
   - Export Method: SFTP or API
   - SFTP settings (hostname, port, username, password) OR API settings (base URL, token)
   - File Format: CSV (or JSON/XML/TXT)

2. **Get the Vendor ID**:
   - Go to SysAdmin Portal → Vendors
   - Click Edit on the vendor
   - The Vendor ID is in the URL or you can get it from the browser console

3. **Get your Auth Token**:
   - Login to the frontend
   - Open browser DevTools → Application/Storage → Local Storage
   - Look for `token` or `access_token`
   - Or use the Network tab to copy the Authorization header from any API request

## Step-by-Step Testing

### Step 1: Verify Vendor Configuration

1. Open the vendor in Edit mode
2. Go to **Integration** tab
3. Verify:
   - Export Method is set (SFTP or API)
   - SFTP credentials are filled (if using SFTP)
   - API settings are filled (if using API)
   - File Format is set to CSV

### Step 2: Test Export (Dry Run)

Use the test endpoint first to verify:
- Data is generated correctly
- Record count is expected
- File format is correct

```bash
GET /api/vendors/{VENDOR_ID}/export/test
```

### Step 3: Test SFTP Connection (If Using SFTP)

Before running the actual export, test the SFTP connection:

```bash
POST /api/vendors/{VENDOR_ID}/export/test-connection
```

This verifies the SFTP credentials work.

### Step 4: Run Actual Export

Once everything is verified, run the actual export:

```bash
POST /api/vendors/{VENDOR_ID}/export
```

## What Gets Exported?

The export uses the **`oe.v_ARM_Export_Data`** SQL view which includes:

- **80+ fields** matching ARM Enrollment Import Layout
- Member information (name, SSN, DOB, address, phone, email)
- Enrollment dates and termination dates
- Product eligibility flags (Medical, Dental, Vision, Drug, Life, LTD, STD)
- Coverage details (COB flags, volumes, salary)
- Group and location information
- Payment/EFT account details

## Troubleshooting

### "Vendor not found"
- Verify the Vendor ID is correct
- Check the vendor exists in the database

### "Export method not configured"
- Go to Integration tab and set Export Method (SFTP or API)

### "SFTP connection failed"
- Test the connection first using `/export/test-connection`
- Verify SFTP credentials are correct
- Check SFTP server is accessible
- Verify port number (usually 22)

### "No data returned"
- Check if there are enrollments in the database
- Verify date range includes recent enrollments
- Check the `oe.v_ARM_Export_Data` view has data

### Export succeeds but file not on SFTP server
- Check SFTP server logs
- Verify the remote path is correct
- Check file permissions on SFTP server
- Verify the file was actually uploaded (check file size in response)

## Example: Complete Test Flow

```bash
# 1. Get vendor ID (from browser or database)
VENDOR_ID="406B4EEA-F334-4EFC-82D5-89545E55CC01"

# 2. Test export (dry run)
curl -X GET "http://localhost:3001/api/vendors/$VENDOR_ID/export/test" \
  -H "Authorization: Bearer YOUR_TOKEN"

# 3. Test SFTP connection (if using SFTP)
curl -X POST "http://localhost:3001/api/vendors/$VENDOR_ID/export/test-connection" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"

# 4. Run actual export
curl -X POST "http://localhost:3001/api/vendors/$VENDOR_ID/export" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "enrollmentDateStart": "2025-01-01",
    "terminationDateStart": "2025-01-01"
  }'
```

## Notes

- **Date filtering is optional** - if not provided, exports all data
- **File format** is determined by vendor's `ExportFileFormat` setting (CSV, JSON, XML, TXT)
- **Compression and encryption** are applied if enabled in vendor settings
- **Email notification** is sent if `ExportEmailEnabled` is true and SFTP is used
