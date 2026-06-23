// Invoice-anchored commission top-up: recompute expected payouts vs existing rows.
const { getPool, sql } = require('../config/database');
const mssql = require('mssql');
const CommissionServiceAdvances = require('./commissionService.advances');
const logger = require('../config/logger');

const PAID_PAYMENT_STATUSES = `('Completed', 'Draft', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded')`;

function invoiceCommissionExistsClause(invAlias = 'inv') {
  return `
    EXISTS (
      SELECT 1 FROM oe.Commissions c
      WHERE c.Status != N'Deleted'
        AND c.TransactionType = N'Commission'
        AND (
          c.InvoiceId = ${invAlias}.InvoiceId
          OR EXISTS (
            SELECT 1 FROM oe.Payments pLink
            WHERE pLink.InvoiceId = ${invAlias}.InvoiceId
              AND pLink.PaymentId = c.PaymentId
          )
        )
    )
  `;
}

/**
 * Paid invoices in range that already have commission rows (candidates for top-up).
 */
async function listTopupEligibleInvoices({ startDate, endDate, tenantId = null } = {}) {
  const pool = await getPool();
  const req = pool.request();
  let tenantFilter = '';
  if (tenantId) {
    req.input('TenantId', sql.UniqueIdentifier, tenantId);
    tenantFilter = ' AND inv.TenantId = @TenantId';
  }

  let dateFilter = '';
  if (startDate && endDate) {
    req.input('StartDate', sql.Date, startDate);
    req.input('EndDate', sql.Date, endDate);
    dateFilter = `
      AND CAST(COALESCE(inv.PaymentReceivedDate, inv.DueDate, inv.BillingPeriodStart) AS DATE) >= @StartDate
      AND CAST(COALESCE(inv.PaymentReceivedDate, inv.DueDate, inv.BillingPeriodStart) AS DATE) <= @EndDate`;
  }

  const result = await req.query(`
    SELECT
      inv.InvoiceId,
      inv.InvoiceNumber,
      inv.Status AS InvoiceStatus,
      inv.TotalAmount,
      inv.Commission,
      inv.BillingPeriodStart,
      inv.BillingPeriodEnd,
      COALESCE(inv.PaymentReceivedDate, inv.DueDate, inv.BillingPeriodStart) AS AnchorDate,
      inv.PaymentReceivedDate,
      inv.HouseholdId,
      inv.GroupId,
      e.AgentId AS ResolvedAgentId,
      ISNULL(u.FirstName + ' ' + u.LastName, '') AS AgentName,
      CASE
        WHEN inv.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN pg.Name
        ELSE (
          SELECT TOP 1 um.FirstName + ' ' + um.LastName
          FROM oe.Members mm
          INNER JOIN oe.Users um ON mm.UserId = um.UserId
          WHERE mm.HouseholdId = inv.HouseholdId
          ORDER BY CASE WHEN mm.RelationshipType = 'P' THEN 0 ELSE 1 END
        )
      END AS ClientName,
      (SELECT TOP 1 mm.MemberId
         FROM oe.Members mm
         WHERE mm.HouseholdId = inv.HouseholdId
         ORDER BY CASE WHEN mm.RelationshipType = 'P' THEN 0 ELSE 1 END
      ) AS PrimaryMemberId,
      settle.PaymentId AS SettlementPaymentId,
      settle.PaymentDate AS SettlementPaymentDate,
      (
        SELECT SUM(COALESCE(c.Amount, 0))
        FROM oe.Commissions c
        WHERE c.Status != N'Deleted'
          AND c.TransactionType = N'Commission'
          AND (c.RuleIds IS NULL OR c.RuleIds NOT LIKE N'AGENT_OVERRIDE:%')
          AND (
            c.InvoiceId = inv.InvoiceId
            OR (settle.PaymentId IS NOT NULL AND c.PaymentId = settle.PaymentId)
          )
      ) AS ExistingCommissionTotal
    FROM oe.Invoices inv
    LEFT JOIN oe.Groups pg ON inv.GroupId = pg.GroupId
    OUTER APPLY (
      SELECT TOP 1 e.AgentId
      FROM oe.Enrollments e
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      WHERE ${CommissionServiceAdvances.billingPeriodEnrollmentStatusSql('e')}
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND (
          (inv.HouseholdId IS NOT NULL AND e.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P')
          OR (inv.GroupId IS NOT NULL AND m.GroupId = inv.GroupId AND m.RelationshipType = 'P')
        )
        AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= inv.BillingPeriodEnd)
        AND (e.TerminationDate IS NULL OR e.TerminationDate > inv.BillingPeriodStart)
      ORDER BY e.CreatedDate ASC
    ) e
    LEFT JOIN oe.Agents a ON e.AgentId = a.AgentId
    LEFT JOIN oe.Users u ON a.UserId = u.UserId
    OUTER APPLY (
      SELECT TOP 1 p.PaymentId, p.PaymentDate
      FROM oe.Payments p
      WHERE p.InvoiceId = inv.InvoiceId
        AND p.Status IN ${PAID_PAYMENT_STATUSES}
        AND p.AgentId IS NOT NULL
      ORDER BY p.PaymentDate DESC
    ) settle
    WHERE inv.Status = N'Paid'
      AND inv.Commission IS NOT NULL
      AND inv.Commission > 0
      AND e.AgentId IS NOT NULL
      AND a.Status = N'Active'
      AND ${invoiceCommissionExistsClause('inv')}
      ${tenantFilter}
      ${dateFilter}
    ORDER BY COALESCE(inv.PaymentReceivedDate, inv.DueDate, inv.BillingPeriodStart) ASC
  `);

  return (result.recordset || []).map((row) => {
    const isGroup = row.GroupId != null;
    return {
      invoiceId: row.InvoiceId.toString(),
      invoiceNumber: row.InvoiceNumber || null,
      invoiceStatus: row.InvoiceStatus,
      anchorDate: row.AnchorDate,
      paymentReceivedDate: row.PaymentReceivedDate || null,
      billingPeriodStart: row.BillingPeriodStart || null,
      billingPeriodEnd: row.BillingPeriodEnd || null,
      totalAmount: Number(row.TotalAmount) || 0,
      commission: row.Commission != null ? Number(row.Commission) : null,
      agentId: row.ResolvedAgentId ? row.ResolvedAgentId.toString() : null,
      agentName: row.AgentName || null,
      clientName: row.ClientName || '—',
      clientType: isGroup ? 'group' : 'individual',
      groupId: isGroup ? row.GroupId : null,
      memberId: !isGroup && row.PrimaryMemberId != null ? row.PrimaryMemberId : null,
      settlementPaymentId: row.SettlementPaymentId ? row.SettlementPaymentId.toString() : null,
      settlementPaymentDate: row.SettlementPaymentDate || null,
      existingCommissionTotal: Number(row.ExistingCommissionTotal) || 0
    };
  });
}

