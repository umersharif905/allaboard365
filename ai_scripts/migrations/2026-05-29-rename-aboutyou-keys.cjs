/**
 * Migration: rename About-You field keys on the two [NEW] public forms to the
 * canonical member-autofill keys, so a signed-in member's profile autofills
 * them (autofill matches a field by its key — see memberAutofillKeys /
 * mapPrefillToInitialValues).
 *
 * Targets published versions of templates whose Title contains "[NEW]".
 * Only the generic-typed fields need renaming; semantic types
 * (first_name/last_name/email/tel/member_id) already autofill by type.
 *
 * Usage (run inside the backend container with the repo env sourced):
 *   node 2026-05-29-rename-aboutyou-keys.cjs            # DRY RUN on testing
 *   node 2026-05-29-rename-aboutyou-keys.cjs --apply    # WRITE to testing
 *   node 2026-05-29-rename-aboutyou-keys.cjs --apply --prod   # WRITE to prod (PR time)
 *
 * Idempotent: a field already at its canonical key is skipped. A rename is
 * skipped (with a warning) if the canonical key is already taken by another
 * field. Pre-screening effect targetIds pointing at a renamed field are updated
 * too, so conditional logic keeps working.
 */
const sql = require('mssql');

const APPLY = process.argv.includes('--apply');
const PROD = process.argv.includes('--prod');

const RENAME_MAP = {
  ay_dob: 'dateOfBirth',
  ay_addr_street: 'addressLine1',
  ay_addr_city: 'addressCity',
  ay_addr_state: 'addressState',
  ay_addr_zip: 'addressZip',
  field_mpe6t9kq14t1e73ol: 'relationToPrimary', // "Relation to primary member" select
  req_ua_tier: 'uaTier' // SR form only; no-op where absent
};

const dbConfig = {
  server: process.env.DB_SERVER,
  database: PROD ? 'allaboard-prod' : 'allaboard-testing',
  user: PROD ? process.env.DB_USER : process.env.DB_USER_TESTING_RW || process.env.DB_USER,
  password: PROD
    ? process.env.DB_PASSWORD
    : process.env.DB_PASSWORD_TESTING_RW || process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false }
};

/** Apply the rename map to a parsed definition. Returns {def, renames:[{from,to}]}. */
function applyRenames(def) {
  const fields = Array.isArray(def.fields) ? def.fields : [];
  const existing = new Set(fields.map((f) => f && f.name));
  const renames = [];
  for (const f of fields) {
    if (!f || !RENAME_MAP[f.name]) continue;
    const to = RENAME_MAP[f.name];
    if (f.name === to) continue; // already canonical
    if (existing.has(to)) {
      console.warn(`   ⚠️  skip ${f.name} → ${to} (key "${to}" already used)`);
      continue;
    }
    renames.push({ from: f.name, to });
    existing.delete(f.name);
    existing.add(to);
    f.name = to;
  }
  // Keep pre-screening effects that target a renamed field pointing at the new key.
  const byFrom = new Map(renames.map((r) => [r.from, r.to]));
  for (const q of def.preScreening || []) {
    for (const opt of q.options || []) {
      for (const eff of opt.effects || []) {
        if (eff && eff.targetType === 'field' && byFrom.has(eff.targetId)) {
          eff.targetId = byFrom.get(eff.targetId);
        }
      }
    }
  }
  return { def, renames };
}

async function main() {
  console.log(`\n=== rename-aboutyou-keys — ${PROD ? 'PROD' : 'TESTING'} — ${APPLY ? 'APPLY (writes)' : 'DRY RUN'} ===`);
  if (!dbConfig.server || !dbConfig.user || !dbConfig.password) {
    console.error('❌ DB creds missing in env (source ai_scripts/.env first).');
    process.exit(1);
  }
  await sql.connect(dbConfig);
  console.log(`📌 ${dbConfig.server} / ${dbConfig.database}`);

  const forms = await sql.query`
    SELECT t.FormTemplateId, t.Title, t.PublishedVersion, v.DefinitionJson
    FROM oe.PublicFormTemplates t
    JOIN oe.PublicFormTemplateVersions v
      ON v.FormTemplateId = t.FormTemplateId AND v.VersionNumber = t.PublishedVersion
    WHERE t.Title LIKE '%[[]NEW]%' AND t.IsPublished = 1
  `;

  let totalRenames = 0;
  for (const row of forms.recordset) {
    let def;
    try {
      def = JSON.parse(row.DefinitionJson);
    } catch {
      console.warn(`\n### ${row.Title}: unparseable DefinitionJson — skipped`);
      continue;
    }
    const { def: nextDef, renames } = applyRenames(def);
    console.log(`\n### ${row.Title} (v${row.PublishedVersion}) — ${renames.length} rename(s)`);
    for (const r of renames) console.log(`   ${r.from}  →  ${r.to}`);
    if (!renames.length) continue;
    totalRenames += renames.length;

    if (APPLY) {
      await new sql.Request()
        .input('json', sql.NVarChar(sql.MAX), JSON.stringify(nextDef))
        .input('tpl', sql.UniqueIdentifier, row.FormTemplateId)
        .input('ver', sql.Int, row.PublishedVersion)
        .query(`UPDATE oe.PublicFormTemplateVersions
                SET DefinitionJson = @json
                WHERE FormTemplateId = @tpl AND VersionNumber = @ver`);
      console.log('   ✅ written');
    }
  }

  console.log(`\n${APPLY ? 'Applied' : 'Would apply'} ${totalRenames} rename(s) across ${forms.recordset.length} form(s).`);
  if (!APPLY) console.log('Dry run only — re-run with --apply to write.');
  await sql.close();
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
