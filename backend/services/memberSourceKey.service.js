'use strict';

const { getPool, sql } = require('../config/database');

async function upsertMemberSourceKey({ vendorId, sourceSystem, sourceKey, memberId }) {
  if (!vendorId || !sourceSystem || !sourceKey || !memberId) return;
  const pool = await getPool();
  await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('sourceSystem', sql.NVarChar(50), sourceSystem)
    .input('sourceKey', sql.NVarChar(200), String(sourceKey).slice(0, 200))
    .input('memberId', sql.UniqueIdentifier, memberId)
    .query(`
      MERGE oe.MemberSourceKeys AS t
      USING (SELECT @vendorId AS VendorId, @sourceSystem AS SourceSystem, @sourceKey AS SourceKey) AS s
      ON t.VendorId = s.VendorId AND t.SourceSystem = s.SourceSystem AND t.SourceKey = s.SourceKey
      WHEN MATCHED THEN UPDATE SET MemberId = @memberId
      WHEN NOT MATCHED THEN INSERT (VendorId, SourceSystem, SourceKey, MemberId)
        VALUES (@vendorId, @sourceSystem, @sourceKey, @memberId);
    `);
}

async function findMemberBySourceKeys(vendorId, keys = []) {
  const pool = await getPool();
  for (const { sourceSystem, sourceKey } of keys) {
    if (!sourceKey) continue;
    const r = await pool.request()
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .input('sourceSystem', sql.NVarChar(50), sourceSystem)
      .input('sourceKey', sql.NVarChar(200), String(sourceKey).slice(0, 200))
      .query(`
        SELECT MemberId FROM oe.MemberSourceKeys
        WHERE VendorId = @vendorId AND SourceSystem = @sourceSystem AND SourceKey = @sourceKey
      `);
    if (r.recordset[0]?.MemberId) return r.recordset[0].MemberId;
  }
  return null;
}

async function findMemberByHouseholdMemberId(householdMemberId, tenantId = null) {
  if (!householdMemberId) return null;
  const pool = await getPool();
  const req = pool.request().input('hmid', sql.NVarChar(50), String(householdMemberId).trim());
  let q = `
    SELECT TOP 1 m.MemberId, m.TenantId
    FROM oe.Members m
    WHERE m.HouseholdMemberID = @hmid
  `;
  if (tenantId) {
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    q += ' AND m.TenantId = @tenantId';
  }
  q += ' ORDER BY m.CreatedDate DESC';
  const r = await req.query(q);
  return r.recordset[0] || null;
}

module.exports = {
  upsertMemberSourceKey,
  findMemberBySourceKeys,
  findMemberByHouseholdMemberId,
};
