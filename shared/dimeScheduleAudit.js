'use strict';

/**
 * DIME recurring-SCHEDULE reconciliation (DIME → DB).
 *
 * Complements the transaction-level audits: walks every DIME customer for a
 * tenant, lists their recurring schedules at DIME, and compares the ACTIVE
 * ones against our schedule tables (oe.IndividualRecurringSchedules +
 * oe.GroupRecurringPaymentPlans). Detects:
 *
 *   1. ORPHANS — Active at DIME with no row in our DB at all. These are
 *      invisible to every cancel/update flow and have double-charged real
 *      customers (e.g. two $362.69 pulls/month for one household).
 *   2. AMOUNT MISMATCH — Active at DIME with a DB row whose MonthlyAmount
 *      differs (e.g. DIME $12.28 vs DB $389.72 — wrong charge next cycle).
 *   3. MULTIPLE ACTIVE — more than one Active schedule for one customer
 *      (guaranteed double-charge).
 *
 * Report-only: findings are returned for the caller to alert on. Cancelling
 * is intentionally NOT automated to avoid racing a legitimate create whose
 * DB persist hasn't landed yet.
 */

const { getPool, sql } = require('./db');
const DimeService = require('./dimeService');

/**
 * DIME returns money as display strings with thousands separators (e.g. "1,536.17").
 * parseFloat would truncate that to 1 — strip separators first.
 */
function parseMoney(value) {
  if (typeof value === 'number') return value;
  const cleaned = String(value ?? '').replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Calendar days from referenceDate (UTC) until nextRunDate (YYYY-MM-DD). */
function daysUntilNextRun(nextRunDateStr, referenceDate = new Date()) {
  if (!nextRunDateStr) return Infinity;
  const parts = String(nextRunDateStr).slice(0, 10).split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return Infinity;
  const [y, m, d] = parts;
  const nextMs = Date.UTC(y, m - 1, d);
  const refMs = Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate()
  );
  return Math.floor((nextMs - refMs) / 86400000);
}

/**
 * Group schedules are recreated on the 1st for the new billing month. Mid-month,
 * DIME still holds last month's amount while our DB row may already reflect next
 * month's roster — suppress when DIME matches the linked invoice the schedule
 * was created for, unless charge is imminent (scheduler should have refreshed).
 */
function isGroupMidMonthDrift({ db, dimeAmount, nextRunDate, referenceDate }) {
  if (db.source !== 'group') return false;
  const linked = db.linkedInvoiceTotal;
  if (linked == null || !Number.isFinite(Number(linked))) return false;
  const linkedRounded = Math.round(Number(linked) * 100) / 100;
  if (Math.abs(linkedRounded - dimeAmount) >= 0.01) return false;
  return daysUntilNextRun(nextRunDate, referenceDate) > 3;
}

/** Compare one customer's DIME schedules against the DB schedule map. */
function compareCustomerSchedules({ customerUuid, dimeSchedules, dbByScheduleId, referenceDate }) {
  const findings = { orphans: [], amountMismatches: [], multipleActive: [] };
  const active = (dimeSchedules || []).filter(
    (s) => String(s.status || '').trim().toLowerCase() === 'active'
  );

  for (const s of active) {
    const sid = String(s.id ?? s.schedule_id ?? '').trim();
    if (!sid) continue;
    const dimeAmount = Math.round(parseMoney(s.amount) * 100) / 100;
    const db = dbByScheduleId.get(sid);
    const base = {
      customerUuid,
      scheduleId: sid,
      dimeAmount,
      name: String(s.name || ''),
      nextRunDate: String(s.next_run_date || '').slice(0, 10) || null
    };
    if (!db) {
      findings.orphans.push(base);
      continue;
    }
    const dbAmount = Math.round((parseFloat(db.amount) || 0) * 100) / 100;
    if (Math.abs(dbAmount - dimeAmount) >= 0.01) {
      if (isGroupMidMonthDrift({ db, dimeAmount, nextRunDate: base.nextRunDate, referenceDate })) {
        continue;
      }
      findings.amountMismatches.push({ ...base, dbAmount, dbActive: db.active, source: db.source });
    }
  }

  if (active.length > 1) {
    findings.multipleActive.push({
      customerUuid,
      scheduleIds: active.map((s) => String(s.id ?? s.schedule_id ?? '').trim()),
      amounts: active.map((s) => Math.round(parseMoney(s.amount) * 100) / 100)
    });
  }
  return findings;
}

