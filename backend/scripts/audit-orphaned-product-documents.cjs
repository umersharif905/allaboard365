#!/usr/bin/env node
'use strict';

/**
 * Read-only audit of orphaned product-document references.
 *
 * Background: members reported "The specified blob does not exist" when opening
 * a plan's Documents (e.g. some dental plans). Investigation showed those rows
 * point at blobs that are genuinely absent from storage — orphaned references,
 * not a signing bug. (Separately, every stored DocumentUrl has a SAS token
 * baked in; the runtime re-signs from the URL path so that doesn't cause the
 * 404, but it's flagged here as a data-hygiene smell.)
 *
 * This script checks every document URL in:
 *   - oe.ProductDocuments.DocumentUrl   (multi-document products)
 *   - oe.Products.ProductDocumentUrl    (legacy single-document column)
 * against Azure Blob Storage, and reports which point at a missing blob.
 *
 * The container + blob name are parsed from the URL PATH (the baked-in SAS
 * query string is ignored) — exactly how the runtime resolves them.
 *
 * Writes NOTHING. Read-only SELECTs + blob .exists() checks only.
 *
 * Usage: node scripts/audit-orphaned-product-documents.cjs
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getPool } = require('../config/database');
const { BlobServiceClient } = require('@azure/storage-blob');

const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!cs) {
  console.error('❌ AZURE_STORAGE_CONNECTION_STRING not set; cannot check blob existence.');
  process.exit(1);
}
const blobServiceClient = BlobServiceClient.fromConnectionString(cs);
const accountName = (cs.match(/AccountName=([^;]+)/) || [])[1] || '(unknown)';

// Parse container + blob name out of a stored URL, ignoring any ?sv=...&sig=...
// SAS query string. Returns null for non-URL / relative values.
function parseBlobUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return {
      container: decodeURIComponent(parts[0]),
      blob: parts.slice(1).map(decodeURIComponent).join('/'),
    };
  } catch {
    return null;
  }
}

const existsCache = new Map(); // `${container}/${blob}` -> boolean
async function blobExists(container, blob) {
  const key = `${container}/${blob}`;
  if (existsCache.has(key)) return existsCache.get(key);
  const ok = await blobServiceClient.getContainerClient(container).getBlockBlobClient(blob).exists();
  existsCache.set(key, ok);
  return ok;
}

async function gatherRows(pool) {
  const docs = (await pool.request().query(`
    SELECT pd.ProductDocumentId AS Id, pd.ProductId, p.Name AS ProductName,
           pd.DisplayName, pd.DocumentUrl AS Url
    FROM oe.ProductDocuments pd
    LEFT JOIN oe.Products p ON p.ProductId = pd.ProductId
    WHERE pd.DocumentUrl IS NOT NULL AND LTRIM(RTRIM(pd.DocumentUrl)) <> ''
  `)).recordset.map((r) => ({ ...r, Source: 'ProductDocuments' }));

  const legacy = (await pool.request().query(`
    SELECT p.ProductId AS Id, p.ProductId, p.Name AS ProductName,
           NULL AS DisplayName, p.ProductDocumentUrl AS Url
    FROM oe.Products p
    WHERE p.ProductDocumentUrl IS NOT NULL AND LTRIM(RTRIM(p.ProductDocumentUrl)) <> ''
  `)).recordset.map((r) => ({ ...r, Source: 'Products.ProductDocumentUrl(legacy)' }));

  return [...docs, ...legacy];
}

async function main() {
  console.log(`Storage account: ${accountName}`);
  console.log('Checking product-document blob references (read-only)…\n');

  const pool = await getPool();
  const rows = await gatherRows(pool);

  const missing = [];
  const unparseable = [];
  let bakedSas = 0;
  const byContainer = new Map(); // container -> { checked, missing }

  for (const row of rows) {
    if (/[?&]sig=/.test(row.Url)) bakedSas++;
    const parsed = parseBlobUrl(row.Url);
    if (!parsed) {
      unparseable.push(row);
      continue;
    }
    const stat = byContainer.get(parsed.container) || { checked: 0, missing: 0 };
    stat.checked++;
    const ok = await blobExists(parsed.container, parsed.blob);
    if (!ok) {
      stat.missing++;
      missing.push({ ...row, container: parsed.container, blob: parsed.blob });
    }
    byContainer.set(parsed.container, stat);
  }

  console.log('=== Orphaned references (blob missing from storage) ===');
  if (missing.length === 0) {
    console.log('  none 🎉');
  } else {
    for (const m of missing) {
      console.log(`  ✗ [${m.Source}] "${m.ProductName || '(no name)'}"${m.DisplayName ? ` / ${m.DisplayName}` : ''}`);
      console.log(`      ${m.container}/${m.blob}`);
      console.log(`      id=${m.Id} productId=${m.ProductId}`);
    }
  }

  if (unparseable.length) {
    console.log('\n=== Unparseable / non-URL DocumentUrl values ===');
    for (const u of unparseable) {
      console.log(`  ? [${u.Source}] "${u.ProductName || '(no name)'}" id=${u.Id} url=${String(u.Url).slice(0, 80)}`);
    }
  }

  console.log('\n=== Per-container summary ===');
  for (const [c, s] of byContainer) {
    console.log(`  ${c}: ${s.checked} checked, ${s.missing} missing`);
  }

  console.log('\n=== Totals ===');
  console.log(`  rows examined:        ${rows.length}`);
  console.log(`  parseable URLs:       ${rows.length - unparseable.length}`);
  console.log(`  unparseable:          ${unparseable.length}`);
  console.log(`  orphaned (missing):   ${missing.length}`);
  console.log(`  with SAS baked in:    ${bakedSas}/${rows.length}  (data-hygiene smell; not the cause of the 404)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('audit failed:', e); process.exit(1); });
