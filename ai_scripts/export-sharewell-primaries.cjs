/**
 * Export ShareWELL primary members enrolled in healthshare to xlsx.
 * Healthshare products: Essential (Sharewell), Essential Wellness, ShareWELL *, Essential(Align Health), Essential(Calstar)
 * Active enrollment: termination_date IS NULL (mimics v_PowerBI_Export - no effective_date filter)
 * Dedup: one per unique email; if no email, one per unique first_name + last_name
 *
 * Columns: partner_name (platform from partners.partner_name), first_name, last_name, relationship, email
 * Usage: ./ai_scripts/export-sharewell-primaries.sh [YYYY-MM-DD] [--csv]
 *   With no arg: report as of today. With a date: report as of that date (e.g. 2026-01-14).
 *   --csv writes CSV + a one-row summary file (same query/columns as xlsx).
 *
 * Env (optional): SHAREWELL_DB_SERVER, SHAREWELL_DB_NAME or SHAREWELL_DB_DATABASE, SHAREWELL_DB_USER, SHAREWELL_DB_PASSWORD
 *   SHAREWELL_AS_OF_DATE=YYYY-MM-DD overrides CLI date if set.
 */

const fs = require('fs')
const path = require('path')
const sql = require('mssql')

const cliArgs = process.argv.slice(2).filter((a) => a !== '--csv')
const csvMode = process.argv.includes('--csv')

const config = {
  server: process.env.SHAREWELL_DB_SERVER || 'swp-sql-srvr.database.windows.net',
  database: process.env.SHAREWELL_DB_NAME || process.env.SHAREWELL_DB_DATABASE || 'ShareWELLPartners',
  user: process.env.SHAREWELL_DB_USER || 'powerappslogin',
  password: process.env.SHAREWELL_DB_PASSWORD || 'PT$r8u7G21@',
  options: { encrypt: true, trustServerCertificate: false }
}

// Optional as-of date (YYYY-MM-DD). If set, enrollment/termination filtered to that date.
const asOfDateRaw = process.env.SHAREWELL_AS_OF_DATE || cliArgs[0] || null
const asOfDate = asOfDateRaw ? asOfDateRaw.trim() : null

