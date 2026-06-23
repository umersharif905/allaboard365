// Create two new published public-form templates by splitting the combined
// "FUTURE SR/PREV FORM COMBINED" form into a Share Request form and an
// Out-of-Network Copay & Preventative form.
//
// DRY-RUN BY DEFAULT (per CLAUDE.md DB-write hard rule): prints exactly what it
// would insert and exits without writing. Pass --commit to actually INSERT.
//
//   node ai_scripts/create-split-forms.cjs            # dry run / preview
//   node ai_scripts/create-split-forms.cjs --commit   # real insert
//
// Idempotent: aborts before writing if a template with either Title already
// exists for the tenant.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sql = require('mssql');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });

const COMMIT = process.argv.includes('--commit');
const TENANT_ID = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
const DEFAULT_VENDOR_ID = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6'; // ShareWELL Health/Partners
const DOCS = path.join(__dirname, '..', 'docs', 'forms');

const FORMS = [
  {
    title: 'Share Request Form [NEW]',
    kindLabel: 'Share Request',
    defPath: path.join(DOCS, 'share-request-form.definition.json'),
    createsSr: 1,
    createsCase: 0,
    changeNote: 'Split from "FUTURE SR/PREV FORM COMBINED" — SR branch (surgery/ER/maternity/other router).'
  },
  {
    title: 'Out-of-Network Copay & Preventative Care Form [NEW]',
    kindLabel: 'Out-of-Network Copay & Preventative',
    defPath: path.join(DOCS, 'out-of-network-copay-preventative-form.definition.json'),
    createsSr: 0,
    createsCase: 1,
    changeNote: 'Split from "FUTURE SR/PREV FORM COMBINED" — preventative/copay branch (creates a Case).'
  }
];

(async () => {
  // Validate definition files up front.
  for (const f of FORMS) {
    const raw = fs.readFileSync(f.defPath, 'utf8');
    const def = JSON.parse(raw);
    f.definitionJson = raw;
    f.formTemplateId = crypto.randomUUID();
    f.formKind = `K_${f.formTemplateId.replace(/-/g, '')}`;
    f.summary = {
      defTitle: def.title,
      pages: (def.pages || []).length,
      fields: (def.fields || []).length,
      preScreen: (def.preScreening || []).length
    };
  }

  console.log(`\n${COMMIT ? '*** COMMIT MODE — will INSERT ***' : '--- DRY RUN (no writes; pass --commit to insert) ---'}`);
  console.log(`Server: ${process.env.DB_SERVER} / DB: ${process.env.DB_NAME}`);
  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`Default vendor: ${DEFAULT_VENDOR_ID}\n`);
  for (const f of FORMS) {
    console.log(`• "${f.title}"`);
    console.log(`    FormTemplateId : ${f.formTemplateId}`);
    console.log(`    FormKind       : ${f.formKind}`);
    console.log(`    KindLabel      : ${f.kindLabel}`);
    console.log(`    CreatesSR/Case : ${f.createsSr}/${f.createsCase}`);
    console.log(`    def.title      : ${f.summary.defTitle}`);
    console.log(`    pages/fields   : ${f.summary.pages} pages, ${f.summary.fields} fields, ${f.summary.preScreen} prescreen`);
    console.log('');
  }

  const pool = await sql.connect({
    server: process.env.DB_SERVER, database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: false }, requestTimeout: 60000
  });

  // Idempotency guard.
  for (const f of FORMS) {
    const dup = (await pool.request()
      .input('tenantId', sql.UniqueIdentifier, TENANT_ID)
      .input('title', sql.NVarChar(500), f.title)
      .query('SELECT FormTemplateId FROM oe.PublicFormTemplates WHERE TenantId=@tenantId AND Title=@title')
    ).recordset;
    if (dup.length) {
      console.error(`\nABORT: a template titled "${f.title}" already exists (${dup[0].FormTemplateId}). Nothing written.`);
      await pool.close();
      process.exit(1);
    }
  }
  console.log('Idempotency check passed — no existing templates with these titles.\n');

  if (!COMMIT) {
    console.log('Dry run complete. Re-run with --commit to insert.');
    await pool.close();
    return;
  }

  for (const f of FORMS) {
    await pool.request()
      .input('id', sql.UniqueIdentifier, f.formTemplateId)
      .input('tenantId', sql.UniqueIdentifier, TENANT_ID)
      .input('kind', sql.NVarChar(50), f.formKind)
      .input('title', sql.NVarChar(500), f.title)
      .input('notify', sql.NVarChar(sql.MAX), '[]')
      .input('frame', sql.NVarChar(sql.MAX), '*')
      .input('kindLabel', sql.NVarChar(128), f.kindLabel)
      .input('defaultVendorId', sql.UniqueIdentifier, DEFAULT_VENDOR_ID)
      .input('createsSr', sql.Bit, f.createsSr)
      .input('createsCase', sql.Bit, f.createsCase)
      .query(`
        INSERT INTO oe.PublicFormTemplates (
          FormTemplateId, TenantId, FormKind, Title, IsPublished, PublishedVersion,
          NotifyEmails, AllowedFrameAncestors, KindLabel, IsActive, DefaultVendorId,
          AllowAnonymous, AllowTargeted, AllowAuthenticated, CreatesShareRequestOnSubmit,
          CreatesCaseOnSubmit, CreatedDate, ModifiedDate
        ) VALUES (
          @id, @tenantId, @kind, @title, 1, 1,
          @notify, @frame, @kindLabel, 1, @defaultVendorId,
          1, 0, 0, @createsSr,
          @createsCase, SYSUTCDATETIME(), SYSUTCDATETIME()
        )`);

    await pool.request()
      .input('vid', sql.UniqueIdentifier, crypto.randomUUID())
      .input('tid', sql.UniqueIdentifier, f.formTemplateId)
      .input('def', sql.NVarChar(sql.MAX), f.definitionJson)
      .input('note', sql.NVarChar(sql.MAX), f.changeNote)
      .query(`
        INSERT INTO oe.PublicFormTemplateVersions (
          VersionId, FormTemplateId, VersionNumber, DefinitionJson, ChangeNote, CreatedBy, CreatedDate
        ) VALUES (@vid, @tid, 1, @def, @note, NULL, SYSUTCDATETIME())`);

    console.log(`Created + published v1: "${f.title}" (${f.formTemplateId})`);
  }

  await pool.close();
  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
