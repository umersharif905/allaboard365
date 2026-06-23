/**
 * Reads oe.TrainingLibrary (Scope = Organization) and writes the first four
 * modules from the first package's moduleAssignments (by order) as JSON files
 * into frontend/src/components/tenant-admin/training/samples/.
 *
 * Usage (from repo root or backend folder):
 *   node backend/scripts/export-training-modules-1-4-to-samples.js
 *
 * Optional env:
 *   TRAINING_EXPORT_PACKAGE_INDEX=0   (0-based index into packages array, default 0)
 *   TRAINING_EXPORT_COUNT=4           (how many modules to export, default 4)
 *   TRAINING_EXPORT_MODULE_IDS=       (comma-separated module ids; if set, ignores package order and exports these in order)
 */

const fs = require('fs');
const path = require('path');

const backendRoot = path.join(__dirname, '..');
process.chdir(backendRoot);

require('dotenv').config({ path: path.join(backendRoot, '.env'), override: true });

const { getPool, sql } = require('../config/database');

const ORG_SCOPE = 'Organization';
const SAMPLES_DIR = path.join(
  backendRoot,
  '..',
  'frontend',
  'src',
  'components',
  'tenant-admin',
  'training',
  'samples'
);

function slugify(value) {
  return String(value || 'module')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72);
}

async function main() {
  const packageIndex = Math.max(0, parseInt(process.env.TRAINING_EXPORT_PACKAGE_INDEX || '0', 10) || 0);
  const exportCount = Math.max(1, parseInt(process.env.TRAINING_EXPORT_COUNT || '4', 10) || 4);
  const explicitIds = (process.env.TRAINING_EXPORT_MODULE_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const pool = await getPool();
  const req = pool.request();
  req.input('Scope', sql.NVarChar(50), ORG_SCOPE);
  const result = await req.query(`
    SELECT TOP 1 PackagesJson, ModulesJson
    FROM oe.TrainingLibrary
    WHERE Scope = @Scope
  `);
  const row = result.recordset[0];
  if (!row) {
    console.error('[export-training-modules] No oe.TrainingLibrary row for Scope =', ORG_SCOPE);
    process.exitCode = 1;
    await pool.close();
    return;
  }

  let packages = [];
  let moduleLibrary = [];
  try {
    packages = JSON.parse(row.PackagesJson || '[]');
  } catch (e) {
    console.error('[export-training-modules] Invalid PackagesJson:', e.message);
    process.exitCode = 1;
    await pool.close();
    return;
  }
  try {
    moduleLibrary = JSON.parse(row.ModulesJson || '[]');
  } catch (e) {
    console.error('[export-training-modules] Invalid ModulesJson:', e.message);
    process.exitCode = 1;
    await pool.close();
    return;
  }

  const pkg = packages[packageIndex];
  if (!pkg) {
    console.error('[export-training-modules] No package at index', packageIndex);
    process.exitCode = 1;
    await pool.close();
    return;
  }

  const assignments = Array.isArray(pkg.moduleAssignments)
    ? [...pkg.moduleAssignments].sort((a, b) => (a.order || 0) - (b.order || 0))
    : [];

  const byId = new Map(moduleLibrary.map(m => [m.id, m]));

  let orderedModuleIds = [];
  if (explicitIds.length > 0) {
    orderedModuleIds = explicitIds.slice(0, exportCount);
  } else {
    orderedModuleIds = assignments.slice(0, exportCount).map(a => a.moduleId);
  }

  if (!fs.existsSync(SAMPLES_DIR)) {
    fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  }

  let written = 0;
  for (let i = 0; i < orderedModuleIds.length; i += 1) {
    const modId = orderedModuleIds[i];
    const mod = byId.get(modId);
    if (!mod) {
      console.warn('[export-training-modules] Missing module in library for id:', modId);
      continue;
    }
    const order = i + 1;
    const base = `exported-training-module-${String(order).padStart(2, '0')}-${modId}-${slugify(mod.title)}`;
    const filePath = path.join(SAMPLES_DIR, `${base}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(mod, null, 2)}\n`, 'utf8');
    console.log('Wrote', path.relative(path.join(backendRoot, '..'), filePath));
    written += 1;
  }

  if (written === 0) {
    console.error('[export-training-modules] No modules written (assignments or library mismatch).');
    process.exitCode = 1;
  } else {
    console.log('[export-training-modules] Done. Files:', written);
  }

  await pool.close();
}

main().catch(err => {
  console.error('[export-training-modules]', err);
  process.exitCode = 1;
});
