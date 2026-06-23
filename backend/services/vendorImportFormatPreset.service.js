'use strict';

const { getPool, sql } = require('../config/database');
const sharewellDefaults = require('../utils/sharewellDefaultImportPresets');
const { validateTemplatePlaceholders } = require('../utils/eligibilityRowTemplate');
const {
  normalizeImportRules,
  parseImportRulesJson,
  parseTobaccoYesValues,
  importRulesForStorage,
} = require('../utils/vendorImportRules');

const cache = new Map();
const CACHE_MS = 60_000;

function cacheKey(vendorId) {
  return String(vendorId || '').toLowerCase();
}

function tobaccoFieldsFromRow(row) {
  const fallback = sharewellFallbackPreset(row?.Slug);
  const parsedRules = row?.ImportRulesJson != null
    ? normalizeImportRules(parseImportRulesJson(row.ImportRulesJson))
    : normalizeImportRules(row?.importRules ?? fallback?.importRules);
  let tobaccoCsvColumn = row?.TobaccoCsvColumn != null
    ? String(row.TobaccoCsvColumn || '').trim()
    : (fallback?.tobaccoCsvColumn || parsedRules.tobacco.columns[0] || '');
  let tobaccoYesValues = row?.TobaccoYesValues != null
    ? parseTobaccoYesValues(row.TobaccoYesValues)
    : (fallback?.tobaccoYesValues || parsedRules.tobacco.yesValues || []);
  if (!tobaccoCsvColumn && fallback?.tobaccoCsvColumn) tobaccoCsvColumn = fallback.tobaccoCsvColumn;
  if (!tobaccoYesValues.length && fallback?.tobaccoYesValues?.length) {
    tobaccoYesValues = fallback.tobaccoYesValues;
  }
  return { tobaccoCsvColumn, tobaccoYesValues };
}

function fromRow(row) {
  if (!row) return null;
  const fallback = sharewellFallbackPreset(row.Slug);
  const importRules = row.ImportRulesJson != null
    ? normalizeImportRules(parseImportRulesJson(row.ImportRulesJson))
    : normalizeImportRules(row.importRules ?? fallback?.importRules);
  const { tobaccoCsvColumn, tobaccoYesValues } = tobaccoFieldsFromRow(row);
  return {
    slug: row.Slug,
    label: row.Label,
    template: row.RowTemplate,
    sortOrder: row.SortOrder ?? 0,
    importRules,
    tobaccoCsvColumn,
    tobaccoYesValues,
  };
}

function sharewellFallbackList() {
  return sharewellDefaults.listOptions();
}

function sharewellFallbackPreset(slug) {
  return sharewellDefaults.getPreset(slug);
}

async function loadPresetsForVendor(vendorId) {
  const key = cacheKey(vendorId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.presets;

  const pool = await getPool();
  const hasRulesCol = await importRulesColumnExists();
  const hasTobaccoCol = await tobaccoColumnsExist();
  const result = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT Slug, Label, RowTemplate, SortOrder${hasRulesCol ? ', ImportRulesJson' : ''}${hasTobaccoCol ? ', TobaccoCsvColumn, TobaccoYesValues' : ''}
      FROM oe.VendorImportFormatPresets
      WHERE VendorId = @vendorId AND IsActive = 1
      ORDER BY SortOrder, Label
    `);

  let presets = (result.recordset || []).map(fromRow).filter((p) => p.slug && p.template);

  if (!presets.length && sharewellDefaults.isSharewellVendorId(vendorId)) {
    presets = sharewellFallbackList();
  }

  cache.set(key, { at: Date.now(), presets });
  return presets;
}

function clearCache(vendorId) {
  if (vendorId) cache.delete(cacheKey(vendorId));
  else cache.clear();
}

async function listFormatPresets(vendorId) {
  if (!vendorId) return [];
  const presets = await loadPresetsForVendor(vendorId);
  return presets.map(({
    slug, label, template, sortOrder, importRules, tobaccoCsvColumn, tobaccoYesValues,
  }) => ({
    slug,
    label,
    template,
    sortOrder,
    importRules,
    tobaccoCsvColumn,
    tobaccoYesValues,
  }));
}

async function importRulesColumnExists() {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT 1 AS ok
    WHERE COL_LENGTH('oe.VendorImportFormatPresets', 'ImportRulesJson') IS NOT NULL
  `);
  return Boolean(r.recordset?.[0]?.ok);
}

