'use strict';

const sql = require('mssql');
const { getSharewellConfig, isSharewellConfigured } = require('./sharewellAgents.service');

let poolPromise = null;

async function getSharewellPool() {
  if (!isSharewellConfigured()) return null;
  if (!poolPromise) {
    const cfg = getSharewellConfig();
    poolPromise = new sql.ConnectionPool(cfg).connect().catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

async function lookupBenefitMetadata(productId, benefitId) {
  if (!productId || benefitId == null || !isSharewellConfigured()) return null;

  try {
    const pool = await getSharewellPool();
    if (!pool) return null;

    const result = await pool.request()
      .input('productId', sql.Int, Number(productId))
      .input('benefitId', sql.Int, Number(benefitId))
      .query(`
        SELECT TOP 1
          pb.benefit_id,
          pb.benefit_name,
          pb.tier,
          pb.ua
        FROM product_benefits pb
        INNER JOIN products p ON pb.product_id = p.id
        WHERE p.product_id = @productId
          AND pb.benefit_id = @benefitId
      `);

    const row = result.recordset?.[0];
    if (!row) return null;

    const tier = String(row.tier || '').trim().toUpperCase();
    return {
      benefitId: String(row.benefit_id),
      benefitName: row.benefit_name || null,
      tier: ['EE', 'ES', 'EC', 'EF'].includes(tier) ? tier : null,
      unsharedAmount: row.ua != null ? Number(row.ua) : null
    };
  } catch {
    return null;
  }
}

async function lookupBenefitsForProduct(productId) {
  if (!productId || !isSharewellConfigured()) return new Map();

  try {
    const pool = await getSharewellPool();
    if (!pool) return new Map();

    const result = await pool.request()
      .input('productId', sql.Int, Number(productId))
      .query(`
        SELECT
          pb.benefit_id,
          pb.benefit_name,
          pb.tier,
          pb.ua
        FROM product_benefits pb
        INNER JOIN products p ON pb.product_id = p.id
        WHERE p.product_id = @productId
      `);

    const map = new Map();
    for (const row of result.recordset || []) {
      const tier = String(row.tier || '').trim().toUpperCase();
      map.set(String(row.benefit_id), {
        benefitId: String(row.benefit_id),
        benefitName: row.benefit_name || null,
        tier: ['EE', 'ES', 'EC', 'EF'].includes(tier) ? tier : null,
        unsharedAmount: row.ua != null ? Number(row.ua) : null
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

module.exports = {
  lookupBenefitMetadata,
  lookupBenefitsForProduct
};
