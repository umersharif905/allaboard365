// Bump Claude's Form (Copy) published DefinitionJson by one version.
// Reads the local JSON, inserts as max+1, points PublishedVersion at it.
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });

const TEMPLATE_ID = 'c0001a15-26b8-4cd7-8b41-46f1a44b05e5';
const DEF_PATH = path.join(__dirname, '..', 'docs', 'forms', 'claudes-form-copy.definition.json');
const CHANGE_NOTE = process.argv[2] || 'Form content update';

(async () => {
  const definitionJson = fs.readFileSync(DEF_PATH, 'utf8');
  JSON.parse(definitionJson);

  const pool = await sql.connect({
    server: process.env.DB_SERVER, database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: false }, requestTimeout: 60000
  });

  const max = (await pool.request()
    .input('tid', sql.UniqueIdentifier, TEMPLATE_ID)
    .query('SELECT ISNULL(MAX(VersionNumber), 0) AS MaxVer FROM oe.PublicFormTemplateVersions WHERE FormTemplateId = @tid')
  ).recordset[0].MaxVer;
  const nextVer = (max | 0) + 1;

  await pool.request()
    .input('vid', sql.UniqueIdentifier, require('crypto').randomUUID())
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
      SET PublishedVersion = @vn, IsPublished = 1, ModifiedDate = SYSUTCDATETIME()
      WHERE FormTemplateId = @tid`);

  console.log(`Published v${nextVer}.`);
  await pool.close();
})().catch(e => { console.error(e); process.exit(1); });
