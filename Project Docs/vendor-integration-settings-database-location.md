# Vendor Integration Settings - Database Storage Location

All vendor integration settings are stored in the **`oe.Vendors`** table.

## Database Table: `oe.Vendors`

The following columns have been added to store the integration settings:

### Group ID Configuration
- **`ExportGroupIds`** (NVARCHAR(MAX)) - JSON array of Group IDs to export

### SFTP Settings
- **`SftpHostname`** (NVARCHAR(255)) - SFTP server hostname
- **`SftpPort`** (INT) - SFTP server port (typically 22)
- **`SftpUsername`** (NVARCHAR(100)) - SFTP username
- **`SftpPassword`** (NVARCHAR(MAX)) - SFTP password (encrypted)

### Email Notification Settings
- **`ExportEmailAddress`** (NVARCHAR(255)) - Email address to notify when SFTP files are ready
- **`ExportEmailEnabled`** (BIT) - Whether to send email notifications (0 = disabled, 1 = enabled)

### API Settings
- **`ApiBaseUrl`** (NVARCHAR(500)) - Base URL for API endpoint
- **`ApiToken`** (NVARCHAR(MAX)) - API authentication token (encrypted)
- **`ApiEnabled`** (BIT) - Whether API export is enabled (0 = disabled, 1 = enabled)

### Export Schedule Settings
- **`ExportSchedule`** (NVARCHAR(100)) - Schedule type: "daily", "weekly", or "monthly"
- **`ExportScheduleDay`** (NVARCHAR(20)) - Day of week for weekly schedule (Monday, Tuesday, etc.)
- **`ExportScheduleTime`** (NVARCHAR(10)) - Time to run export in HH:mm format (e.g., "14:30")

### Export Method
- **`ExportMethod`** (NVARCHAR(50)) - Export method: "SFTP" or "API" (only one method per vendor)

## Migration Script

To add these columns to your database, run:
**`Project Docs/vendor-integration-settings-schema.sql`**

This script will:
1. Check if each column exists
2. Add the column if it doesn't exist
3. Handle existing columns gracefully

## Security Notes

- **`SftpPassword`** and **`ApiToken`** are encrypted using the application's encryption service before being stored
- These encrypted values are never returned in plain text by the API
- Only authorized users (SysAdmin, TenantAdmin) can view/edit these settings

## Example Data

```sql
-- Example vendor with SFTP configuration
SELECT 
    VendorId,
    VendorName,
    ExportMethod,              -- 'SFTP'
    SftpHostname,              -- 'sftp.vendor.com'
    SftpPort,                  -- 22
    SftpUsername,              -- 'vendor_user'
    ExportEmailAddress,        -- 'notifications@vendor.com'
    ExportEmailEnabled,        -- 1 (true)
    ExportSchedule,            -- 'weekly'
    ExportScheduleDay,         -- 'Monday'
    ExportScheduleTime,        -- '09:00'
    ExportGroupIds             -- '["group-id-1", "group-id-2"]'
FROM oe.Vendors
WHERE VendorId = '...'
```