async function loadInvoiceTopupContext(invoiceId) {
  const pool = await getPool();
  const req = pool.request();
  req.input('InvoiceId', sql.UniqueIdentifier, invoiceId);
  const result = await req.query(`
    SELECT TOP 1
      inv.InvoiceId,
      inv.InvoiceNumber,
      inv.HouseholdId,
      inv.GroupId,
      inv.TenantId,
      inv.BillingPeriodStart,
      inv.BillingPeriodEnd,
      inv.TotalAmount,
      inv.Commission,
      inv.OverrideRate,
      inv.NetRate,
      inv.Status,
      e.AgentId AS PrimaryAgentId,
      e.ProductId AS PrimaryProductId,
      settle.PaymentId AS SettlementPaymentId,
      settle.PaymentDate AS SettlementPaymentDate,
      settle.Status AS SettlementPaymentStatus,
      settle.Amount AS SettlementPaymentAmount
    FROM oe.Invoices inv
    OUTER APPLY (
      SELECT TOP 1 e.AgentId, e.ProductId
      FROM oe.Enrollments e
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      WHERE ${CommissionServiceAdvances.billingPeriodEnrollmentStatusSql('e')}
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND (
          (inv.HouseholdId IS NOT NULL AND e.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P')
          OR (inv.GroupId IS NOT NULL AND m.GroupId = inv.GroupId AND m.RelationshipType = 'P')
        )
        AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= inv.BillingPeriodEnd)
        AND (e.TerminationDate IS NULL OR e.TerminationDate > inv.BillingPeriodStart)
      ORDER BY e.CreatedDate ASC
    ) e
    OUTER APPLY (
      SELECT TOP 1 p.PaymentId, p.PaymentDate, p.Status, p.Amount
      FROM oe.Payments p
      WHERE p.InvoiceId = inv.InvoiceId
        AND p.Status IN ${PAID_PAYMENT_STATUSES}
        AND p.AgentId IS NOT NULL
      ORDER BY p.PaymentDate DESC
    ) settle
    WHERE inv.InvoiceId = @InvoiceId
  `);
  return result.recordset[0] || null;
}