async function listScheduleCustomersForTenant(pool, tenantId) {
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT DISTINCT mpm.ProcessorCustomerId AS CustomerUuid
      FROM oe.MemberPaymentMethods mpm
      INNER JOIN oe.Members m ON m.MemberId = mpm.MemberId
      WHERE m.TenantId = @tenantId AND mpm.ProcessorCustomerId IS NOT NULL
      UNION
      SELECT DISTINCT g.ProcessorCustomerId
      FROM oe.Groups g
      WHERE g.TenantId = @tenantId AND g.ProcessorCustomerId IS NOT NULL
    `);
  return result.recordset.map((r) => String(r.CustomerUuid).trim()).filter(Boolean);
}

/** All known schedule ids (any active flag) so orphan detection only fires on truly unknown ids. */
async function loadDbSchedulesForTenant(pool, tenantId) {
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT CAST(irs.DimeScheduleId AS NVARCHAR(64)) AS Sid, irs.MonthlyAmount AS Amount,
             CAST(irs.IsActive AS INT) AS Active, 'individual' AS Source,
             CAST(NULL AS DECIMAL(12, 2)) AS LinkedInvoiceTotal
      FROM oe.IndividualRecurringSchedules irs
      WHERE irs.TenantId = @tenantId AND irs.DimeScheduleId IS NOT NULL
      UNION ALL
      SELECT CAST(grp.DimeScheduleId AS NVARCHAR(64)), grp.MonthlyAmount,
             CAST(grp.IsActive AS INT), 'group',
             inv.TotalAmount AS LinkedInvoiceTotal
      FROM oe.GroupRecurringPaymentPlans grp
      INNER JOIN oe.Groups g ON g.GroupId = grp.GroupId
      LEFT JOIN oe.Invoices inv ON inv.InvoiceId = grp.InvoiceId
      WHERE g.TenantId = @tenantId AND grp.DimeScheduleId IS NOT NULL
    `);
  const map = new Map();
  for (const row of result.recordset) {
    const sid = String(row.Sid || '').trim();
    if (!sid) continue;
    const entry = {
      amount: row.Amount,
      active: row.Active === 1,
      source: row.Source,
      linkedInvoiceTotal: row.LinkedInvoiceTotal != null ? row.LinkedInvoiceTotal : null
    };
    // Prefer an active row when the same DIME id appears twice.
    if (!map.has(sid) || (entry.active && !map.get(sid).active)) map.set(sid, entry);
  }
  return map;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {number} [params.requestDelayMs=120]
 * @returns {Promise<Object>} summary with orphans/amountMismatches/multipleActive
 */
async function runScheduleAudit(params) {
  const tenantId = params.tenantId;
  if (!tenantId) throw new Error('tenantId is required');
  const requestDelayMs = Math.min(2000, Math.max(0, Number(params.requestDelayMs) || 120));

  const pool = await getPool();
  const customerUuids = await listScheduleCustomersForTenant(pool, tenantId);
  const dbByScheduleId = await loadDbSchedulesForTenant(pool, tenantId);

  const summary = {
    tenantId,
    customersTotal: customerUuids.length,
    customersChecked: 0,
    customerLookupFailures: 0,
    activeSchedulesSeen: 0,
    orphans: [],
    amountMismatches: [],
    multipleActive: []
  };

  for (const uuid of customerUuids) {
    if (requestDelayMs) await sleep(requestDelayMs);
    let res;
    try {
      res = await DimeService.listRecurringPayments(uuid, tenantId);
    } catch (e) {
      summary.customerLookupFailures += 1;
      continue;
    }
    if (!res || !res.success) {
      summary.customerLookupFailures += 1;
      continue;
    }
    summary.customersChecked += 1;
    const schedules = res.schedules || [];
    summary.activeSchedulesSeen += schedules.filter(
      (s) => String(s.status || '').trim().toLowerCase() === 'active'
    ).length;
    const f = compareCustomerSchedules({ customerUuid: uuid, dimeSchedules: schedules, dbByScheduleId });
    summary.orphans.push(...f.orphans);
    summary.amountMismatches.push(...f.amountMismatches);
    summary.multipleActive.push(...f.multipleActive);
  }

  return summary;
}

module.exports = {
  runScheduleAudit,
  compareCustomerSchedules,
  listScheduleCustomersForTenant,
  loadDbSchedulesForTenant,
  parseMoney,
  daysUntilNextRun,
  isGroupMidMonthDrift
};
