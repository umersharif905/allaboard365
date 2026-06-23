# Mid-Month Effective Date — DBA Runbook

**Audience:** DBA or someone with `db_owner` on Azure SQL `allaboard-testing` (dev) and `allaboard-prod` (prod).
**Prereqs:** `sqlcmd`, `mssql` npm package, or SSMS. You can run all of this from a Node script using the existing `backend/.env` credentials.

## 0. Extract current SP bodies (so you have a backup)

Run from the repo root:

```bash
cd backend && node -e "
require('dotenv').config();
const sql = require('mssql');
(async () => {
  const pool = await sql.connect({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false }
  });
  const names = ['sp_CalculateGroupTotalPremium', 'sp_GenerateGroupInvoices'];
  for (const name of names) {
    const r = await pool.request().input('n', sql.NVarChar, name).query(\`
      SELECT m.definition
      FROM sys.sql_modules m
      INNER JOIN sys.objects o ON o.object_id = m.object_id
      INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = 'oe' AND o.name = @n
    \`);
    const def = r.recordset[0]?.definition;
    if (def) {
      require('fs').writeFileSync(\`/tmp/oe.\${name}.backup.sql\`, def);
      console.log('Saved /tmp/oe.' + name + '.backup.sql');
    } else console.log('NOT FOUND:', name);
  }
  await pool.close();
})();"
```

Review the backups before modifying.

## 1. `oe.sp_CalculateGroupTotalPremium`

**Current contract (from JS callers):**
- Inputs: `@GroupId UNIQUEIDENTIFIER`, `@BillingDate DATETIME2`
- Output recordset: `TotalPremium DECIMAL(19,4)`, `ActiveEnrollmentCount INT`

**Change required:** The SP likely filters like `e.EffectiveDate <= EOMONTH(@BillingDate)`. Modify so the upper bound is the end of the **cohort period**, not the calendar month:

- If `@BillingDate.day = 1`, upper bound = `EOMONTH(@BillingDate)` (last day of that calendar month) — unchanged.
- If `@BillingDate.day = 15`, upper bound = `DATEADD(day, 14, DATEADD(month, 1, @BillingDate))` (14th of next month).

**ALTER script (template — merge with the backup):**

```sql
ALTER PROCEDURE oe.sp_CalculateGroupTotalPremium
  @GroupId UNIQUEIDENTIFIER,
  @BillingDate DATETIME2 = NULL
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @BD DATETIME2 = ISNULL(@BillingDate, CAST(GETUTCDATE() AS DATE));
  DECLARE @PeriodStart DATE = CAST(@BD AS DATE);
  DECLARE @PeriodEnd DATE;

  IF DAY(@BD) = 15
    SET @PeriodEnd = DATEADD(day, -1, DATEADD(month, 1, @PeriodStart));
  ELSE
    SET @PeriodEnd = EOMONTH(@BD);

  SELECT
    SUM(e.PremiumAmount) AS TotalPremium,
    COUNT(DISTINCT e.EnrollmentId) AS ActiveEnrollmentCount
  FROM oe.Enrollments e
  INNER JOIN oe.Members m ON m.MemberId = e.MemberId
  WHERE m.GroupId = @GroupId
    AND e.Status = 'Active'
    AND e.EnrollmentType = 'Product'
    AND CAST(e.EffectiveDate AS DATE) <= @PeriodEnd
    AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) >= @PeriodStart)
    AND DAY(e.EffectiveDate) = DAY(@BD);  -- cohort filter: only members whose EffectiveDate matches
END;
```

**Note:** The `DAY(e.EffectiveDate) = DAY(@BD)` filter is critical — it's what separates the cohorts.

## 2. `oe.sp_GenerateGroupInvoices`

**Current contract:** Takes `@GroupId`, `@BillingDate`. Creates `oe.Invoices` rows for the group, fire-and-forget.