async function tobaccoColumnsExist() {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT 1 AS ok
    WHERE COL_LENGTH('oe.VendorImportFormatPresets', 'TobaccoCsvColumn') IS NOT NULL
  `);
  return Boolean(r.recordset?.[0]?.ok);
}

function assertValidImportRules(importRules) {
  if (importRules === undefined || importRules === null) return null;
  return importRulesForStorage(importRules);
}

function formatTobaccoYesValuesForDb(yesValues) {
  const list = parseTobaccoYesValues(yesValues);
  return list.length ? list.join(',') : null;
}

async function getFormatPreset(vendorId, slug) {
  if (!vendorId) return null;
  const presets = await loadPresetsForVendor(vendorId);
  const normalized = String(slug || '').trim();
  if (normalized) {
    const found = presets.find((p) => p.slug === normalized);
    if (found) return found;
  }
  return presets[0] || null;
}

async function isValidFormatSlug(vendorId, slug) {
  if (!slug || !vendorId) return false;
  const presets = await loadPresetsForVendor(vendorId);
  return presets.some((p) => p.slug === String(slug).trim());
}

function normalizeSlug(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

function assertValidTemplate(template) {
  const trimmed = String(template || '').trim();
  if (!trimmed) throw new Error('Row template is required');
  const invalid = validateTemplatePlaceholders(trimmed);
  if (invalid.length) {
    const err = new Error(`Invalid placeholders: ${invalid.join(', ')}`);
    err.invalidPlaceholders = invalid;
    throw err;
  }
  return trimmed;
}

async function tableExists() {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT 1 AS ok
    WHERE OBJECT_ID('oe.VendorImportFormatPresets', 'U') IS NOT NULL
  `);
  return Boolean(r.recordset?.[0]?.ok);
}

async function createFormatPreset(vendorId, {
  slug, label, rowTemplate, sortOrder, importRules, tobaccoCsvColumn, tobaccoYesValues,
}) {
  if (!(await tableExists())) {
    throw new Error('VendorImportFormatPresets table is not installed — run sql-changes/2026-06-06-vendor-import-format-presets-schema.sql');
  }
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug) throw new Error('Format slug is required (letters, numbers, underscores)');
  const trimmedLabel = String(label || '').trim();
  if (!trimmedLabel) throw new Error('Display name is required');
  const template = assertValidTemplate(rowTemplate);
  const rulesJson = assertValidImportRules(importRules);
  const hasRulesCol = await importRulesColumnExists();
  const hasTobaccoCol = await tobaccoColumnsExist();

  const pool = await getPool();
  const dup = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('slug', sql.NVarChar(50), normalizedSlug)
    .query(`
      SELECT 1 AS ok FROM oe.VendorImportFormatPresets
      WHERE VendorId = @vendorId AND Slug = @slug
    `);
  if (dup.recordset?.[0]?.ok) throw new Error(`Format slug already exists: ${normalizedSlug}`);

  const req = pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('slug', sql.NVarChar(50), normalizedSlug)
    .input('label', sql.NVarChar(200), trimmedLabel)
    .input('template', sql.NVarChar(sql.MAX), template)
    .input('sortOrder', sql.Int, parseInt(sortOrder, 10) || 100);
  if (hasRulesCol && rulesJson) {
    req.input('rules', sql.NVarChar(sql.MAX), JSON.stringify(rulesJson));
  }
  if (hasTobaccoCol && tobaccoCsvColumn !== undefined) {
    req.input('tobaccoCol', sql.NVarChar(200), String(tobaccoCsvColumn || '').trim() || null);
    req.input('tobaccoYes', sql.NVarChar(500), formatTobaccoYesValuesForDb(tobaccoYesValues));
  }
  const rulesInsert = hasRulesCol && rulesJson ? ', ImportRulesJson' : '';
  const rulesVals = hasRulesCol && rulesJson ? ', @rules' : '';
  const tobaccoInsert = hasTobaccoCol && tobaccoCsvColumn !== undefined ? ', TobaccoCsvColumn, TobaccoYesValues' : '';
  const tobaccoVals = hasTobaccoCol && tobaccoCsvColumn !== undefined ? ', @tobaccoCol, @tobaccoYes' : '';
  const rulesOut = hasRulesCol ? ', INSERTED.ImportRulesJson' : '';
  const tobaccoOut = hasTobaccoCol ? ', INSERTED.TobaccoCsvColumn, INSERTED.TobaccoYesValues' : '';
  const result = await req.query(`
      INSERT INTO oe.VendorImportFormatPresets (VendorId, Slug, Label, RowTemplate, SortOrder${rulesInsert}${tobaccoInsert})
      OUTPUT INSERTED.Slug, INSERTED.Label, INSERTED.RowTemplate, INSERTED.SortOrder${rulesOut}${tobaccoOut}
      VALUES (@vendorId, @slug, @label, @template, @sortOrder${rulesVals}${tobaccoVals})
    `);

  clearCache(vendorId);
  return fromRow(result.recordset?.[0]);
}

