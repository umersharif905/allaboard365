# ARM Vendor Export Setup Guide

## Overview

This document describes how to set up and use the ARM (vendor) weekly export functionality in OpenEnroll. The export generates CSV files in the ARM Enrollment Import Layout format for weekly data transmission to ARM.

## Prerequisites

1. SQL Server database with OpenEnroll schema
2. Node.js backend with required dependencies
3. Admin access (SysAdmin or TenantAdmin role)

## Installation Steps

### 1. Database Setup

Run the SQL scripts in order:

```sql
-- Step 1: Create the view for ARM export data mapping
-- Execute: Project Docs/arm-export-view.sql

-- Step 2: Create the stored procedure for weekly exports
-- Execute: Project Docs/arm-export-query.sql
```

These scripts will create:
- `oe.v_ARM_Export_Data` - View that maps OpenEnroll schema to ARM format
- `oe.sp_ARM_WeeklyExport` - Stored procedure for generating exports with date filtering

### 2. Backend Dependencies

Install the CSV stringify package (if not already installed):

```bash
npm install csv-stringify
```

### 3. API Endpoint

The ARM export endpoint is automatically available at:
- **GET** `/api/me/vendor/arm-export`
- **POST** `/api/me/vendor/arm-export/schedule` (for future scheduling)

## Usage

### Manual Export via API

#### Generate CSV Export (Default - Last 7 Days)

```bash
GET /api/me/vendor/arm-export
Authorization: Bearer <token>
```

#### Generate CSV Export with Custom Date Range

```bash
GET /api/me/vendor/arm-export?enrollmentDateStart=2025-01-01&terminationDateStart=2025-01-01
Authorization: Bearer <token>
```

#### Generate JSON Export

```bash
GET /api/me/vendor/arm-export?format=json&enrollmentDateStart=2025-01-01
Authorization: Bearer <token>
```

### Direct SQL Query

You can also run the stored procedure directly in SQL Server:

```sql
-- Export last 7 days (default)
EXEC oe.sp_ARM_WeeklyExport;

-- Export specific date range
EXEC oe.sp_ARM_WeeklyExport 
    @enrollmentDateStart = '2025-01-01',
    @terminationDateStart = '2025-01-01';

-- Export as JSON
EXEC oe.sp_ARM_WeeklyExport @outputFormat = 'JSON';
```

### Weekly Scheduled Export

To set up automated weekly exports, you can:

1. **SQL Server Agent Job** (Recommended for on-premise):
   - Create a SQL Server Agent job
   - Schedule it to run weekly (e.g., every Monday at 2 AM)
   - Execute: `EXEC oe.sp_ARM_WeeklyExport`
   - Export results to CSV file
   - Send file to ARM via SFTP/email

2. **Azure Functions** (For cloud deployments):
   - Create an Azure Function with a timer trigger
   - Call the API endpoint: `GET /api/me/vendor/arm-export`
   - Save CSV to Azure Blob Storage
   - Send to ARM via SFTP/email

3. **Node.js Cron Job** (For application-level scheduling):
   - Use `node-cron` package
   - Schedule weekly execution
   - Call the API endpoint internally
   - Send file to ARM

## Data Mapping

The export maps OpenEnroll data to ARM format as follows:

### Core Fields

| ARM Field | OpenEnroll Source | Notes |
|-----------|------------------|-------|
| Group Number | `Groups.Name` | Group name (consider adding GroupNumber field if ARM requires specific format) |
| Location Number | `GroupLocations.LocationId` | Location identifier |
| Employee Or Dependent | `Members.RelationshipType` | E for Primary (P), D for Dependents (S, C) |
| Employee SSN | `Members.SSN` | **TODO: Add SSN field to Members table** |
| Dependent SSN | `Members.SSN` | **TODO: Add SSN field to Members table** |
| Last Name | `Users.LastName` | |
| First Name | `Users.FirstName` | |
| Gender | `Members.Gender` | M/F mapping |
| Employee Date Of Birth | `Members.DateOfBirth` | Primary member's DOB |
| Dependent Date Of Birth | `Members.DateOfBirth` | Dependent's DOB |
| Date Of Hire | `Members.HireDate` | Primary member's hire date |
| Enrollment Date | `Enrollments.EffectiveDate` | Earliest active enrollment |
| Termination Date | `Members.TerminationDate` or `Enrollments.TerminationDate` | Member or enrollment termination |
| Address | `Members.Address`, `City`, `State`, `Zip` | |
| Email | `Users.Email` | |
| Phone | `Users.PhoneNumber` | Used for Home Phone and Cell Phone |

### Eligibility Fields

Eligibility is determined by checking for active enrollments with matching product types:

