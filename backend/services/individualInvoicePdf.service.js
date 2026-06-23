'use strict';

const sql = require('mssql');
const { getPool } = require('../config/database');
const invoiceService = require('./invoiceService');
const { generateInvoicePdf, prepareTenantLogoBufferForPdf } = require('./invoicePdfService');
const { getUserRoles } = require('../middleware/auth');
const { tenantIdsMatch } = require('../utils/tenantIds');

/** Compare UUIDs from SQL (Buffer/string) safely */
function uuidStringsEqual(a, b) {
  if (a == null || b == null) return false;
  const norm = (x) => String(x).replace(/-/g, '').toLowerCase();
  return norm(a) === norm(b);
}

function wantsAllTenants(req) {
  const userRoles = getUserRoles(req.user);
  return userRoles.includes('SysAdmin') && (req.query.allTenants === 'true' || req.query.allTenants === '1');
}

function effectiveInvoiceTenantScopeId(req) {
  if (wantsAllTenants(req)) return null;
  const userRoles = getUserRoles(req.user);
  const q = req.query.tenantId;
  if (userRoles.includes('SysAdmin') && q) {
    return q;
  }
  return req.tenantId || req.user?.TenantId || null;
}

function isIndividualInvoiceRow(invoiceRow) {
  const type = String(invoiceRow.InvoiceType || '').trim().toLowerCase();
  if (type === 'group') return false;
  if (type === 'individual') return true;
  return !!(invoiceRow.HouseholdId && !invoiceRow.GroupId);
}

/**
 * Row-level invoice read access (aligned with payment receipt PDF scope).
 */
async function assertInvoiceReadAccess(req, pool, invoiceRow) {
  const currentRole = req.user?.currentRole;
  const invoiceTenantId = invoiceRow.TenantId;

  if (currentRole === 'SysAdmin') {
    return true;
  }

  const activeTenantId = req.tenantId || req.user?.TenantId;
  if (!invoiceTenantId || !activeTenantId || !tenantIdsMatch(invoiceTenantId, activeTenantId)) {
    return false;
  }

  if (currentRole === 'TenantAdmin' || currentRole === 'AgencyOwner') {
    return true;
  }

  if (currentRole === 'Member') {
    if (!isIndividualInvoiceRow(invoiceRow)) return false;
    const userId = req.user?.UserId || req.user?.userId;
    if (!userId) return false;
    const memberResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`SELECT HouseholdId FROM oe.Members WHERE UserId = @userId AND RelationshipType = N'P'`);
    const householdId = memberResult.recordset[0]?.HouseholdId;
    return !!(householdId && uuidStringsEqual(householdId, invoiceRow.HouseholdId));
  }

  if (currentRole === 'Agent') {
    const userId = req.user?.UserId || req.user?.userId;
    if (!userId) return false;
    const agentResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`SELECT AgentId FROM oe.Agents WHERE UserId = @userId AND Status = N'Active'`);
    const agentId = agentResult.recordset[0]?.AgentId;
    if (!agentId) return false;
    const chk = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceRow.InvoiceId)
      .input('agentId', sql.UniqueIdentifier, agentId)
      .query(`
        SELECT 1 AS ok FROM oe.Invoices i
        WHERE i.InvoiceId = @invoiceId
          AND (
            EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.HouseholdId = i.HouseholdId AND e.AgentId = @agentId)
            OR EXISTS (SELECT 1 FROM oe.Groups ag WHERE ag.GroupId = i.GroupId AND ag.AgentId = @agentId)
          )
      `);
    return chk.recordset.length > 0;
  }

  if (currentRole === 'GroupAdmin') {
    let userGroupId = req.user.GroupId || req.user.groupId;
    if (!userGroupId) {
      const gidRes = await pool.request()
        .input('userId', sql.UniqueIdentifier, req.user.UserId)
        .query(`
          SELECT TOP 1 GroupId FROM oe.GroupAdmins
          WHERE UserId = @userId AND Status = N'Active'
        `);
      userGroupId = gidRes.recordset[0]?.GroupId;
    }
    if (!userGroupId) return false;
    if (invoiceRow.GroupId && tenantIdsMatch(invoiceRow.GroupId, userGroupId)) {
      return true;
    }
    if (!invoiceRow.HouseholdId) return false;
    const mRes = await pool.request()
      .input('householdId', sql.UniqueIdentifier, invoiceRow.HouseholdId)
      .input('userGroupId', sql.UniqueIdentifier, userGroupId)
      .query(`
        SELECT 1 AS Ok FROM oe.Members m
        WHERE m.HouseholdId = @householdId AND m.GroupId = @userGroupId
      `);
    return !!(mRes.recordset && mRes.recordset.length > 0);
  }

  return false;
}