**Change required:** Generate invoices with cohort-aware `BillingPeriodStart/End`, and only include members whose `EffectiveDate.day` matches `@BillingDate.day`.

**ALTER script (template):**

```sql
ALTER PROCEDURE oe.sp_GenerateGroupInvoices
  @GroupId UNIQUEIDENTIFIER,
  @BillingDate DATETIME2 = NULL
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @BD DATE = CAST(ISNULL(@BillingDate, GETUTCDATE()) AS DATE);
  DECLARE @PeriodStart DATE = @BD;
  DECLARE @PeriodEnd DATE;

  IF DAY(@BD) = 15
    SET @PeriodEnd = DATEADD(day, -1, DATEADD(month, 1, @PeriodStart));
  ELSE
  BEGIN
    SET @PeriodStart = DATEFROMPARTS(YEAR(@BD), MONTH(@BD), 1);
    SET @PeriodEnd = EOMONTH(@PeriodStart);
  END;

  -- Create invoice only for members in the matching cohort
  INSERT INTO oe.Invoices (
    InvoiceId, GroupId, InvoiceNumber, InvoiceDate,
    BillingPeriodStart, BillingPeriodEnd, Status, TotalAmount, CreatedDate
  )
  SELECT
    NEWID(),
    @GroupId,
    'INV-' + CONVERT(VARCHAR, GETUTCDATE(), 112) + '-' + CONVERT(VARCHAR(8), @GroupId),
    GETUTCDATE(),
    @PeriodStart,
    @PeriodEnd,
    'Pending',
    (SELECT SUM(e.PremiumAmount)
     FROM oe.Enrollments e
     INNER JOIN oe.Members m ON m.MemberId = e.MemberId
     WHERE m.GroupId = @GroupId
       AND e.Status = 'Active'
       AND e.EnrollmentType = 'Product'
       AND DAY(e.EffectiveDate) = DAY(@BD)
       AND CAST(e.EffectiveDate AS DATE) <= @PeriodEnd
       AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) >= @PeriodStart)),
    GETUTCDATE()
  WHERE EXISTS (
    SELECT 1 FROM oe.Enrollments e
    INNER JOIN oe.Members m ON m.MemberId = e.MemberId
    WHERE m.GroupId = @GroupId
      AND e.Status = 'Active'
      AND DAY(e.EffectiveDate) = DAY(@BD)
  );
END;
```

**Note:** This is a schematic. The actual SP likely has more complexity (invoice number generation via `sp_GetNextInvoiceNumber`, per-member detail rows, etc.). Merge into the backup using the cohort-aware period math as the guiding change.

## 3. Deployment steps — dev first, then prod

### Dev (`allaboard-testing`)

```bash
# Apply the updated SP to dev
cd backend && node -e "
require('dotenv').config();
const sql = require('mssql');
const fs = require('fs');
(async () => {
  const pool = await sql.connect({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false, requestTimeout: 60000 }
  });
  const sqlText = fs.readFileSync('/tmp/sp_CalculateGroupTotalPremium.alter.sql', 'utf8');
  await pool.request().query(sqlText);
  console.log('Updated sp_CalculateGroupTotalPremium on dev');
  await pool.close();
})();"
```

### Verification query (dev)

```sql
-- Verify the SP runs with both 1st and 15th dates
EXEC oe.sp_CalculateGroupTotalPremium
  @GroupId = '<test-group-id>', @BillingDate = '2026-05-01';
EXEC oe.sp_CalculateGroupTotalPremium
  @GroupId = '<test-group-id>', @BillingDate = '2026-05-15';
-- Expect: row 1 returns premiums for 1st-cohort members, row 2 for 15th-cohort members.
```

### Prod (`allaboard-prod`)

Same procedure but override `DB_NAME=allaboard-prod` on the CLI. Do this only AFTER backend PR is merged and deployed.

## 4. Rollback

Keep the original SP backup at `/tmp/oe.sp_*.backup.sql`. To roll back, `ALTER PROCEDURE` using the backup text.