- **Medical Eligibility**: Products with `ProductType = 'Healthcare'` or `'Medical'`
- **Dental Eligibility**: Products with `ProductType = 'Dental'`
- **Vision Eligibility**: Products with `ProductType = 'Vision'`
- **Drug Eligibility**: Products with `ProductType LIKE '%Drug%'` or `'%Prescription%'`
- **Life Eligibility**: Products with `ProductType = 'Life Insurance'` or `LIKE '%Life%'`
- **LTD Eligibility**: Products with `ProductType = 'Disability'` or `LIKE '%LTD%'`
- **STD Eligibility**: Products with `ProductType LIKE '%STD%'` or `'%Short Term Disability%'`

All COB (Coordination of Benefits) fields default to 'F' (False).

### Relationship Codes

| OpenEnroll | ARM Code | Description |
|------------|----------|-------------|
| P (Primary) | S | Self/Primary |
| S (Spouse) | P | Spouse |
| C (Child) | C | Child |

## Fields Requiring Additional Setup

The following fields are currently empty and may need to be populated:

1. **SSN Fields** (`Employee SSN`, `Dependent SSN`)
   - **Action**: Add `SSN` column to `oe.Members` table
   - **Consideration**: Ensure proper encryption/security for SSN data

2. **Group Number**
   - **Current**: Uses `Groups.Name`
   - **Action**: If ARM requires a specific format, add `GroupNumber` field to `Groups` table

3. **Volume Fields** (`Life Volume`, `STD Volume`, etc.)
   - **Current**: Empty
   - **Action**: Calculate based on coverage amounts from enrollments if needed

4. **EFT/Banking Fields**
   - **Current**: Empty
   - **Action**: Decrypt and map from `oe.GroupPaymentMethods` (encrypted via DIME)
   - **Note**: Requires DIME decryption service integration

5. **Additional Optional Fields**:
   - Middle Initial
   - Name Suffix
   - Work Phone
   - Fax Number
   - Country/Country Code
   - Marriage Status/Date
   - Student Status/Date
   - Salary

## Filtering Logic

The export includes members where:

1. **Enrollment Date Filter**: Members with enrollment dates >= `enrollmentDateStart`
   - OR members with no enrollment date (empty string)

2. **Termination Date Filter**: Members with termination dates >= `terminationDateStart`
   - AND termination date is not empty
   - AND termination date is not '1/1/1900'

3. **Status Filter**: Only includes members with status 'Active' or 'Terminated'

## Export Format

### CSV Format

The CSV export matches the ARM Enrollment Import Layout exactly:
- Headers match ARM specification
- All fields are quoted
- Empty fields are included as empty strings
- Dates formatted as `M/d/yyyy` (e.g., `3/1/2025`)

### JSON Format

The JSON export returns the same data in JSON format for API consumption:
- Useful for integration with other systems
- Same filtering and mapping logic

## Troubleshooting

### No Data Returned

1. **Check Date Range**: Ensure the date range includes members with enrollments/terminations
2. **Check Member Status**: Only 'Active' and 'Terminated' members are included
3. **Check Enrollments**: Members must have active enrollments to appear

### Missing Fields

1. **SSN Fields**: Add SSN column to Members table if required
2. **Group Number**: Verify Groups.Name is populated or add GroupNumber field
3. **Eligibility Fields**: Ensure products have correct ProductType values

### Performance Issues

1. **Index Optimization**: Ensure indexes exist on:
   - `Members.HouseholdId`
   - `Members.RelationshipType`
   - `Enrollments.MemberId`
   - `Enrollments.Status`
   - `Enrollments.EffectiveDate`
   - `Products.ProductType`

2. **Date Range**: Limit date ranges for large exports
3. **Batch Processing**: For very large exports, consider batching by GroupId

## Security Considerations

1. **SSN Data**: If SSN fields are added, ensure proper encryption at rest and in transit
2. **Access Control**: Only SysAdmin and TenantAdmin can access export endpoint
3. **Audit Logging**: Consider logging all export requests for compliance
4. **File Storage**: If storing exported files, ensure secure storage with proper access controls

## Future Enhancements

1. **Automated Scheduling**: Implement job scheduler for weekly automatic exports
2. **SFTP Integration**: Automatically send exports to ARM via SFTP
3. **Email Notifications**: Send export completion notifications
4. **Export History**: Track export history and allow re-download of previous exports
5. **Field Mapping Configuration**: Allow configuration of field mappings via UI
6. **Data Validation**: Add validation rules to ensure data quality before export

## Support

For issues or questions:
1. Check SQL Server logs for stored procedure errors
2. Check Node.js application logs for API errors
3. Verify database schema matches expected structure
4. Review this documentation for configuration requirements

## Related Files

- `Project Docs/arm-export-view.sql` - SQL view definition
- `Project Docs/arm-export-query.sql` - Stored procedure and query examples
- `backend/routes/me/vendor/arm-export.js` - API endpoint implementation
- `c:\Users\WhoDat\Desktop\ARM Enrollment Import Layout.csv` - ARM format specification

