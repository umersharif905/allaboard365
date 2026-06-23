#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const dotenv = require('dotenv');

const backendEnvPath = path.resolve(__dirname, '..', '.env');
const aiScriptsEnvPath = path.resolve(__dirname, '..', '..', 'ai_scripts', '.env');

if (fs.existsSync(backendEnvPath)) {
  dotenv.config({ path: backendEnvPath });
} else if (fs.existsSync(aiScriptsEnvPath)) {
  dotenv.config({ path: aiScriptsEnvPath });
}

const DB_SERVER = process.env.DB_SERVER;
const DB_NAME = process.env.DB_NAME;
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;

if (!DB_SERVER || !DB_NAME || !DB_USER || !DB_PASSWORD) {
  console.error('Missing DB credentials. Set DB_SERVER, DB_NAME, DB_USER, DB_PASSWORD in backend/.env or ai_scripts/.env');
  process.exit(1);
}

const reportPath = path.resolve(__dirname, '..', '..', 'docs', 'product-tier-pricing-report.md');

const dbConfig = {
  server: DB_SERVER,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

function extractUnshared(label) {
  if (!label || typeof label !== 'string') return 'N/A';
  const match = label.match(/\b(\d{3,5})\b/);
  return match ? match[1] : 'N/A';
}

function fmtMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return 'N/A';
  return `$${Number(n).toFixed(2)}`;
}

function rangeLabel(values) {
  if (!values.length) return 'N/A';
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? fmtMoney(min) : `${fmtMoney(min)} - ${fmtMoney(max)}`;
}

function yesNo(bitValue) {
  return Number(bitValue) === 1 ? 'Yes' : 'No';
}

function sortUnshared(a, b) {
  if (a === 'N/A' && b === 'N/A') return 0;
  if (a === 'N/A') return 1;
  if (b === 'N/A') return -1;
  return Number(a) - Number(b);
}

function sortTier(a, b) {
  const order = ['EE', 'ES', 'EC', 'EF'];
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

async function run() {
  const pool = await sql.connect(dbConfig);

  const pricingQuery = `
    SELECT
      p.ProductId,
      p.Name AS ProductName,
      p.ProductType,
      p.Status AS ProductStatus,
      pp.TierType,
      pp.Label,
      pp.MSRPRate,
      pp.Status AS PricingStatus
    FROM oe.Products p
    LEFT JOIN oe.ProductPricing pp ON p.ProductId = pp.ProductId
    ORDER BY p.Name, pp.Label, pp.TierType
  `;

  const feeQuery = `
    SELECT
      ProductId,
      MAX(CASE WHEN IncludeProcessingFee = 1 THEN 1 ELSE 0 END) AS AnyIncludeProcessingFee,
      MAX(CASE WHEN RoundUpProcessingFee = 1 THEN 1 ELSE 0 END) AS AnyRoundUpProcessingFee,
      COUNT(*) AS SubscriptionRows
    FROM oe.TenantProductSubscriptions
    WHERE SubscriptionStatus IN ('Active', 'Approved')
    GROUP BY ProductId
  `;

  const pricingRows = (await pool.request().query(pricingQuery)).recordset;
  const feeRows = (await pool.request().query(feeQuery)).recordset;
  await sql.close();

  const feeByProduct = new Map(
    feeRows.map((r) => [
      String(r.ProductId),
      {
        include: Number(r.AnyIncludeProcessingFee) || 0,
        roundUp: Number(r.AnyRoundUpProcessingFee) || 0,
        rows: Number(r.SubscriptionRows) || 0
      }
    ])
  );

  const products = new Map();

  for (const row of pricingRows) {
    const productId = String(row.ProductId);
    if (!products.has(productId)) {
      products.set(productId, {
        productId,
        productName: row.ProductName || 'Unknown Product',
        productType: row.ProductType || 'Unknown',
        productStatus: row.ProductStatus || 'Unknown',
        rows: []
      });
    }
    products.get(productId).rows.push(row);
  }

  const sortedProducts = Array.from(products.values()).sort((a, b) => a.productName.localeCompare(b.productName));

  const lines = [];
  lines.push('# Product Tier & Pricing Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Database: ${DB_SERVER} / ${DB_NAME}`);
  lines.push('');
  lines.push('This report shows pricing grouped by product, unshared amount (derived from pricing label when present), and tier.');
  lines.push('');

  for (const product of sortedProducts) {
    const fee = feeByProduct.get(product.productId) || { include: 0, roundUp: 0, rows: 0 };
    lines.push(`## ${product.productName}`);
    lines.push('');
    lines.push(`- Product ID: \`${product.productId}\``);
    lines.push(`- Product Type: \`${product.productType}\``);
    lines.push(`- Product Status: \`${product.productStatus}\``);
    lines.push(`- Processing Fee Included (any active/approved subscription): **${yesNo(fee.include)}**`);
    lines.push(`- Processing Fee Round-Up Enabled (any active/approved subscription): **${yesNo(fee.roundUp)}**`);
    lines.push(`- Active/Approved Subscription Rows Found: **${fee.rows}**`);
    lines.push('');

    const pricedRows = product.rows.filter((r) => r.TierType && r.MSRPRate != null);
    if (!pricedRows.length) {
      lines.push('_No pricing rows found for this product._');
      lines.push('');
      continue;
    }

    const grouped = new Map();
    for (const row of pricedRows) {
      const unshared = extractUnshared(row.Label);
      const tier = row.TierType || 'Unknown';
      const key = `${unshared}||${tier}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          unshared,
          tier,
          activeRates: [],
          allRates: [],
          activeRows: 0,
          totalRows: 0
        });
      }
      const g = grouped.get(key);
      const rate = Number(row.MSRPRate);
      g.totalRows += 1;
      g.allRates.push(rate);
      if ((row.PricingStatus || '').toLowerCase() === 'active') {
        g.activeRows += 1;
        g.activeRates.push(rate);
      }
    }

    const groupedRows = Array.from(grouped.values()).sort((a, b) => {
      const u = sortUnshared(a.unshared, b.unshared);
      if (u !== 0) return u;
      return sortTier(a.tier, b.tier);
    });

    lines.push('| Unshared Amount | Tier | Active MSRP Range | All MSRP Range | Active Rows | Total Rows |');
    lines.push('|---|---|---:|---:|---:|---:|');
    for (const g of groupedRows) {
      lines.push(`| ${g.unshared} | ${g.tier} | ${rangeLabel(g.activeRates)} | ${rangeLabel(g.allRates)} | ${g.activeRows} | ${g.totalRows} |`);
    }
    lines.push('');
  }

  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Report created: ${reportPath}`);
  console.log(`Products included: ${sortedProducts.length}`);
}

run().catch(async (err) => {
  try {
    await sql.close();
  } catch (_) {
    // ignore
  }
  console.error('Failed to generate report:', err.message);
  process.exit(1);
});
