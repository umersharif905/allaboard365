/**
 * Export Sharewell sharing requests + related data to a ZIP bundle.
 * Usage: node ai_scripts/export-sharewell-share-requests.cjs [--partner-id UUID] [--account-id UUID] [--out DIR]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sql = require('mssql');

const cliArgs = process.argv.slice(2);
function argValue(flag) {
  const i = cliArgs.indexOf(flag);
  return i >= 0 && cliArgs[i + 1] ? cliArgs[i + 1] : null;
}

const partnerId = argValue('--partner-id');
const accountId = argValue('--account-id');
const outArg = argValue('--out');

const config = {
  server: process.env.SHAREWELL_DB_SERVER || process.env.DB_SERVER,
  database: process.env.SHAREWELL_DB_DATABASE || process.env.DB_NAME || 'ShareWELLPartners',
  user: process.env.SHAREWELL_DB_USER || process.env.DB_USER,
  password: process.env.SHAREWELL_DB_PASSWORD || process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false },
};

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

async function queryAll(pool, queryText, inputs = {}) {
  const req = pool.request();
  for (const [k, v] of Object.entries(inputs)) {
    req.input(k, v);
  }
  const result = await req.query(queryText);
  return result.recordset || [];
}

async function tableExists(pool, tableName) {
  const req = pool.request();
  req.input('t', sql.NVarChar, tableName);
  const result = await req.query(
    `SELECT 1 AS ok FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = @t`
  );
  return (result.recordset || []).length > 0;
}

async function exportTable(pool, tableName) {
  if (!(await tableExists(pool, tableName))) return [];
  const result = await pool.request().query(`SELECT * FROM [${tableName}]`);
  return result.recordset || [];
}

async function main() {
  if (!config.password || !config.server || !config.user) {
    console.error('Missing SHAREWELL_DB_* credentials in ai_scripts/.env');
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = outArg
    ? path.resolve(outArg)
    : path.join(__dirname, '..', 'backend', 'temp', 'exports', 'sharewell-share-requests', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('Connecting to Sharewell...');
  const pool = await sql.connect(config);

  const memberFilter = accountId
    ? 'WHERE m.account_id = @accountId'
    : partnerId
      ? 'WHERE a.partner_id = @partnerId'
      : '';

  const bindInputs = (req, inputs) => {
    if (inputs.partnerId) req.input('partnerId', sql.UniqueIdentifier, inputs.partnerId);
    if (inputs.accountId) req.input('accountId', sql.UniqueIdentifier, inputs.accountId);
  };

  const filterInputs = {};
  if (accountId) filterInputs.accountId = accountId;
  if (partnerId) filterInputs.partnerId = partnerId;

  const shareRequestFilter = accountId || partnerId
    ? `WHERE sr.member_id_key IN (
         SELECT m.id FROM members m
         INNER JOIN accounts a ON m.account_id = a.id
         ${memberFilter}
       )`
    : '';

  async function runQuery(queryText) {
    const req = pool.request();
    bindInputs(req, filterInputs);
    const result = await req.query(queryText);
    return result.recordset || [];
  }

  const shareRequests = await runQuery(`
    SELECT sr.*,
      mk.member_id AS member_guid_member_id_text,
      mk.import_id AS member_key_import_id,
      mk.first_name AS member_key_first_name,
      mk.last_name AS member_key_last_name,
      mk.relationship AS member_key_relationship,
      smk.import_id AS selected_member_import_id,
      smk.first_name AS selected_member_first_name,
      smk.last_name AS selected_member_last_name
    FROM share_requests sr
    LEFT JOIN members mk ON sr.member_id_key = mk.id
    LEFT JOIN members smk ON sr.selected_member_id_Key = smk.id
    ${shareRequestFilter}
  `);

  const members = await runQuery(`
    SELECT m.* FROM members m
    INNER JOIN accounts a ON m.account_id = a.id
    ${memberFilter}
  `);

  const accounts = await runQuery(
    partnerId
      ? 'SELECT * FROM accounts WHERE partner_id = @partnerId'
      : accountId
        ? 'SELECT * FROM accounts WHERE id = @accountId'
        : 'SELECT * FROM accounts'
  );

  const partners = await runQuery('SELECT * FROM partners');
  const providers = await exportTable(pool, 'providers');
  const srProviders = await exportTable(pool, 'share_request_provider');
  const providerBills = await exportTable(pool, 'provider_bills');
  const billLedger = await exportTable(pool, 'provider_bill_ledger');
  const notes = shareRequestFilter
    ? await runQuery(`
        SELECT n.* FROM notes n
        INNER JOIN share_requests sr ON n.share_request_id_key = sr.id
        ${shareRequestFilter}
      `)
    : await exportTable(pool, 'notes');

  const manifest = {
    exportedAt: new Date().toISOString(),
    filters: { partnerId, accountId },
    rowCounts: {
      share_requests: shareRequests.length,
      members: members.length,
      accounts: accounts.length,
      partners: partners.length,
      providers: providers.length,
      share_request_provider: srProviders.length,
      provider_bills: providerBills.length,
      provider_bill_ledger: billLedger.length,
      notes: notes.length,
    },
    discovery: JSON.parse(
      fs.readFileSync(path.join(__dirname, 'sharewell-schema-discovery.json'), 'utf8')
    ),
  };

  const files = {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'share_requests.csv': rowsToCsv(shareRequests),
    'members.csv': rowsToCsv(members),
    'accounts.csv': rowsToCsv(accounts),
    'partners.csv': rowsToCsv(partners),
    'providers.csv': rowsToCsv(providers),
    'share_request_provider.csv': rowsToCsv(srProviders),
    'provider_bills.csv': rowsToCsv(providerBills),
    'provider_bill_ledger.csv': rowsToCsv(billLedger),
    'notes.csv': rowsToCsv(notes),
  };

  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(outDir, name), content, 'utf8');
  }

  const zipPath = `${outDir}.zip`;
  try {
    execSync(`cd "${outDir}" && zip -r "${zipPath}" .`, { stdio: 'inherit' });
    console.log(`ZIP: ${zipPath}`);
  } catch (e) {
    console.warn('zip command failed; folder export only:', e.message);
  }

  console.log(`Export folder: ${outDir}`);
  console.log(JSON.stringify(manifest.rowCounts, null, 2));
  await pool.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
