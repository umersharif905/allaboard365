# Vendor Export Change Tracking System

## Overview

This system provides comprehensive change tracking for vendor exports, supporting both "All Records" and "Changes Only" export modes per vendor. It automatically tracks changes to member data (address, name, SSN, DOB) and enrollment status (new enrollments, terminations).

## Key Features

1. **Test Data Flagging**: `IsTestData` flag on Members table to exclude test data from exports
2. **Change Detection**: Automatic tracking of data changes via database triggers
3. **Export Tracking**: Records what was sent to each vendor and when
4. **Flexible Export Modes**: 
   - **All**: Send all records every time
   - **Changes**: Send only new members and changes since last export
5. **Vendor-Agnostic**: Works for all vendors, not just ARM

## Database Schema

### 1. `oe.Members.IsTestData` (BIT)
- Flags test data that should be excluded from exports
- Default: 0 (not test data)
- Automatically set for MightyWELL test groups

### 2. `oe.VendorExportTracking`
Tracks what has been exported to each vendor:
- `VendorId`, `MemberId`, `EnrollmentId`
- `ExportType`: 'New', 'Update', 'Termination', 'All'
- `ChangeType`: 'Address', 'Name', 'SSN', 'DOB', 'NewEnrollment', 'Termination'
- `LastExportedDate`: When the record was last sent
- `LastExportedDataHash`: Hash of exported data for change detection
- `ExportBatchId`: Groups exports from the same batch

### 3. `oe.MemberDataSnapshots`
Stores snapshots of member data when changes occur:
- Captures: Name, Address, SSN (hashed), DOB, Email, Phone, etc.
- Used to detect what changed between exports
- Automatically created by triggers when data changes

### 4. `oe.Vendors.ExportType`
- `'All'`: Send all records every export
- `'Changes'`: Send only new/changed records

## Automatic Change Tracking

### Triggers

1. **`oe.trg_MemberDataChangeTracking`**
   - Fires on `oe.Members` updates
   - Tracks: Address, City, State, Zip, DOB, SSN, HireDate, Status, TerminationDate
   - Creates snapshots for vendors with `ExportType = 'Changes'`

2. **`oe.trg_UserDataChangeTracking`**
   - Fires on `oe.Users` updates
   - Tracks: FirstName, LastName, Email, PhoneNumber
   - Creates snapshots for affected members

## Usage

### Setup

1. **Run the schema script:**
   ```sql
   -- Run: Project Docs/vendor-export-change-tracking-schema.sql
   ```

2. **Configure vendors:**
   ```sql
   -- Set vendor to "All Records" mode
   UPDATE oe.Vendors SET ExportType = 'All' WHERE VendorId = '...';
   
   -- Set vendor to "Changes Only" mode
   UPDATE oe.Vendors SET ExportType = 'Changes' WHERE VendorId = '...';
   ```

3. **Mark test data:**
   ```sql
   -- Mark specific members as test data
   UPDATE oe.Members SET IsTestData = 1 WHERE MemberId = '...';
   
   -- Mark entire group as test data
   UPDATE oe.Members SET IsTestData = 1 WHERE GroupId = '...';
   ```

### Export Process

1. **Generate Export Data:**
   - Service checks vendor's `ExportType`
   - If `'All'`: Returns all records (excluding test data)
   - If `'Changes'`: Returns only new/changed records since last export

2. **Detect Changes:**
   - Uses `oe.sp_DetectVendorExportChanges` stored procedure
   - Identifies: New members, Updated members, Terminations

3. **Record Export:**
   - After successful export, records are written to `oe.VendorExportTracking`
   - Includes export batch ID for tracking

## Change Types Detected

- **New**: Member/enrollment not previously exported
- **Update**: Member data changed (address, name, SSN, DOB, etc.)
- **Termination**: Enrollment or member terminated
- **All**: All records (when ExportType = 'All')

## Benefits

1. **Efficiency**: Only sends changed data when vendor wants it
2. **Accuracy**: Tracks exactly what was sent and when
3. **Flexibility**: Each vendor can have different export requirements
4. **Test Data Exclusion**: Simple flag-based exclusion
5. **Audit Trail**: Complete history of what was exported

## Next Steps

1. Run the schema migration script
2. Update vendor export service to use change tracking
3. Configure each vendor's ExportType
4. Mark test data appropriately
5. Test exports in both modes