async function updateFormatPreset(vendorId, slug, {
  label, rowTemplate, sortOrder, importRules, tobaccoCsvColumn, tobaccoYesValues,
}) {
  if (!(await tableExists())) throw new Error('Format presets table not installed');
  const normalizedSlug = String(slug || '').trim();
  const pool = await getPool();
  const existing = await getFormatPreset(vendorId, normalizedSlug);
  if (!existing) throw new Error('Format preset not found');

  const sets = ['ModifiedUtc = SYSUTCDATETIME()'];
  const req = pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('slug', sql.NVarChar(50), normalizedSlug);

  if (label !== undefined) {
    const trimmedLabel = String(label).trim();
    if (!trimmedLabel) throw new Error('Display name cannot be empty');
    req.input('label', sql.NVarChar(200), trimmedLabel);
    sets.push('Label = @label');
  }
  if (rowTemplate !== undefined) {
    req.input('template', sql.NVarChar(sql.MAX), assertValidTemplate(rowTemplate));
    sets.push('RowTemplate = @template');
  }
  if (sortOrder !== undefined) {
    req.input('sortOrder', sql.Int, parseInt(sortOrder, 10) || 0);
    sets.push('SortOrder = @sortOrder');
  }
  const hasRulesCol = await importRulesColumnExists();
  const hasTobaccoCol = await tobaccoColumnsExist();
  if (importRules !== undefined && hasRulesCol) {
    const rulesJson = assertValidImportRules(importRules);
    req.input('rules', sql.NVarChar(sql.MAX), rulesJson ? JSON.stringify(rulesJson) : null);
    sets.push('ImportRulesJson = @rules');
  }
  if (hasTobaccoCol && tobaccoCsvColumn !== undefined) {
    req.input('tobaccoCol', sql.NVarChar(200), String(tobaccoCsvColumn || '').trim() || null);
    req.input('tobaccoYes', sql.NVarChar(500), formatTobaccoYesValuesForDb(tobaccoYesValues));
    sets.push('TobaccoCsvColumn = @tobaccoCol', 'TobaccoYesValues = @tobaccoYes');
  }

  const rulesOut = hasRulesCol ? ', INSERTED.ImportRulesJson' : '';
  const tobaccoOut = hasTobaccoCol ? ', INSERTED.TobaccoCsvColumn, INSERTED.TobaccoYesValues' : '';
  const result = await req.query(`
    UPDATE oe.VendorImportFormatPresets
    SET ${sets.join(', ')}
    OUTPUT INSERTED.Slug, INSERTED.Label, INSERTED.RowTemplate, INSERTED.SortOrder${rulesOut}${tobaccoOut}
    WHERE VendorId = @vendorId AND Slug = @slug AND IsActive = 1
  `);

  clearCache(vendorId);
  return fromRow(result.recordset?.[0]);
}

async function deleteFormatPreset(vendorId, slug) {
  if (!(await tableExists())) throw new Error('Format presets table not installed');
  const normalizedSlug = String(slug || '').trim();
  const pool = await getPool();

  const jobUse = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('slug', sql.NVarChar(50), normalizedSlug)
    .query(`
      SELECT COUNT(*) AS cnt FROM oe.VendorImportJobs
      WHERE VendorId = @vendorId AND FormatSlug = @slug
    `);
  if ((jobUse.recordset?.[0]?.cnt || 0) > 0) {
    throw new Error('Cannot remove format — one or more scheduled import jobs still use it');
  }

  const result = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('slug', sql.NVarChar(50), normalizedSlug)
    .query(`
      UPDATE oe.VendorImportFormatPresets
      SET IsActive = 0, ModifiedUtc = SYSUTCDATETIME()
      WHERE VendorId = @vendorId AND Slug = @slug AND IsActive = 1
    `);

  clearCache(vendorId);
  return (result.rowsAffected?.[0] || 0) > 0;
}

module.exports = {
  listFormatPresets,
  getFormatPreset,
  isValidFormatSlug,
  createFormatPreset,
  updateFormatPreset,
  deleteFormatPreset,
  normalizeSlug,
  clearCache,
  loadPresetsForVendor,
};