async function getExistingCommissionTotalsForInvoice(invoiceId, settlementPaymentId = null) {
  const pool = await getPool();
  const req = pool.request();
  req.input('InvoiceId', sql.UniqueIdentifier, invoiceId);
  req.input('SettlementPaymentId', sql.UniqueIdentifier, settlementPaymentId || null);
  const result = await req.query(`
    SELECT
      CASE WHEN c.AgencyId IS NOT NULL THEN 'Agency' ELSE 'Agent' END AS EntityType,
      COALESCE(c.AgencyId, c.AgentId) AS EntityId,
      SUM(COALESCE(c.Amount, 0)) AS ExistingAmount
    FROM oe.Commissions c
    WHERE c.Status != N'Deleted'
      AND c.TransactionType = N'Commission'
      AND (c.AgentId IS NOT NULL OR c.AgencyId IS NOT NULL)
      AND (c.RuleIds IS NULL OR c.RuleIds NOT LIKE N'AGENT_OVERRIDE:%')
      AND (
        c.InvoiceId = @InvoiceId
        OR (@SettlementPaymentId IS NOT NULL AND c.PaymentId = @SettlementPaymentId)
      )
    GROUP BY CASE WHEN c.AgencyId IS NOT NULL THEN 'Agency' ELSE 'Agent' END, COALESCE(c.AgencyId, c.AgentId)
  `);
  const map = new Map();
  for (const row of result.recordset || []) {
    const key = `${row.EntityType}:${String(row.EntityId || '').toUpperCase()}`;
    map.set(key, Number(row.ExistingAmount || 0));
  }
  return map;
}

async function resolveRecipientNames(expectedMap) {
  const pool = await getPool();
  const agentIds = [];
  const agencyIds = [];
  for (const entry of expectedMap.values()) {
    if (entry.entityType === 'Agent') agentIds.push(entry.entityId);
    if (entry.entityType === 'Agency') agencyIds.push(entry.entityId);
  }
  const recipientNameByKey = new Map();
  if (agentIds.length > 0) {
    const safeAgentIds = agentIds.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(',');
    const agentNamesResult = await pool.request().query(`
      SELECT a.AgentId, u.FirstName + ' ' + u.LastName AS AgentName
      FROM oe.Agents a
      INNER JOIN oe.Users u ON a.UserId = u.UserId
      WHERE a.AgentId IN (${safeAgentIds})
    `);
    for (const row of agentNamesResult.recordset || []) {
      recipientNameByKey.set(`Agent:${String(row.AgentId || '').toUpperCase()}`, (row.AgentName || '').trim() || null);
    }
  }
  if (agencyIds.length > 0) {
    const safeAgencyIds = agencyIds.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(',');
    const agencyNamesResult = await pool.request().query(`
      SELECT AgencyId, AgencyName FROM oe.Agencies WHERE AgencyId IN (${safeAgencyIds})
    `);
    for (const row of agencyNamesResult.recordset || []) {
      recipientNameByKey.set(`Agency:${String(row.AgencyId || '').toUpperCase()}`, row.AgencyName || null);
    }
  }
  return recipientNameByKey;
}

function aggregateExpectedRows(expectedRows) {
  const expectedMap = new Map();
  for (const row of expectedRows) {
    const entityType = row.agencyId ? 'Agency' : 'Agent';
    const entityId = String(row.agencyId || row.agentId || '').toUpperCase();
    if (!entityId) continue;
    const key = `${entityType}:${entityId}`;
    if (!expectedMap.has(key)) {
      expectedMap.set(key, { entityType, entityId, expectedAmount: 0, sample: row });
    }
    expectedMap.get(key).expectedAmount += Number(row.amount || 0);
  }
  return expectedMap;
}

/**
 * Compute top-up preview rows for one invoice (dry-run only).
 */
