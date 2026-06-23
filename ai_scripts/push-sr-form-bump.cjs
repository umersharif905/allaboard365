// Bump the "Share Request Form [NEW]" published DefinitionJson by one version.
// Reads the local JSON, inserts as max+1, points PublishedVersion at it.
//
// DRY-RUN BY DEFAULT (per CLAUDE.md DB-write hard rule). Pass --commit to write.
//   node ai_scripts/push-sr-form-bump.cjs            # preview
//   node ai_scripts/push-sr-form-bump.cjs --commit   # real insert + publish
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sql = require('mssql');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });

const COMMIT = process.argv.includes('--commit');
const TEMPLATE_ID = 'b530b5f8-5d0f-4399-a499-81c93df5d1ac'; // Share Request Form [NEW]
const DEF_PATH = path.join(__dirname, '..', 'docs', 'forms', 'share-request-form.definition.json');
const CHANGE_NOTE = process.argv.find((a) => !a.startsWith('--') && a.endsWith('!')) // unused guard
  || 'Flip almost all fields to required (keep 7 catch-alls + 4 provider Tax IDs optional); remove manual PCP fax field (now from NPI).';

(async () => {
  const definitionJson = fs.readFileSync(DEF_PATH, 'utf8');
  const def = JSON.parse(definitionJson);
  const DISPLAY = new Set(['static_html', 'paragraph']);
  const inputs = def.fields.filter((f) => !DISPLAY.has(f.type));
  const req = inputs.filter((f) => f.required).length;

  console.log(`\n${COMMIT ? '*** COMMIT MODE ***' : '--- DRY RUN (pass --commit to write) ---'}`);
  console.log(`DB: ${process.env.DB_SERVER} / ${process.env.DB_NAME}`);
  console.log(`Template: ${TEMPLATE_ID} (Share Request Form [NEW])`);
  console.log(`Definition: ${def.fields.length} fields, ${inputs.length} inputs (${req} required, ${inputs.length - req} optional)`);
  console.log(`Change note: ${CHANGE_NOTE}\n`);

  const pool = await sql.connect({
    server: process.env.DB_SERVER, database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: false }, requestTimeout: 60000
  });

  const max = (await pool.request()
    .input('tid', sql.UniqueIdentifier, TEMPLATE_ID)
    .query('SELECT ISNULL(MAX(VersionNumber),0) AS MaxVer FROM oe.PublicFormTemplateVersions WHERE FormTemplateId=@tid')
  ).recordset[0].MaxVer;
  const nextVer = (max | 0) + 1;
  console.log(`Current max version: ${max} → will publish v${nextVer}`);

  if (!COMMIT) { console.log('\nDry run complete.'); await pool.close(); return; }

  await pool.request()
    .input('vid', sql.UniqueIdentifier, crypto.randomUUID())
    .input('tid', sql.UniqueIdentifier, TEMPLATE_ID)
    .input('vn', sql.Int, nextVer)
    .input('def', sql.NVarChar(sql.MAX), definitionJson)
    .input('note', sql.NVarChar(sql.MAX), CHANGE_NOTE)
    .query(`INSERT INTO oe.PublicFormTemplateVersions
      (VersionId, FormTemplateId, VersionNumber, DefinitionJson, ChangeNote, CreatedBy, CreatedDate)
      VALUES (@vid, @tid, @vn, @def, @note, NULL, SYSUTCDATETIME())`);

  await pool.request()
    .input('tid', sql.UniqueIdentifier, TEMPLATE_ID)
    .input('vn', sql.Int, nextVer)
    .query(`UPDATE oe.PublicFormTemplates
      SET PublishedVersion=@vn, IsPublished=1, ModifiedDate=SYSUTCDATETIME()
      WHERE FormTemplateId=@tid`);

  console.log(`Published v${nextVer}.`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
