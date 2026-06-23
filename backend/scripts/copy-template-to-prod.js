/**
 * Copy MessageTemplates from dev (allaboard-testing) to prod (allaboard-prod).
 * Azure SQL doesn't support cross-database queries, so we connect to each DB separately.
 *
 * Usage: node scripts/copy-template-to-prod.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
const sql = require('mssql');

const SERVER = process.env.DB_SERVER;
const USER = process.env.DB_USER;
const PASSWORD = process.env.DB_PASSWORD;
const DEV_DB = 'allaboard-testing';
const PROD_DB = 'allaboard-prod';

function makeConfig(database) {
  return {
    user: USER,
    password: PASSWORD,
    server: SERVER,
    database,
    options: {
      encrypt: true,
      trustServerCertificate: false,
      enableArithAbort: true,
      connectionTimeout: 30000,
      requestTimeout: 60000,
    }
  };
}

async function run() {
  let devPool, prodPool;
  try {
    console.log(`Connecting to DEV (${DEV_DB})...`);
    devPool = await new sql.ConnectionPool(makeConfig(DEV_DB)).connect();
    console.log('Connected to DEV.\n');

    // Step 1: List all templates in dev
    console.log('=== TEMPLATES IN DEV ===\n');
    const devTemplates = await devPool.request().query(`
      SELECT TemplateId, TenantId, TemplateName, MessageType, Subject, Body, ReplyTo,
             IsActive, CreatedDate, CreatedBy, ModifiedDate, ModifiedBy,
             LEN(Body) as BodyLength
      FROM oe.MessageTemplates
      ORDER BY CreatedDate DESC
    `);

    if (devTemplates.recordset.length === 0) {
      console.log('No templates found in dev database.');
      return;
    }

    devTemplates.recordset.forEach((t, i) => {
      console.log(`${i + 1}. [${t.TemplateId}]`);
      console.log(`   Name: ${t.TemplateName}`);
      console.log(`   Type: ${t.MessageType} | Subject: ${t.Subject || '(none)'}`);
      console.log(`   TenantId: ${t.TenantId || 'NULL (global)'}`);
      console.log(`   Active: ${t.IsActive} | Body: ${t.BodyLength} chars`);
      console.log(`   Created: ${t.CreatedDate}`);
      console.log('');
    });

    // Check dev welcome email settings
    console.log('=== DEV WELCOME EMAIL SETTINGS ===\n');
    const devWelcome = await devPool.request().query(`
      SELECT 'TenantSettings' as Source, TenantId, SettingKey, SettingValue
      FROM oe.TenantSettings
      WHERE SettingKey = 'WelcomeEmailTemplateId'
      UNION ALL
      SELECT 'SystemSettings' as Source, NULL as TenantId, SettingKey, SettingValue
      FROM oe.SystemSettings
      WHERE SettingKey = 'DefaultWelcomeEmailTemplateId'
    `);
    if (devWelcome.recordset.length === 0) {
      console.log('  (none configured)\n');
    } else {
      devWelcome.recordset.forEach(r => {
        console.log(`  ${r.Source}: TemplateId=${r.SettingValue} (TenantId=${r.TenantId || 'global'})`);
      });
      console.log('');
    }

    // Step 2: Connect to prod
    console.log(`Connecting to PROD (${PROD_DB})...`);
    prodPool = await new sql.ConnectionPool(makeConfig(PROD_DB)).connect();
    console.log('Connected to PROD.\n');

    console.log('=== TEMPLATES IN PROD ===\n');
    const prodTemplates = await prodPool.request().query(`
      SELECT TemplateId, TenantId, TemplateName, MessageType, Subject,
             IsActive, CreatedDate,
             LEN(Body) as BodyLength
      FROM oe.MessageTemplates
      ORDER BY CreatedDate DESC
    `);

    if (prodTemplates.recordset.length === 0) {
      console.log('  No templates in prod yet.\n');
    } else {
      prodTemplates.recordset.forEach((t, i) => {
        console.log(`${i + 1}. [${t.TemplateId}]`);
        console.log(`   Name: ${t.TemplateName}`);
        console.log(`   Type: ${t.MessageType} | Subject: ${t.Subject || '(none)'}`);
        console.log(`   TenantId: ${t.TenantId || 'NULL (global)'}`);
        console.log(`   Active: ${t.IsActive} | Body: ${t.BodyLength} chars`);
        console.log(`   Created: ${t.CreatedDate}`);
        console.log('');
      });
    }

    // Step 3: Copy templates that don't already exist in prod
    console.log('=== COPYING TEMPLATES DEV → PROD ===\n');
    const existingProdIds = new Set(prodTemplates.recordset.map(t => t.TemplateId));
    const toCopy = devTemplates.recordset.filter(t => !existingProdIds.has(t.TemplateId));

    if (toCopy.length === 0) {
      console.log('All dev templates already exist in prod. Nothing to copy.\n');
    } else {
      console.log(`Copying ${toCopy.length} template(s)...\n`);

      for (const t of toCopy) {
        const req = prodPool.request();
        req.input('templateId', sql.UniqueIdentifier, t.TemplateId);
        req.input('tenantId', t.TenantId ? sql.UniqueIdentifier : sql.UniqueIdentifier, t.TenantId || null);
        req.input('templateName', sql.NVarChar, t.TemplateName);
        req.input('messageType', sql.NVarChar, t.MessageType);
        req.input('subject', sql.NVarChar, t.Subject || null);
        req.input('body', sql.NVarChar(sql.MAX), t.Body);
        req.input('replyTo', sql.NVarChar, t.ReplyTo || null);
        req.input('isActive', sql.Bit, t.IsActive);
        req.input('createdDate', sql.DateTime2, t.CreatedDate);
        req.input('createdBy', sql.UniqueIdentifier, t.CreatedBy || null);
        req.input('modifiedDate', sql.DateTime2, t.ModifiedDate || null);
        req.input('modifiedBy', sql.UniqueIdentifier, t.ModifiedBy || null);

        await req.query(`
          INSERT INTO oe.MessageTemplates
            (TemplateId, TenantId, TemplateName, MessageType, Subject, Body, ReplyTo, IsActive, CreatedDate, CreatedBy, ModifiedDate, ModifiedBy)
          VALUES
            (@templateId, @tenantId, @templateName, @messageType, @subject, @body, @replyTo, @isActive, @createdDate, @createdBy, @modifiedDate, @modifiedBy)
        `);
        console.log(`  Copied: "${t.TemplateName}" (${t.TemplateId})`);
      }
      console.log('');
    }

    // Step 4: Check prod welcome email settings
    console.log('=== PROD WELCOME EMAIL SETTINGS ===\n');
    const prodWelcome = await prodPool.request().query(`
      SELECT 'TenantSettings' as Source, TenantId, SettingKey, SettingValue
      FROM oe.TenantSettings
      WHERE SettingKey = 'WelcomeEmailTemplateId'
      UNION ALL
      SELECT 'SystemSettings' as Source, NULL as TenantId, SettingKey, SettingValue
      FROM oe.SystemSettings
      WHERE SettingKey = 'DefaultWelcomeEmailTemplateId'
    `);
    if (prodWelcome.recordset.length === 0) {
      console.log('  (none configured) — you need to set this via the UI or API after switching to prod\n');
    } else {
      prodWelcome.recordset.forEach(r => {
        console.log(`  ${r.Source}: TemplateId=${r.SettingValue} (TenantId=${r.TenantId || 'global'})`);
      });
      console.log('');
    }

    console.log('Done! Next steps:');
    console.log('  1. Review the output above');
    console.log('  2. Switch .env DB_NAME from allaboard-testing to allaboard-prod');
    console.log('  3. Restart the backend');
    console.log('  4. Set the welcome email template in the Message Center UI');

  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
  } finally {
    if (devPool) await devPool.close();
    if (prodPool) await prodPool.close();
    process.exit(0);
  }
}

run();
