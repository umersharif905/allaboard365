'use strict';

/**
 * Applies DIME recurring_payment success webhooks via the same payment + invoice writers
 * as member flows (PaymentDatabaseService + invoiceService.fulfillInvoice).
 * Group schedules use the legacy oe.Payments shape (matches oe_payment_manager group INSERT).
 */

const { getPool, sql } = require('../config/database');
const PaymentDatabaseService = require('./paymentDatabaseService');
const invoiceService = require('./invoiceService');
const { requireShared } = require('../config/shared-modules');

const {
  normalizeInboundRecurringWebhookBody,
  normalizeDimeRecurringProcessorTransactionId,
  shouldTreatRecurringSuccessWebhookAsDeclined,
  mapRecurringSuccessWebhookToDbStatus,
  isSuccessfulPaymentRecordStatus
} = requireShared('payment-status');

/** @typedef {Record<string, unknown>} DimePayload */

function parseAmountFromWebhook(data) {
  const a =
    data &&
    typeof data === 'object' &&
    /** @type {Record<string, unknown>} */ (
      ('amount' in data ? /** @type {unknown} */ (data.amount) : null)
    );
  const n =
    typeof a === 'number' && Number.isFinite(a)
      ? a
      : parseFloat(String(a != null ? a : '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parsePaymentDateUtc(data) {
  if (!data || typeof data !== 'object') return new Date();
  const d =
    /** @type {Record<string, unknown>} */ (data).transaction_date ??
    /** @type {Record<string, unknown>} */ (data).transactionDate ??
    /** @type {Record<string, unknown>} */ (data).settle_date ??
    /** @type {Record<string, unknown>} */ (data).fund_date ??
    null;
  if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
  const s = d != null ? String(d).trim() : '';
  if (s) {
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function extractScheduleString(data) {
  if (!data || typeof data !== 'object') return '';
  const o = /** @type {Record<string, unknown>} */ (data);
  const v =
    o.schedule_id ??
    o.scheduleId ??
    o.recurring_payment_id ??
    o.recurringPaymentId ??
    o.payment_schedule_id ??
    o.paymentScheduleId ??
    '';
  return String(v != null ? v : '').trim();
}

function roundMoney2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

/**
 * Portal / DIME payloads often mirror schedule display name: "Full Name (SW123)"
 * @returns {string|null}
 */
function extractHouseholdMemberIdFromRecurringDescription(dimePayload) {
  if (!dimePayload || typeof dimePayload !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (dimePayload);
  const raw = o.description ?? o.memo ?? o.name ?? '';
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  const re = /\(([A-Za-z0-9]+)\)/g;
  let m;
  /** @type {string|null} */
  let last = null;
  while ((m = re.exec(s)) !== null) {
    last = m[1];
  }
  return last != null && String(last).trim() !== '' ? String(last).trim().toUpperCase() : null;
}

function normalizeHouseholdMemberIdForCompare(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

/** @param {number} webhookRounded Math.round(amnt*100)/100 */
function webhookAmountMatchesIrsMonthly(webhookRounded, storedMonthlyRounded) {
  const tol = 0.02;
  const procFee = 3.5;
  const w = webhookRounded;
  const s = storedMonthlyRounded;
  if (Math.abs(w - s) <= tol) return true;
  if (Math.abs(w - s - procFee) <= tol) return true;
  return false;
}

/**
 * @typedef {{ Sid?: string|null; HouseholdId?: unknown; MonthlyAmount?: unknown; ModifiedDate?: Date|string|null; PrimaryHouseholdMemberId?: string|null }} CustomerUuidCandidateRow
 */

/**
 * After SQL rows ordered by ModifiedDate DESC: keep latest row per DimeScheduleId.
 * @param {CustomerUuidCandidateRow[]} rows
 */
function dedupeCandidateRowsByScheduleIdNewest(rows) {
  /** @type {Map<string, CustomerUuidCandidateRow>} */
  const map = new Map();
  for (const row of rows) {
    const sid = String(row.Sid != null ? row.Sid : '').trim();
    if (!sid) continue;
    const prev = map.get(sid);
    const tCurr = row.ModifiedDate ? new Date(row.ModifiedDate).getTime() : 0;
    const tPrev = prev && prev.ModifiedDate ? new Date(prev.ModifiedDate).getTime() : -1;
    if (!prev || tCurr >= tPrev) map.set(sid, row);
  }
  return Array.from(map.values());
}

/**
 * Pure selection used when schedule_id omitted and customer_uuid matches >=1 IRS row(s).
 *
 * @param {CustomerUuidCandidateRow[]} dedupedRows
 * @param {DimePayload} dimePayload
 * @param {number|null} webhookAmount from parseAmountFromWebhook (already validated >0 upstream)
 * @param {{ disableAmountDisambig?: boolean }} [opts]
 * @returns {{ scheduleId: string; meta: Record<string, unknown> }}
 */
function pickDimeScheduleIdFromCustomerUuidCandidates(dedupedRows, dimePayload, webhookAmount, opts = {}) {
  const candidates = dedupedRows || [];
  const metaBase = {
    candidateCount: candidates.length,
    disambiguation: 'none',
    customerUuidPresent: true,
    ambiguous: false
  };

  if (candidates.length === 0) {
    return { scheduleId: '', meta: { ...metaBase, disambiguation: 'no_matching_schedules', customerUuidPresent: true } };
  }

  if (candidates.length === 1) {
    return {
      scheduleId: String(candidates[0].Sid ?? '').trim(),
      meta: { ...metaBase, disambiguation: 'customer_uuid_single' }
    };
  }

  const hmidGuess = extractHouseholdMemberIdFromRecurringDescription(dimePayload);

  if (hmidGuess) {
    const byDesc = candidates.filter(
      (c) => normalizeHouseholdMemberIdForCompare(c.PrimaryHouseholdMemberId) === hmidGuess
    );
    if (byDesc.length === 1) {
      return {
        scheduleId: String(byDesc[0].Sid ?? '').trim(),
        meta: {
          ...metaBase,
          disambiguation: 'description_member_id',
          householdMemberMatched: hmidGuess
        }
      };
    }
  }

  const disableAmount = opts.disableAmountDisambig === true;
  if (!disableAmount && webhookAmount != null && Number.isFinite(webhookAmount) && webhookAmount > 0) {
    const wRounded = roundMoney2(webhookAmount);
    const byAmt = candidates.filter((c) => {
      const sRounded = roundMoney2(c.MonthlyAmount);
      return webhookAmountMatchesIrsMonthly(wRounded, sRounded);
    });
    if (byAmt.length === 1) {
      return {
        scheduleId: String(byAmt[0].Sid ?? '').trim(),
        meta: { ...metaBase, disambiguation: 'monthly_amount' }
      };
    }
  }

  return {
    scheduleId: '',
    meta: {
      ...metaBase,
      disambiguation: 'ambiguous_multiple_schedules',
      ambiguous: true,
      descriptionParsedMemberId: hmidGuess ?? null,
      disableAmountDisambigApplied: !!opts.disableAmountDisambig
    }
  };
}

/**
 * DIME payloads sometimes omit schedule_id — resolve active individual DIME schedule by customer_uuid.
 * When multiple households share ProcessorCustomerId, disambiguates via description (member id) then amount (+fee tolerance).
 * @returns {Promise<{ scheduleId: string; meta: Record<string, unknown> }>}
 */
async function resolveScheduleIdViaCustomerUuid(pool, dimePayload, webhookAmount) {
  const emptyMeta = {
    candidateCount: 0,
    disambiguation: 'none',
    customerUuidPresent: false,
    ambiguous: false
  };
  if (!dimePayload || typeof dimePayload !== 'object') {
    return { scheduleId: '', meta: { ...emptyMeta, disambiguation: 'missing_payload' } };
  }

  const o = /** @type {Record<string, unknown>} */ (dimePayload);
  const uuidRaw = o.customer_uuid ?? o.customerUuid;
  const uuid = uuidRaw != null ? String(uuidRaw).trim() : '';
  if (!uuid) {
    return { scheduleId: '', meta: { ...emptyMeta, disambiguation: 'no_customer_uuid', customerUuidPresent: false } };
  }

  const disableAmountDisambig =
    process.env.RECURRING_WEBHOOK_DISABLE_AMOUNT_DISAMBIG === '1' ||
    String(process.env.RECURRING_WEBHOOK_DISABLE_AMOUNT_DISAMBIG || '').toLowerCase() === 'true';

  try {
    const r = await pool
      .request()
      .input('cu', sql.NVarChar(255), uuid)
      .query(`
        SELECT
          LTRIM(RTRIM(CAST(irs.DimeScheduleId AS NVARCHAR(255)))) AS Sid,
          irs.HouseholdId,
          irs.MonthlyAmount,
          irs.ModifiedDate,
          LTRIM(RTRIM(ISNULL(pm.PrimaryHouseholdMemberId, N''))) AS PrimaryHouseholdMemberId
        FROM oe.MemberPaymentMethods AS mpm
        INNER JOIN oe.Members AS m ON m.MemberId = mpm.MemberId
        INNER JOIN oe.IndividualRecurringSchedules AS irs
          ON irs.HouseholdId = m.HouseholdId AND irs.IsActive = 1
        OUTER APPLY (
          SELECT TOP 1 LTRIM(RTRIM(ISNULL(pm2.HouseholdMemberID, N''))) AS PrimaryHouseholdMemberId
          FROM oe.Members pm2
          WHERE pm2.HouseholdId = irs.HouseholdId AND pm2.RelationshipType = N'P'
        ) AS pm
        WHERE LTRIM(RTRIM(ISNULL(mpm.ProcessorCustomerId, N''))) = LTRIM(RTRIM(@cu))
        ORDER BY irs.ModifiedDate DESC
      `);

    /** @type {CustomerUuidCandidateRow[]} */
    const rows = Array.isArray(r.recordset) ? r.recordset : [];
    const deduped = dedupeCandidateRowsByScheduleIdNewest(rows);
    const picked = pickDimeScheduleIdFromCustomerUuidCandidates(
      deduped,
      dimePayload,
      webhookAmount,
      { disableAmountDisambig }
    );

    picked.meta.customerUuidPresent = true;
    picked.meta.candidateCountPreDedupe = rows.length;

    return { scheduleId: picked.scheduleId, meta: picked.meta };
  } catch (err) {
    console.warn('[recurringPaymentWebhookApply] resolveScheduleIdViaCustomerUuid:', err.message);
    return {
      scheduleId: '',
      meta: { ...emptyMeta, customerUuidPresent: true, disambiguation: 'query_failed', queryError: err.message }
    };
  }
}

/**
 * Recurring webhooks omit card/bank hints; derive from household primary payment method when possible.
 */
async function resolveIndividualPaymentRailForRecurringWebhook(pool, householdId) {
  try {
    const r = await pool
      .request()
      .input('hid', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT TOP 1 UPPER(LTRIM(RTRIM(ISNULL(mpm.PaymentMethodType, N'')))) AS Ty
        FROM oe.MemberPaymentMethods mpm
        INNER JOIN oe.Members m ON m.MemberId = mpm.MemberId
        WHERE m.HouseholdId = @hid AND m.RelationshipType = N'P'
          AND mpm.Status = N'Active'
        ORDER BY mpm.IsDefault DESC, mpm.ModifiedDate DESC
      `);
    const ty = String(r.recordset?.[0]?.Ty ?? '').toUpperCase();
    if (ty === 'ACH') return 'ACH';
    if (ty === 'CREDITCARD' || ty === 'CARD') return 'CreditCard';
  } catch (e) {
    console.warn('[recurringPaymentWebhookApply] resolveIndividualPaymentRailForRecurringWebhook:', e.message);
  }
  return 'Recurring';
}

/** Group recurring: default active group payment method type when available */
async function resolveGroupPaymentRailForRecurringWebhook(pool, groupId) {
  try {
    const r = await pool
      .request()
      .input('gid', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT TOP 1 UPPER(LTRIM(RTRIM(ISNULL(Type, N'')))) AS Ty
        FROM oe.GroupPaymentMethods
        WHERE GroupId = @gid AND Status = N'Active'
        ORDER BY CASE WHEN IsDefault = 1 THEN 0 ELSE 1 END, ModifiedDate DESC
      `);
    const ty = String(r.recordset?.[0]?.Ty ?? '').toUpperCase();
    if (ty === 'ACH') return 'ACH';
    if (ty === 'CREDITCARD' || ty === 'CARD') return 'CreditCard';
  } catch (e) {
    console.warn('[recurringPaymentWebhookApply] resolveGroupPaymentRailForRecurringWebhook:', e.message);
  }
  return 'Recurring';
}

async function augmentPaymentWebhookColumns(pool, paymentId, extras) {
  const { webhookEventId, recurringScheduleId, processorTxnInfoId } = extras;
  let q = `
    UPDATE oe.Payments
    SET Processor = COALESCE(Processor, N'DIME'),
        TransactionType = COALESCE(TransactionType, N'Payment'),
        ModifiedDate = GETUTCDATE()
        `;

  /** @type {import('mssql').Request | null} */
  let rq = pool.request().input('paymentId', sql.UniqueIdentifier, paymentId);

  const wid = webhookEventId != null ? Number(webhookEventId) : null;
  if (wid !== null && Number.isFinite(wid) && wid >= 1) {
    q += `,
        WebhookEventId = @webhookEventId`;
    rq = rq.input('webhookEventId', sql.Int, wid);
  }
  if (
    recurringScheduleId != null &&
    String(recurringScheduleId).trim() !== ''
  ) {
    q += `,
        RecurringScheduleId = @recurringScheduleId`;
    rq = rq.input('recurringScheduleId', sql.NVarChar(255), String(recurringScheduleId).trim());
  }
  if (processorTxnInfoId != null && String(processorTxnInfoId).trim() !== '') {
    q += `,
        ProcessorTransactionInfoId = @processorTxnInfoId`;
    rq = rq.input('processorTxnInfoId', sql.NVarChar(255), String(processorTxnInfoId).trim());
  }
  q += `\nWHERE PaymentId = @paymentId`;

  await rq.query(q);
}

/**
 * @param {{
 *   dimePayload?: DimePayload;
 *   data?: DimePayload;
 *   webhookEventId?: number|null;
 *   webhookEventIds?: unknown;
 *   rawBody?: Record<string, unknown>;
 * }} body
 */
async function applyRecurringPaymentSuccessFromWebhook(body) {
  /** @type {DimePayload | null | undefined} */
  let dimePayload =
    body?.dimePayload && typeof body.dimePayload === 'object'
      ? /** @type {DimePayload} */ (body.dimePayload)
      : body?.data && typeof body.data === 'object'
        ? /** @type {DimePayload} */ (body.data)
        : null;

  if ((!dimePayload || Object.keys(dimePayload).length === 0) && body?.rawBody) {
    const n = normalizeInboundRecurringWebhookBody(body.rawBody);
    dimePayload = n.data;
  }

  if (!dimePayload || typeof dimePayload !== 'object') {
    return {
      success: false,
      retryable: false,
      skipped: true,
      code: 'BAD_PAYLOAD',
      message: 'Missing DIME recurring payload'
    };
  }

  if (shouldTreatRecurringSuccessWebhookAsDeclined(dimePayload)) {
    return {
      success: false,
      retryable: false,
      skipped: true,
      code: 'NOT_APPROVED',
      message: 'Recurring payload indicates decline despite success event wrapper'
    };
  }

  const processorTxnId = normalizeDimeRecurringProcessorTransactionId(dimePayload);
  if (!processorTxnId) {
    return {
      success: false,
      retryable: true,
      code: 'MISSING_TRANSACTION_ID',
      message: 'Processor transaction id not found on payload (transaction_id / transaction_number)'
    };
  }

  const amount = parseAmountFromWebhook(dimePayload);
  if (amount == null) {
    return {
      success: false,
      retryable: false,
      skipped: true,
      code: 'BAD_AMOUNT',
      message: 'Invalid or missing amount on recurring webhook'
    };
  }

  const dbStatus = mapRecurringSuccessWebhookToDbStatus(dimePayload);

  const pool = await getPool();

  const webhookEventId =
    body.webhookEventId != null && body.webhookEventId !== ''
      ? Number(body.webhookEventId)
      : body.webhookEventIds != null && body.webhookEventIds !== ''
        ? Number(body.webhookEventIds)
        : null;

  let scheduleIdStr = extractScheduleString(dimePayload);
  /** @type {Record<string, unknown>} */
  let scheduleResolutionMeta;

  if (scheduleIdStr) {
    scheduleResolutionMeta = {
      payloadHadScheduleId: true,
      disambiguation: 'payload_schedule_id',
      candidateCount: null,
      customerUuidPresent: !!(
        /** @type {Record<string, unknown>} */ (dimePayload).customer_uuid ??
        /** @type {Record<string, unknown>} */ (dimePayload).customerUuid
      ),
      ambiguous: false
    };
  } else {
    const custRes = await resolveScheduleIdViaCustomerUuid(pool, dimePayload, amount);
    scheduleIdStr = custRes.scheduleId || '';
    scheduleResolutionMeta = {
      payloadHadScheduleId: false,
      ...(custRes.meta || {})
    };
  }

  try {
    console.log(
      '[recurring-apply] recurring_payment_schedule_resolution ' +
        JSON.stringify({
          webhookEventId: webhookEventId && Number.isFinite(webhookEventId) ? webhookEventId : null,
          processorTxnId,
          webhookAmount: amount,
          resolvedScheduleId: scheduleIdStr || null,
          ...scheduleResolutionMeta
        })
    );
  } catch (_logErr) {
    /* never block apply on structured log */
  }

  if (!scheduleIdStr) {
    const ambiguous =
      scheduleResolutionMeta &&
      !!(
        scheduleResolutionMeta.ambiguous === true ||
        scheduleResolutionMeta.disambiguation === 'ambiguous_multiple_schedules'
      );
    return {
      success: false,
      retryable: true,
      code: 'MISSING_SCHEDULE',
      message: ambiguous
        ? 'schedule_id not on webhook: multiple active recurring schedules matched customer_uuid and could not be disambiguated (description/Member Number and MonthlyAmount checks). Correct duplicate account / DIME customer links or ask ops to reconcile.'
        : 'schedule_id / recurring_payment_id not found on webhook and could not resolve from customer_uuid'
    };
  }

  const existing = await pool
    .request()
    .input('processorTxnId', sql.NVarChar(255), processorTxnId)
    .query(`
      SELECT TOP 1
        PaymentId,
        InvoiceId,
        Status,
        HouseholdId,
        GroupId,
        TenantId
      FROM oe.Payments
      WHERE LTRIM(RTRIM(ISNULL(ProcessorTransactionId, N''))) = LTRIM(RTRIM(@processorTxnId))
        AND (
          TransactionType IS NULL OR TransactionType = N'Payment' OR TransactionType = N''
        )
      ORDER BY CreatedDate DESC
    `);

  if (existing.recordset?.length) {
    const row = existing.recordset[0];
    return {
      success: true,
      alreadyProcessed: true,
      paymentId: String(row.PaymentId),
      invoiceId: row.InvoiceId ? String(row.InvoiceId) : null,
      tenantId: row.TenantId ? String(row.TenantId) : null,
      householdId: row.HouseholdId ? String(row.HouseholdId) : null,
      groupId: row.GroupId ? String(row.GroupId) : null
    };
  }

  const groupResult = await pool
    .request()
    .input('scheduleId', sql.NVarChar(255), scheduleIdStr)
    .query(`
      SELECT g.GroupId, g.TenantId
      FROM oe.GroupRecurringPaymentPlans grp
      INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
      WHERE LTRIM(RTRIM(CAST(grp.DimeScheduleId AS NVARCHAR(255)))) = LTRIM(RTRIM(@scheduleId))
    `);

  const paymentDate = parsePaymentDateUtc(dimePayload);

  const txnInfoRaw =
    /** @type {Record<string, unknown>} */ (dimePayload).transaction_info_id ??
    /** @type {Record<string, unknown>} */ (dimePayload).transactionInfoId;
  const processorTxnInfoId = txnInfoRaw != null ? String(txnInfoRaw) : '';

  if (groupResult.recordset?.length) {
    const groupData = groupResult.recordset[0];
    const groupId = groupData.GroupId;
    const tenantId = groupData.TenantId;

    const paymentRail = await resolveGroupPaymentRailForRecurringWebhook(pool, groupId);

    const paymentId = require('crypto').randomUUID();

    await pool
      .request()
      .input('paymentId', sql.UniqueIdentifier, paymentId)
      .input('transactionType', sql.NVarChar(50), 'Payment')
      .input('amount', sql.Decimal(10, 2), amount)
      .input('status', sql.NVarChar(50), dbStatus)
      .input('processor', sql.NVarChar(50), 'DIME')
      .input('processorTransactionId', sql.NVarChar(255), processorTxnId)
      .input('paymentMethod', sql.NVarChar(50), paymentRail)
      .input('webhookEventId', sql.Int, webhookEventId && Number.isFinite(webhookEventId) ? webhookEventId : null)
      .input('paymentDate', sql.DateTime2, paymentDate)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        INSERT INTO oe.Payments (
          PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor,
          ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate, GroupId, TenantId,
          CreatedDate, ModifiedDate
        )
        VALUES (
          @paymentId, NULL, NULL, @transactionType, @amount, @status, @processor,
          @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate, @groupId, @tenantId,
          GETUTCDATE(), GETUTCDATE()
        )
      `);

    await augmentPaymentWebhookColumns(pool, paymentId, {
      webhookEventId: webhookEventId && Number.isFinite(webhookEventId) ? webhookEventId : null,
      recurringScheduleId: scheduleIdStr,
      processorTxnInfoId
    });

    return {
      success: true,
      alreadyProcessed: false,
      scope: 'group',
      paymentId,
      tenantId: String(tenantId),
      groupId: String(groupId),
      amount,
      invoiceSync: {
        applied: false,
        reason: 'group_recurring_invoice_not_linked_in_webhook'
      }
    };
  }

  const indivResult = await pool
    .request()
    .input('scheduleId', sql.NVarChar(255), scheduleIdStr)
    .query(`
      SELECT TOP 1 HouseholdId, TenantId
      FROM oe.IndividualRecurringSchedules
      WHERE IsActive = 1
        AND LTRIM(RTRIM(CAST(DimeScheduleId AS NVARCHAR(255)))) = LTRIM(RTRIM(@scheduleId))
      ORDER BY ModifiedDate DESC
    `);

  if (!indivResult.recordset?.length) {
    return {
      success: false,
      retryable: true,
      code: 'SCHEDULE_NOT_FOUND',
      message: `No group or individual payment schedule found for DIME schedule ${scheduleIdStr}`
    };
  }

  const { HouseholdId: householdId, TenantId: tenantId } = indivResult.recordset[0];

  const paymentRailForStore = await resolveIndividualPaymentRailForRecurringWebhook(
    pool,
    householdId
  );

  let invResult;
  try {
    invResult = await invoiceService.getOrCreateInvoiceForPayment(
      householdId,
      tenantId,
      paymentDate
    );
  } catch (invErr) {
    console.error('[recurringPaymentWebhookApply] getOrCreateInvoiceForPayment:', invErr);
    return {
      success: false,
      retryable: true,
      code: 'INVOICE_RESOLVE_FAILED',
      message: invErr?.message || String(invErr)
    };
  }

  const invoiceId = invResult?.invoiceId || null;

  let agentIdRow = await pool.request()
    .input('hid', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1 m.AgentId
      FROM oe.Members m
      WHERE m.HouseholdId = @hid AND m.RelationshipType = N'P'
    `);

  const agentId = agentIdRow.recordset?.[0]?.AgentId || null;

  const processorResponseSafe = JSON.stringify(dimePayload);

  const stored = await PaymentDatabaseService.storePaymentRecord(
    {
      enrollmentId: null,
      householdId,
      tenantId,
      agentId,
      amount,
      status: dbStatus,
      paymentMethod: paymentRailForStore,
      processorTransactionId: processorTxnId,
      processorTransactionInfoId: processorTxnInfoId || null,
      processorResponse: processorResponseSafe,
      paymentDate,
      invoiceId
    },
    null
  );

  const pid = stored.PaymentId;

  await augmentPaymentWebhookColumns(pool, pid, {
    webhookEventId: webhookEventId && Number.isFinite(webhookEventId) ? webhookEventId : null,
    recurringScheduleId: scheduleIdStr,
    processorTxnInfoId
  });

  let fulfill = { applied: false };
  if (invoiceId && isSuccessfulPaymentRecordStatus(dbStatus)) {
    try {
      fulfill = await invoiceService.fulfillInvoice(invoiceId, amount);
    } catch (fu) {
      console.error('[recurringPaymentWebhookApply] fulfillInvoice:', fu);
      fulfill = { applied: false, reason: fu?.message };
    }
  }

  return {
    success: true,
    alreadyProcessed: false,
    scope: 'individual',
    paymentId: pid,
    householdId: String(householdId),
    tenantId: String(tenantId),
    invoiceId: invoiceId ? String(invoiceId) : null,
    amount,
    fulfillment: fulfill,
    invoiceCreated: !!(invResult && invResult.created)
  };
}

module.exports = {
  applyRecurringPaymentSuccessFromWebhook,
  extractHouseholdMemberIdFromRecurringDescription,
  pickDimeScheduleIdFromCustomerUuidCandidates
};