const INVOICE_PDF_SELECT = `
  SELECT
    i.*,
    u.FirstName AS BillToFirstName,
    u.LastName AS BillToLastName,
    pm.Address AS BillToAddress,
    pm.City AS BillToCity,
    pm.State AS BillToState,
    pm.Zip AS BillToZip,
    t.Name AS TenantName,
    t.PrimaryAddress AS TenantAddress,
    t.PrimaryCity AS TenantCity,
    t.PrimaryState AS TenantState,
    t.PrimaryZip AS TenantZip,
    COALESCE(
      NULLIF(LTRIM(RTRIM(ISNULL(t.CustomLogoUrl, ''))), ''),
      NULLIF(LTRIM(RTRIM(ISNULL(json_value(t.AdvancedSettings, '$.branding.logoUrl'), ''))), '')
    ) AS TenantLogoUrl
  FROM oe.Invoices i
  INNER JOIN oe.Tenants t ON i.TenantId = t.TenantId
  LEFT JOIN oe.Members pm ON i.HouseholdId = pm.HouseholdId AND pm.RelationshipType = N'P'
  LEFT JOIN oe.Users u ON pm.UserId = u.UserId
  WHERE i.InvoiceId = @invoiceId
`;

async function loadIndividualInvoicePdfRow(pool, invoiceId, tenantScopeId) {
  const request = pool.request();
  request.input('invoiceId', sql.UniqueIdentifier, invoiceId);
  let tenantFilter = '';
  if (tenantScopeId) {
    tenantFilter = ' AND i.TenantId = @tenantId';
    request.input('tenantId', sql.UniqueIdentifier, tenantScopeId);
  }
  const invResult = await request.query(`${INVOICE_PDF_SELECT}${tenantFilter}`);
  return invResult.recordset[0] || null;
}

async function loadMemberHouseholdForPdf(pool, memberId, req) {
  const request = pool.request();
  request.input('memberId', sql.UniqueIdentifier, memberId);
  const currentRole = req.user?.currentRole;
  let query = `
    SELECT m.MemberId, m.HouseholdId, m.GroupId, u.TenantId
    FROM oe.Members m
    INNER JOIN oe.Users u ON m.UserId = u.UserId
    WHERE m.MemberId = @memberId
  `;

  if (currentRole !== 'SysAdmin') {
    const scopeId = req.tenantId || req.user?.TenantId;
    if (!scopeId) return null;
    query += ' AND u.TenantId = @tenantId';
    request.input('tenantId', sql.UniqueIdentifier, scopeId);
  }

  if (currentRole === 'GroupAdmin') {
    let userGroupId = req.user.GroupId || req.user.groupId;
    if (!userGroupId) {
      const gidRes = await pool.request()
        .input('userId', sql.UniqueIdentifier, req.user.UserId)
        .query(`
          SELECT TOP 1 GroupId FROM oe.GroupAdmins
          WHERE UserId = @userId AND Status = N'Active'
        `);
      userGroupId = gidRes.recordset[0]?.GroupId;
    }
    if (!userGroupId) return null;
    query += ' AND m.GroupId = @userGroupId';
    request.input('userGroupId', sql.UniqueIdentifier, userGroupId);
  }

  if (currentRole === 'Agent') {
    const userId = req.user?.UserId || req.user?.userId;
    if (!userId) return null;
    const agentResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`SELECT AgentId FROM oe.Agents WHERE UserId = @userId AND Status = N'Active'`);
    const agentId = agentResult.recordset[0]?.AgentId;
    if (!agentId) return null;
    query += `
      AND EXISTS (
        SELECT 1 FROM oe.Enrollments e
        WHERE e.HouseholdId = m.HouseholdId AND e.AgentId = @agentId
      )
    `;
    request.input('agentId', sql.UniqueIdentifier, agentId);
  }

  const result = await request.query(query);
  return result.recordset[0] || null;
}