function csvEscape (cell) {
  const s = cell == null ? '' : String(cell)
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

function rowsToCsv (headers, rowObjs) {
  const lines = [headers.map(csvEscape).join(',')]
  for (const r of rowObjs) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

const QUERY_NO_DATE = `
  WITH healthshare AS (
    SELECT
      COALESCE(pt.partner_name, '') AS partner_name,
      m.first_name,
      m.last_name,
      m.relationship,
      m.email,
      m.id
    FROM members m
    INNER JOIN accounts a ON m.account_id = a.id
    LEFT JOIN partners pt ON a.partner_id = pt.id
    INNER JOIN member_products mp ON mp.member_id = m.id
    INNER JOIN products p ON p.id = mp.product_id
    WHERE m.relationship = 'P'
      AND m.status = 'Active'
      AND mp.termination_date IS NULL
      AND p.product_name IN (
        'Essential (Sharewell)',
        'Essential Wellness ',
        'ShareWELL Membership Copy Over',
        'ShareWELL Plus ',
        'ShareWELL Connect',
        'Essential(Align Health)',
        'Essential(Calstar)'
      )
  ),
  deduped AS (
    SELECT partner_name, first_name, last_name, relationship, email,
      ROW_NUMBER() OVER (
        PARTITION BY
          CASE
            WHEN email IS NOT NULL AND LTRIM(RTRIM(email)) != ''
            THEN LOWER(LTRIM(RTRIM(email)))
            ELSE LOWER(LTRIM(RTRIM(first_name))) + '_' + LOWER(LTRIM(RTRIM(last_name)))
          END
        ORDER BY id
      ) AS rn
    FROM healthshare
  )
  SELECT partner_name, first_name, last_name, relationship, email
  FROM deduped
  WHERE rn = 1
  ORDER BY partner_name, last_name, first_name
`

const QUERY_AS_OF = `
  WITH healthshare AS (
    SELECT
      COALESCE(pt.partner_name, '') AS partner_name,
      m.first_name,
      m.last_name,
      m.relationship,
      m.email,
      m.id
    FROM members m
    INNER JOIN accounts a ON m.account_id = a.id
    LEFT JOIN partners pt ON a.partner_id = pt.id
    INNER JOIN member_products mp ON mp.member_id = m.id
    INNER JOIN products p ON p.id = mp.product_id
    WHERE m.relationship = 'P'
      AND m.status = 'Active'
      AND (mp.effective_date IS NULL OR mp.effective_date <= @asOfDate)
      AND (mp.termination_date IS NULL OR mp.termination_date > @asOfDate)
      AND p.product_name IN (
        'Essential (Sharewell)',
        'Essential Wellness ',
        'ShareWELL Membership Copy Over',
        'ShareWELL Plus ',
        'ShareWELL Connect',
        'Essential(Align Health)',
        'Essential(Calstar)'
      )
  ),
  deduped AS (
    SELECT partner_name, first_name, last_name, relationship, email,
      ROW_NUMBER() OVER (
        PARTITION BY
          CASE
            WHEN email IS NOT NULL AND LTRIM(RTRIM(email)) != ''
            THEN LOWER(LTRIM(RTRIM(email)))
            ELSE LOWER(LTRIM(RTRIM(first_name))) + '_' + LOWER(LTRIM(RTRIM(last_name)))
          END
        ORDER BY id
      ) AS rn
    FROM healthshare
  )
  SELECT partner_name, first_name, last_name, relationship, email
  FROM deduped
  WHERE rn = 1
  ORDER BY partner_name, last_name, first_name
`

async function run () {
  let pool
  try {
    if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      console.error('Invalid date. Use YYYY-MM-DD (e.g. 2026-01-14).')
      process.exit(1)
    }

    console.log('Connecting to ShareWELL DB...')
    pool = await sql.connect(config)

    const req = pool.request()
    let result
    if (asOfDate) {
      console.log(`Querying primary members as of ${asOfDate}...`)
      req.input('asOfDate', sql.Date, asOfDate)
      result = await req.query(QUERY_AS_OF)
    } else {
      console.log('Querying primary members (current)...')
      result = await req.query(QUERY_NO_DATE)
    }

    const rows = result.recordset || []

    const headers = ['partner_name', 'first_name', 'last_name', 'relationship', 'email']
    const normalized = rows.map((r) => ({
      partner_name: r.partner_name || '',
      first_name: r.first_name || '',
      last_name: r.last_name || '',
      relationship: r.relationship || 'P',
      email: r.email || ''
    }))

    const outDir = path.resolve(__dirname, 'output')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
    const fileDate = asOfDate || new Date().toISOString().slice(0, 10)

    if (csvMode) {
      const csvPath = path.join(outDir, `ShareWELL_primary_members_${fileDate}.csv`)
      fs.writeFileSync(csvPath, rowsToCsv(headers, normalized), 'utf8')
      const summaryPath = path.join(outDir, `ShareWELL_active_primary_sharewell_total_${fileDate}.csv`)
      const summaryHeaders = ['report_as_of_date', 'active_primary_member_count', 'criteria']
      const criteria =
        'Primary (relationship=P), member status Active, healthshare product list, enrollment active on as-of date (effective_date null or <= as-of; termination_date null or > as-of), dedupe by email or first+last'
      const summaryRow = {
        report_as_of_date: fileDate,
        active_primary_member_count: String(rows.length),
        criteria
      }
      fs.writeFileSync(summaryPath, rowsToCsv(summaryHeaders, [summaryRow]), 'utf8')
      console.log(`Active primary members (Sharewell plans) as of ${fileDate}: ${rows.length}`)
      console.log(`Wrote ${rows.length} rows to ${csvPath}`)
      console.log(`Wrote summary to ${summaryPath}`)
    } else {
      const XLSX = require('xlsx')
      const data = [headers, ...normalized.map((r) => headers.map((h) => r[h]))]
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.aoa_to_sheet(data)
      XLSX.utils.book_append_sheet(wb, ws, 'Primary members')
      const outPath = path.join(outDir, `ShareWELL_primary_members_${fileDate}.xlsx`)
      XLSX.writeFile(wb, outPath)
      console.log(`Wrote ${rows.length} rows to ${outPath}`)
    }
  } catch (err) {
    console.error('Error:', err.message)
    process.exit(1)
  } finally {
    if (pool) await pool.close()
  }
}

run()
