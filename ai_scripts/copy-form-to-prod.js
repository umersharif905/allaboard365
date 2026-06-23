#!/usr/bin/env node
// One-time script: copy "Claude's Form (Copy)" from allaboard-testing to allaboard-prod

const sql = require('mssql');

const FORM_TEMPLATE_ID = 'C0001A15-26B8-4CD7-8B41-46F1A44B05E5';

const baseConfig = {
  server: 'allboard-prod.database.windows.net',
  user: 'allaboardadmin',
  password: 'AllAboard2026$',
  options: { encrypt: true, trustServerCertificate: false },
};

const devConfig = { ...baseConfig, database: 'allaboard-testing' };
const prodConfig = { ...baseConfig, database: 'allaboard-prod' };

async function main() {
  const devPool = await sql.connect(devConfig);
  console.log('Connected to dev (allaboard-testing)');

  const templateRes = await devPool.request()
    .input('id', sql.UniqueIdentifier, FORM_TEMPLATE_ID)
    .query('SELECT * FROM oe.PublicFormTemplates WHERE FormTemplateId = @id');

  if (templateRes.recordset.length === 0) {
    throw new Error('Form template not found in dev');
  }
  const template = templateRes.recordset[0];
  console.log(`Found template: "${template.Title}"`);

  const versionsRes = await devPool.request()
    .input('id', sql.UniqueIdentifier, FORM_TEMPLATE_ID)
    .query('SELECT * FROM oe.PublicFormTemplateVersions WHERE FormTemplateId = @id ORDER BY VersionNumber');

  const versions = versionsRes.recordset;
  console.log(`Found ${versions.length} version(s)`);

  await devPool.close();

  const prodPool = await new sql.ConnectionPool(prodConfig).connect();
  console.log('Connected to prod (allaboard-prod)');

  // Check if already exists in prod
  const existsRes = await prodPool.request()
    .input('id', sql.UniqueIdentifier, FORM_TEMPLATE_ID)
    .query('SELECT FormTemplateId FROM oe.PublicFormTemplates WHERE FormTemplateId = @id');

  if (existsRes.recordset.length > 0) {
    console.log('Form already exists in prod — skipping template insert, will upsert versions.');
  } else {
    await prodPool.request()
      .input('FormTemplateId', sql.UniqueIdentifier, template.FormTemplateId)
      .input('TenantId', sql.UniqueIdentifier, template.TenantId)
      .input('FormKind', sql.NVarChar, template.FormKind)
      .input('Title', sql.NVarChar, template.Title)
      .input('IsPublished', sql.Bit, template.IsPublished)
      .input('PublishedVersion', sql.Int, template.PublishedVersion)
      .input('NotifyEmails', sql.NVarChar, template.NotifyEmails)
      .input('DefaultVendorId', sql.UniqueIdentifier, template.DefaultVendorId)
      .input('AllowedFrameAncestors', sql.NVarChar, template.AllowedFrameAncestors)
      .input('CreatedDate', sql.DateTime2, template.CreatedDate)
      .input('ModifiedDate', sql.DateTime2, template.ModifiedDate)
      .input('KindLabel', sql.NVarChar, template.KindLabel)
      .input('IsActive', sql.Bit, template.IsActive)
      .input('AllowAnonymous', sql.Bit, template.AllowAnonymous)
      .input('AllowTargeted', sql.Bit, template.AllowTargeted)
      .input('AllowAuthenticated', sql.Bit, template.AllowAuthenticated)
      .input('CreatesShareRequestOnSubmit', sql.Bit, template.CreatesShareRequestOnSubmit)
      .query(`INSERT INTO oe.PublicFormTemplates
        (FormTemplateId, TenantId, FormKind, Title, IsPublished, PublishedVersion, NotifyEmails,
         DefaultVendorId, AllowedFrameAncestors, CreatedDate, ModifiedDate, KindLabel, IsActive,
         AllowAnonymous, AllowTargeted, AllowAuthenticated, CreatesShareRequestOnSubmit)
        VALUES
        (@FormTemplateId, @TenantId, @FormKind, @Title, @IsPublished, @PublishedVersion, @NotifyEmails,
         @DefaultVendorId, @AllowedFrameAncestors, @CreatedDate, @ModifiedDate, @KindLabel, @IsActive,
         @AllowAnonymous, @AllowTargeted, @AllowAuthenticated, @CreatesShareRequestOnSubmit)`);
    console.log('Inserted form template into prod');
  }

  for (const v of versions) {
    const vExistsRes = await prodPool.request()
      .input('vid', sql.UniqueIdentifier, v.VersionId)
      .query('SELECT VersionId FROM oe.PublicFormTemplateVersions WHERE VersionId = @vid');

    if (vExistsRes.recordset.length > 0) {
      console.log(`Version ${v.VersionNumber} already exists in prod — skipping`);
      continue;
    }

    await prodPool.request()
      .input('VersionId', sql.UniqueIdentifier, v.VersionId)
      .input('FormTemplateId', sql.UniqueIdentifier, v.FormTemplateId)
      .input('VersionNumber', sql.Int, v.VersionNumber)
      .input('DefinitionJson', sql.NVarChar(sql.MAX), v.DefinitionJson)
      .input('ChangeNote', sql.NVarChar, v.ChangeNote)
      .input('CreatedDate', sql.DateTime2, v.CreatedDate)
      .query(`INSERT INTO oe.PublicFormTemplateVersions
        (VersionId, FormTemplateId, VersionNumber, DefinitionJson, ChangeNote, CreatedDate)
        VALUES
        (@VersionId, @FormTemplateId, @VersionNumber, @DefinitionJson, @ChangeNote, @CreatedDate)`);
    console.log(`Inserted version ${v.VersionNumber} into prod`);
  }

  await prodPool.close();
  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