async function streamIndividualInvoicePdf(res, pool, invoiceRow, req) {
  if (!isIndividualInvoiceRow(invoiceRow)) {
    return { ok: false, status: 404, message: 'Resource not found or access denied' };
  }

  const allowed = await assertInvoiceReadAccess(req, pool, invoiceRow);
  if (!allowed) {
    return { ok: false, status: 404, message: 'Resource not found or access denied' };
  }

  const billingDate = new Date(invoiceRow.InvoiceDate || invoiceRow.CreatedDate);
  const dueDate = new Date(invoiceRow.DueDate);
  const billingPeriodStart = new Date(invoiceRow.BillingPeriodStart);
  const billingPeriodEnd = new Date(invoiceRow.BillingPeriodEnd);

  const billToName = [invoiceRow.BillToFirstName, invoiceRow.BillToLastName].filter(Boolean).join(' ') || 'Member';
  const billTo = {
    name: billToName,
    addressLine1: invoiceRow.BillToAddress || '',
    cityStateZip: [invoiceRow.BillToCity, invoiceRow.BillToState, invoiceRow.BillToZip].filter(Boolean).join(', ')
  };

  const { lines: pdfSimpleLines } = await invoiceService.getIndividualInvoicePdfLineItems(
    pool,
    invoiceRow.HouseholdId,
    billingPeriodStart,
    billingPeriodEnd
  );

  const tenantLogoBuffer = await prepareTenantLogoBufferForPdf(invoiceRow.TenantLogoUrl);

  const doc = generateInvoicePdf({
    invoice: invoiceRow,
    locationResults: [],
    billTo,
    tenant: {
      Name: invoiceRow.TenantName,
      PrimaryAddress: invoiceRow.TenantAddress,
      PrimaryCity: invoiceRow.TenantCity,
      PrimaryState: invoiceRow.TenantState,
      PrimaryZip: invoiceRow.TenantZip
    },
    billingDate,
    dueDate,
    billingPeriodStart,
    billingPeriodEnd,
    title: 'INVOICE',
    invoiceNumber: invoiceRow.InvoiceNumber,
    isSample: false,
    simpleLineItems: pdfSimpleLines.length > 0 ? pdfSimpleLines : undefined,
    tenantLogoBuffer
  });

  const invoiceId = invoiceRow.InvoiceId;
  const filename = `invoice-${invoiceRow.InvoiceNumber || invoiceId}.pdf`;
  const attachment = req.query.download === '1' || req.query.download === 'true';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `${attachment ? 'attachment' : 'inline'}; filename="${filename.replace(/"/g, '')}"`
  );

  doc.pipe(res);
  doc.end();
  return { ok: true };
}

async function handleIndividualInvoicePdfRequest(req, res, invoiceId) {
  const pool = await getPool();
  if (!wantsAllTenants(req)) {
    const scopeId = effectiveInvoiceTenantScopeId(req);
    if (!scopeId) {
      return res.status(400).json({ success: false, message: 'Tenant context required' });
    }
  }

  const tenantScopeId = effectiveInvoiceTenantScopeId(req);
  const invoiceRow = await loadIndividualInvoicePdfRow(pool, invoiceId, tenantScopeId);
  if (!invoiceRow) {
    return res.status(404).json({ success: false, message: 'Resource not found or access denied' });
  }

  const result = await streamIndividualInvoicePdf(res, pool, invoiceRow, req);
  if (!result.ok) {
    return res.status(result.status).json({ success: false, message: result.message });
  }
}

async function handleMemberScopedIndividualInvoicePdfRequest(req, res, memberId, invoiceId) {
  const pool = await getPool();
  const memberRow = await loadMemberHouseholdForPdf(pool, memberId, req);
  if (!memberRow || !memberRow.HouseholdId) {
    return res.status(404).json({ success: false, message: 'Resource not found or access denied' });
  }

  const invoiceRow = await loadIndividualInvoicePdfRow(pool, invoiceId, null);
  if (!invoiceRow || !uuidStringsEqual(invoiceRow.HouseholdId, memberRow.HouseholdId)) {
    return res.status(404).json({ success: false, message: 'Resource not found or access denied' });
  }

  const result = await streamIndividualInvoicePdf(res, pool, invoiceRow, req);
  if (!result.ok) {
    return res.status(result.status).json({ success: false, message: result.message });
  }
}

module.exports = {
  uuidStringsEqual,
  wantsAllTenants,
  effectiveInvoiceTenantScopeId,
  isIndividualInvoiceRow,
  assertInvoiceReadAccess,
  loadIndividualInvoicePdfRow,
  streamIndividualInvoicePdf,
  handleIndividualInvoicePdfRequest,
  handleMemberScopedIndividualInvoicePdfRequest
};