async function computeTopupDeltasForInvoice(invoiceId) {
  const ctx = await loadInvoiceTopupContext(invoiceId);
  if (!ctx) {
    return { invoiceId, previewRows: [], error: 'Invoice not found' };
  }
  if (ctx.Status !== 'Paid') {
    return { invoiceId, previewRows: [], error: 'Invoice is not Paid' };
  }
  if (!ctx.PrimaryAgentId) {
    return { invoiceId, previewRows: [], error: 'No agent on primary enrollment' };
  }

  const commissionStatus = ctx.SettlementPaymentStatus === 'Draft' ? 'Draft' : 'Pending';
  const paymentDate = ctx.SettlementPaymentDate || ctx.BillingPeriodStart;
  const paymentAmount = ctx.SettlementPaymentAmount != null
    ? parseFloat(ctx.SettlementPaymentAmount)
    : parseFloat(ctx.TotalAmount) || 0;

  let expected;
  try {
    expected = await CommissionServiceAdvances.createCommissionsForPayment({
      paymentId: ctx.SettlementPaymentId || null,
      invoiceId: ctx.InvoiceId,
      householdId: ctx.GroupId ? null : ctx.HouseholdId,
      groupId: ctx.GroupId,
      paymentDate,
      // Do not pin a single enrollment product — invoice pools span all component
      // products (e.g. Copay + ShareWELL). Passing PrimaryProductId recalc'd only
      // one slice and dumped the rest into agency overflow.
      productId: null,
      paymentAmount,
      agentId: ctx.PrimaryAgentId,
      tenantId: ctx.TenantId,
      commission: ctx.Commission != null ? parseFloat(ctx.Commission) : null,
      overrideRate: ctx.OverrideRate != null ? parseFloat(ctx.OverrideRate) : 0,
      netRate: ctx.NetRate != null ? parseFloat(ctx.NetRate) : null,
      commissionStatus,
      dryRun: true
    });
  } catch (err) {
    logger.warn('Top-up dry run failed for invoice', { invoiceId, error: err.message });
    return { invoiceId, previewRows: [], error: err.message };
  }

  const expectedRows = (expected.dryRunRows || []).filter((r) =>
    !r?._previewError &&
    r.transactionType === 'Commission' &&
    Number(r.amount || 0) !== 0 &&
    !(typeof r.ruleIds === 'string' && r.ruleIds.startsWith('AGENT_OVERRIDE:'))
  );

  const expectedMap = aggregateExpectedRows(expectedRows);
  const existingMap = await getExistingCommissionTotalsForInvoice(invoiceId, ctx.SettlementPaymentId);
  const recipientNameByKey = await resolveRecipientNames(expectedMap);

  const previewRows = [];
  for (const [key, entry] of expectedMap.entries()) {
    const existingAmount = Number(existingMap.get(key) || 0);
    const expectedAmount = Number(entry.expectedAmount || 0);
    const deltaAmount = Math.round((expectedAmount - existingAmount) * 100) / 100;
    if (deltaAmount <= 0) continue;
    previewRows.push({
      invoiceId: ctx.InvoiceId.toString(),
      invoiceNumber: ctx.InvoiceNumber || null,
      paymentId: ctx.SettlementPaymentId ? ctx.SettlementPaymentId.toString() : null,
      entityType: entry.entityType,
      entityId: entry.entityId,
      recipientName: recipientNameByKey.get(key) || null,
      expectedAmount,
      existingAmount,
      deltaAmount,
      transactionType: 'Commission',
      sample: entry.sample
    });
  }

  return { invoiceId, previewRows, context: ctx, commissionStatus, expectedMap };
}

