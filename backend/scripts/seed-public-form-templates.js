/**
 * Ensures each tenant has the three default public sharing form templates.
 * Run: node scripts/seed-public-form-templates.js
 * Requires DATABASE_URL / same env as app (getPool).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getPool, sql } = require('../config/database');
const { getDefaultDefinitionJson } = require('../services/publicFormDefaults');
const crypto = require('crypto');

async function main() {
    const pool = await getPool();
    const tenants = (await pool.request().query('SELECT TenantId FROM oe.Tenants')).recordset;
    const kinds = ['UnsharedAmount', 'AdditionalDocuments', 'PreventiveCare'];
    for (const t of tenants) {
        for (const formKind of kinds) {
            const exists = (await pool.request()
                .input('tenantId', sql.UniqueIdentifier, t.TenantId)
                .input('kind', sql.NVarChar, formKind)
                .query(`SELECT 1 AS x FROM oe.PublicFormTemplates WHERE TenantId=@tenantId AND FormKind=@kind`)).recordset[0];
            if (exists) continue;
            const formTemplateId = crypto.randomUUID();
            const def = getDefaultDefinitionJson(formKind);
            const title = JSON.parse(def).title;
            await pool.request()
                .input('id', sql.UniqueIdentifier, formTemplateId)
                .input('tenantId', sql.UniqueIdentifier, t.TenantId)
                .input('kind', sql.NVarChar, formKind)
                .input('title', sql.NVarChar, title)
                .input('notify', sql.NVarChar, '[]')
                .query(`
                    INSERT INTO oe.PublicFormTemplates (
                        FormTemplateId, TenantId, FormKind, Title, IsPublished, PublishedVersion,
                        NotifyEmails, AllowedFrameAncestors, CreatedDate, ModifiedDate
                    ) VALUES (
                        @id, @tenantId, @kind, @title, 1, 1, @notify, N'*', SYSUTCDATETIME(), SYSUTCDATETIME()
                    )
                `);
            await pool.request()
                .input('vid', sql.UniqueIdentifier, crypto.randomUUID())
                .input('tid', sql.UniqueIdentifier, formTemplateId)
                .input('def', sql.NVarChar(sql.MAX), def)
                .query(`
                    INSERT INTO oe.PublicFormTemplateVersions (VersionId, FormTemplateId, VersionNumber, DefinitionJson, ChangeNote, CreatedDate)
                    VALUES (@vid, @tid, 1, @def, N'Seed script', SYSUTCDATETIME())
                `);
            console.log('Created', formKind, formTemplateId, 'for tenant', t.TenantId);
        }
    }
    console.log('Done.');
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
