# GUID Conversion Solution - Critical Fix

**Date:** 2025-10-29  
**Problem:** `Conversion failed when converting from a character string to uniqueidentifier` error when inserting into `oe.MessageQueue`  
**Resolution Time:** Multiple days of debugging

## Problem

When trying to insert records into `oe.MessageQueue` using the `mssql` Node.js library with parameterized queries, we encountered persistent GUID conversion errors:

```
Error: Conversion failed when converting from a character string to uniqueidentifier.
```

This occurred even when:
- Using `sql.UniqueIdentifier` parameter types
- Using `sql.VarChar` with `CAST(@tenantId AS UNIQUEIDENTIFIER)` in SQL
- Validating GUID format before insertion

## Root Cause

The issue was **multiple problems**:

1. **Parameter Type Mismatch**: When passing `UNIQUEIDENTIFIER` columns as parameters, the `mssql` library (specifically in Azure Functions environment) was having trouble converting string GUIDs to `UNIQUEIDENTIFIER` type.

2. **Mixed Parameter Types**: The `CreatedBy` column is `UNIQUEIDENTIFIER`, but we were trying to pass `'System'` as a string using `sql.NVarChar`, which caused SQL Server to fail on conversion.

## Solution

**Embed GUIDs directly in SQL query as string literals** - Do NOT use parameters for `UNIQUEIDENTIFIER` columns.

### Working Pattern

```javascript
// ✅ CORRECT: Embed GUIDs directly in SQL
const escapeSqlString = (str) => String(str).replace(/'/g, "''"); // Escape single quotes
const recipientIdValue = cleanRecipientId ? `'${escapeSqlString(cleanRecipientId)}'` : 'NULL';

const query = `
  INSERT INTO oe.MessageQueue (
    MessageId, TenantId, RecipientId, MessageType,
    RecipientAddress, Subject, Body, Status,
    RetryCount, CreatedDate, CreatedBy
  ) VALUES (
    NEWID(), 
    '${escapeSqlString(cleanTenantId)}',  -- Embedded GUID string
    ${recipientIdValue},                   -- Embedded GUID or NULL
    @messageType,                          -- Use parameters for NVARCHAR
    @recipientAddress,                     -- Use parameters for NVARCHAR
    @subject,                              -- Use parameters for NVARCHAR
    @body,                                 -- Use parameters for NVARCHAR(MAX)
    'Pending',
    0, 
    GETUTCDATE(), 
    NULL                                   -- Embedded NULL, NOT a parameter
  )
`;

const request = pool.request();
// Only set parameters for NON-GUID columns
request.input('messageType', sql.NVarChar, 'Email');
request.input('recipientAddress', sql.NVarChar, groupContactEmail);
request.input('subject', sql.NVarChar, subject);
request.input('body', sql.NVarChar(sql.MAX), emailBody);

await request.query(query);
```

### Why This Works

1. **SQL Server accepts GUID strings directly** - You can use `'1CD92AF7-B6F2-4E48-A8F3-EC6316158826'` directly in SQL and SQL Server will automatically convert it to `UNIQUEIDENTIFIER`.

2. **No library conversion needed** - By embedding GUIDs as strings, we bypass the `mssql` library's parameter conversion entirely.

3. **Safe from SQL Injection** - As long as you:
   - Validate GUID format with regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
   - Escape single quotes: `str.replace(/'/g, "''")`
   - Only embed values that have been validated

### What NOT to Do

```javascript
// ❌ WRONG: Don't use parameters for UNIQUEIDENTIFIER
request.input('tenantId', sql.UniqueIdentifier, tenantId); // Fails in Azure Functions!
request.input('createdBy', sql.NVarChar, 'System'); // Wrong type!

// ❌ WRONG: Don't try CAST with parameters
CAST(@tenantId AS UNIQUEIDENTIFIER) // Still fails with parameter conversion

// ❌ WRONG: Don't mix types
'${tenantId}' AND @createdBy -- Mixed approach causes issues
```

## Key Lessons

1. **UNIQUEIDENTIFIER columns should be embedded as strings in SQL queries** when using the `mssql` library in Azure Functions.

2. **Always validate GUID format** before embedding to prevent SQL injection.

3. **Use parameters only for NVARCHAR, INT, etc.** - Not for UNIQUEIDENTIFIER in this environment.

4. **Check column types** - `CreatedBy`, `TenantId`, `RecipientId` are all `UNIQUEIDENTIFIER`, not strings.

## Related Files

- `oe_payment_manager/DimeWebhookHandler/index.js` - `sendPaymentFailureNotification` function
- `backend/services/messageQueue.service.js` - Working backend implementation (uses different approach)

## References

- Error: SQL Server Error 8169 - "Conversion failed when converting from a character string to uniqueidentifier"
- Table: `oe.MessageQueue` columns: `MessageId`, `TenantId`, `RecipientId`, `CreatedBy` are all `UNIQUEIDENTIFIER`

