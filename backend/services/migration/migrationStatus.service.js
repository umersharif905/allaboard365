'use strict';

const { sql, getPool } = require('../../config/database');

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Classify existing households for migration import.
 * - new: not in OpenEnroll yet
 * - pending_update: primary IsPendingMigration=1 and/or staging enrollments (IsPendingMigration=1)
 * - locked: finalized member with live (non-staging) enrollments — do not modify
 */
async function classifyHouseholdMigrationStates(householdMemberIds = []) {
  const ids = [...new Set((householdMemberIds || []).filter(Boolean))];
  const result = new Map();

  for (const id of ids) {
    result.set(id, { state: 'new', primaryMemberId: null, activeEnrollmentCount: 0 });
  }
  if (!ids.length) return result;

  const pool = await getPool();
  for (const chunk of chunkArray(ids, 400)) {
    const request = pool.request();
    const placeholders = chunk.map((id, index) => {
      const param = `memberId${index}`;
      request.input(param, sql.NVarChar, id);
      return `@${param}`;
    }).join(', ');

    const rows = await request.query(`
      SELECT
        m.HouseholdMemberID,
        m.MemberId,
        m.IsPendingMigration,
        (
          SELECT COUNT(*)
          FROM oe.Enrollments e
          WHERE e.MemberId = m.MemberId
            AND ISNULL(e.IsPendingMigration, 0) = 0
        ) AS ActiveEnrollmentCount,
        (
          SELECT COUNT(*)
          FROM oe.Enrollments e
          WHERE e.MemberId = m.MemberId
            AND ISNULL(e.IsPendingMigration, 0) = 1
        ) AS PendingEnrollmentCount
      FROM oe.Members m
      WHERE m.RelationshipType = 'P'
        AND m.HouseholdMemberID IN (${placeholders})
    `);

    for (const row of rows.recordset || []) {
      const activeEnrollmentCount = row.ActiveEnrollmentCount || 0;
      const pendingEnrollmentCount = row.PendingEnrollmentCount || 0;
      const isPendingMember = row.IsPendingMigration === true || row.IsPendingMigration === 1;
      let state = 'locked';
      if (isPendingMember || pendingEnrollmentCount > 0) {
        state = 'pending_update';
      } else if (activeEnrollmentCount > 0) {
        state = 'locked';
      }
      result.set(row.HouseholdMemberID, {
        state,
        primaryMemberId: row.MemberId,
        activeEnrollmentCount,
        pendingEnrollmentCount,
        isPendingMember
      });
    }
  }

  return result;
}

async function getAppliedAgentImportMap() {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT
      b.RootBrokerId,
      b.RootAgentLabel,
      b.IncludeDownline,
      b.TenantId,
      t.Name AS TenantName,
      b.ApplyCreateCount,
      b.ApplySkipCount,
      b.ModifiedUtc,
      b.BatchId
    FROM oe.MigrationImportBatch b
    LEFT JOIN oe.Tenants t ON t.TenantId = b.TenantId
    WHERE b.Status = 'applied' AND b.RootBrokerId IS NOT NULL
    ORDER BY b.ModifiedUtc DESC
  `);

  const map = new Map();
  for (const row of result.recordset || []) {
    const key = `${row.RootBrokerId}:${row.IncludeDownline ? 1 : 0}`;
    if (!map.has(key)) {
      map.set(key, {
        rootBrokerId: row.RootBrokerId,
        rootAgentLabel: row.RootAgentLabel,
        includeDownline: !!row.IncludeDownline,
        tenantId: row.TenantId,
        tenantName: row.TenantName,
        applyCreateCount: row.ApplyCreateCount || 0,
        applySkipCount: row.ApplySkipCount || 0,
        modifiedUtc: row.ModifiedUtc
      });
    }
  }
  return map;
}

async function getMigratedHouseholdMemberIds(memberIds) {
  const states = await classifyHouseholdMigrationStates(memberIds);
  const locked = new Set();
  for (const [memberId, info] of states.entries()) {
    if (info.state === 'locked') locked.add(memberId);
  }
  return locked;
}

async function getLockedHouseholdMemberIds(memberIds) {
  return getMigratedHouseholdMemberIds(memberIds);
}

/** Households already in AB365 (pending migration staging or live) — excluded from default import selection. */
async function getNonNewHouseholdMemberIds(memberIds) {
  const states = await classifyHouseholdMigrationStates(memberIds);
  const excluded = new Set();
  for (const [memberId, info] of states.entries()) {
    if (info.state !== 'new') excluded.add(memberId);
  }
  return excluded;
}

module.exports = {
  classifyHouseholdMigrationStates,
  getAppliedAgentImportMap,
  getMigratedHouseholdMemberIds,
  getLockedHouseholdMemberIds,
  getNonNewHouseholdMemberIds
};
