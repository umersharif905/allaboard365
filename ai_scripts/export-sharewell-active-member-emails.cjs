/**
 * Export every email for active members from ShareWELL prod DB.
 * Active = members with 1+ active plan (effective_date <= today, termination_date IS NULL or > today).
 * Output: one email per line to output/ShareWELL_active_member_emails_YYYY-MM-DD.txt
 *
 * Run: ./ai_scripts/export-sharewell-active-member-emails.sh
 *   or: node ai_scripts/export-sharewell-active-member-emails.cjs
 *
 * Env (optional): SHAREWELL_DB_SERVER, SHAREWELL_DB_NAME, SHAREWELL_DB_USER, SHAREWELL_DB_PASSWORD
 * See docs/microsoft/SHAREWELL_DB_CREDENTIALS_AZ_CLI.md
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sql = require('mssql');

function getFromFunctionApp() {
  try {
    const out = execSync(
      'az functionapp config appsettings list --name sharewell-csv-processor2 --resource-group ShareWELLPartners --query "[?name==\'SQL_PASSWORD\'].value | [0]" -o tsv',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return (out || '').trim();
  } catch {
    return null;
  }
}

function loadCredentials() {
  const server = process.env.SHAREWELL_DB_SERVER || 'swp-sql-srvr.database.windows.net';
  const database = process.env.SHAREWELL_DB_NAME || 'ShareWELLPartners';
  const user = process.env.SHAREWELL_DB_USER || 'powerappslogin';
  let password = process.env.SHAREWELL_DB_PASSWORD;

  if (!password) {
    password = getFromFunctionApp();
    if (password) console.log('Using password from az functionapp config appsettings');
  } else {
    console.log('Using password from SHAREWELL_DB_PASSWORD env');
  }

  if (!password) {
    password = process.env.SHAREWELL_DB_PASSWORD_FALLBACK || 'PT$r8u7G21@';
    console.log('Using fallback password (set SHAREWELL_DB_PASSWORD or run via export-sharewell-active-member-emails.sh for az)');
  }

  return { server, database, user, password };
}

const QUERY = `
  SELECT DISTINCT LTRIM(RTRIM(m.email)) AS email
  FROM dbo.members m
  INNER JOIN dbo.member_products mp ON mp.member_id = m.id
  WHERE m.status = 'Active'
    AND m.email IS NOT NULL
    AND LTRIM(RTRIM(m.email)) != ''
    AND (mp.effective_date IS NULL OR mp.effective_date <= CAST(GETUTCDATE() AS DATE))
    AND (mp.termination_date IS NULL OR mp.termination_date > CAST(GETUTCDATE() AS DATE))
  ORDER BY email
`;

async function run() {
  const creds = loadCredentials();
  const config = {
    server: creds.server,
    database: creds.database,
    user: creds.user,
    password: creds.password,
    options: { encrypt: true, trustServerCertificate: false }
  };

  let pool;
  try {
    console.log('Connecting to ShareWELL prod DB...');
    pool = await sql.connect(config);
    console.log('Querying active members (1+ active plan by effective/termination dates)...');

    const result = await pool.request().query(QUERY);
    const rows = result.recordset || [];
    const emails = rows.map((r) => (r.email || '').trim()).filter((e) => e.length > 0);

    const outDir = path.resolve(__dirname, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const fileDate = new Date().toISOString().slice(0, 10);
    const outPath = path.join(outDir, `ShareWELL_active_member_emails_${fileDate}.txt`);
    fs.writeFileSync(outPath, emails.join('\n') + (emails.length ? '\n' : ''), 'utf8');

    console.log(`Wrote ${emails.length} email(s) to ${outPath}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
  }
}

run();