async function applyTopupForInvoice(invoiceId, { dryRun = true, transaction = null } = {}) {
  const computed = await computeTopupDeltasForInvoice(invoiceId);
  if (computed.error && computed.previewRows.length === 0) {
    return { invoiceId, previewRows: [], created: [], error: computed.error };
  }

  const previewRows = computed.previewRows.map((row) => ({ ...row, mode: dryRun ? 'dryRun' : 'insert' }));
  if (dryRun) {
    return { invoiceId, previewRows, created: [] };
  }

  const ctx = computed.context;
  const pool = await getPool();
  const commissionStatus = computed.commissionStatus || 'Pending';
  const created = [];

  if (ctx.SettlementPaymentId && transaction) {
    try {
      const cleanupReq = new mssql.Request(transaction);
      cleanupReq.input('PaymentId', sql.UniqueIdentifier, ctx.SettlementPaymentId);
      await cleanupReq.query(`
        UPDATE oe.Commissions
        SET Status = 'Deleted', ModifiedDate = GETUTCDATE()
        WHERE PaymentId = @PaymentId
          AND Status <> 'Deleted'
          AND RuleIds LIKE 'AGENT_OVERRIDE:%'
      `);
    } catch (cleanupErr) {
      logger.warn('Failed to soft-delete stale agent override rows during top-up', {
        invoiceId,
        paymentId: ctx.SettlementPaymentId,
        error: cleanupErr.message
      });
    }
  }

  for (const row of previewRows) {
    const sample = row.sample || {};
    const insertedId = await CommissionServiceAdvances.createCommissionRow({
      agentId: row.entityType === 'Agent' ? row.entityId : null,
      agencyId: row.entityType === 'Agency' ? row.entityId : null,
      enrollmentId: sample.enrollmentId || null,
      householdId: ctx.GroupId ? null : (ctx.HouseholdId || sample.householdId || null),
      groupId: ctx.GroupId || sample.groupId || null,
      paymentId: ctx.SettlementPaymentId || null,
      invoiceId: ctx.InvoiceId,
      amount: row.deltaAmount,
      paymentAmount: ctx.SettlementPaymentAmount != null ? parseFloat(ctx.SettlementPaymentAmount) : parseFloat(ctx.TotalAmount),
      balance: null,
      appliedToBalance: null,
      status: commissionStatus,
      transactionType: 'Commission',
      originalCommissionId: null,
      periodStartDate: ctx.SettlementPaymentDate || ctx.BillingPeriodStart || new Date(),
      periodEndDate: ctx.BillingPeriodEnd || ctx.SettlementPaymentDate || new Date(),
      ruleIds: sample.ruleIds || null,
      splitPartnerAgentId: null,
      splitPercentage: null,
      isPrimaryInSplit: null
    }, false, transaction);
    created.push({
      invoiceId: ctx.InvoiceId.toString(),
      paymentId: ctx.SettlementPaymentId ? ctx.SettlementPaymentId.toString() : null,
      entityType: row.entityType,
      entityId: row.entityId,
      amount: row.deltaAmount,
      commissionId: insertedId
    });
  }

  if (ctx.SettlementPaymentId && transaction) {
    try {
      await CommissionServiceAdvances.resolveAgentOverrides({
        paymentId: ctx.SettlementPaymentId,
        tenantId: ctx.TenantId,
        paymentDate: ctx.SettlementPaymentDate || ctx.BillingPeriodStart,
        householdId: ctx.GroupId ? null : ctx.HouseholdId,
        groupId: ctx.GroupId,
        commissionStatus,
        dryRun: false,
        transaction
      });
    } catch (ovErr) {
      logger.warn('Agent override re-application failed during invoice top-up', {
        invoiceId,
        error: ovErr.message
      });
    }
  }

  return { invoiceId, previewRows, created };
}

async function applyTopupForInvoices({ invoiceIds, dryRun = true } = {}) {
  const normalized = (invoiceIds || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (normalized.length === 0) {
    return { processed: 0, topupPreview: [], createdCommissions: [], created: 0 };
  }

  const topupPreview = [];
  const createdCommissions = [];
  let created = 0;
  let failedInvoiceId = null;

  const pool = await getPool();
  const transaction = dryRun ? null : new mssql.Transaction(pool);
  if (transaction) await transaction.begin();

  try {
    for (const invoiceId of normalized) {
      failedInvoiceId = invoiceId;
      const result = await applyTopupForInvoice(invoiceId, { dryRun, transaction });
      if (result.error && result.previewRows.length === 0) {
        topupPreview.push({
          invoiceId,
          _previewError: true,
          error: result.error
        });
        continue;
      }
      topupPreview.push(...result.previewRows);
      if (!dryRun && result.created?.length) {
        created += result.created.length;
        createdCommissions.push(...result.created);
      }
    }
    if (transaction) await transaction.commit();
  } catch (err) {
    if (transaction) {
      try { await transaction.rollback(); } catch (_) { /* noop */ }
    }
    err.failedInvoiceId = failedInvoiceId;
    throw err;
  }

  return {
    processed: normalized.length,
    topupPreview,
    createdCommissions,
    created
  };
}

module.exports = {
  listTopupEligibleInvoices,
  loadInvoiceTopupContext,
  computeTopupDeltasForInvoice,
  applyTopupForInvoices
};
