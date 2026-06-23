#!/usr/bin/env node
'use strict';

/**
 * Replays stored oe.PaymentWebhookEvents rows through
 * POST /api/internal/recurring-payment-success/apply (same ledger path as oe_payment_manager).
 *
 * RECOMMENDED: PROCESSOR_TXN_IDS — finds the latest matching oe.PaymentWebhookEvents row per txn.
 *
 * Alternative: WEBHOOK_EVENT_IDS=comma,separated integers
 *
 * Dry run — resolve WebhookEventIds only, no HTTP POST:
 *   DRY_RUN=1 PROCESSOR_TXN_IDS=371,355,356,313 node backend/scripts/replay-recurring-success-webhooks.js
 *
 * Run for real (wrapper loads env file):
 *   cp backend/scripts/recurring-success-replay.template backend/scripts/recurring-success-replay.env
 *   # fill BACKEND_INTERNAL_BASE_URL + INTERNAL_API_TOKEN in ...env
 *   ./backend/scripts/run-recurring-success-replay.sh
 *
 * Same without wrapper (HTTP):
 *   PROCESSOR_TXN_IDS=371,355,356,313 \
 *   BACKEND_INTERNAL_BASE_URL=https://<your-api-host> \
 *   INTERNAL_API_TOKEN=<token> \
 *   node backend/scripts/replay-recurring-success-webhooks.js
 *
 * Direct DB writes (same service as HTTP route — uses backend/.env SQL only; omit INTERNAL_*):
 *   RECURRING_REPLAY_DIRECT_DB=1 PROCESSOR_TXN_IDS=371,355,356,313 \\
 *     node backend/scripts/replay-recurring-success-webhooks.js
 */

const axios = require('axios');
const { getPool, sql, closePool } = require('../config/database');

/** @returns {number[]} */
function parseWebhookEventIds(raw) {
  return (raw || '')
    .split(/[\s,]+/)
    .map((s) => parseInt(String(s).trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 1);
}

/** @returns {string[]} */
function parseProcessorTxnIds(raw) {
  return (raw || '')
    .split(/[\s,]+/)
    .map((s) => String(s).trim())
    .filter((s) => /^\d+$/.test(s));
}

/**
 * Latest recurring-success webhook matching this DIME correlation id on TransactionId or JSON payload.
 * @param {import('mssql').ConnectionPool} pool
 */
async function lookupWebhookByProcessorTxn(pool, txnClean) {
  const r = await pool
    .request()
    .input('txn', sql.NVarChar(64), txnClean)
    .query(`
      SELECT TOP (1)
        WebhookEventId,
        EventType,
        TransactionId AS WhTxn,
        CreatedDate,
        Payload
      FROM oe.PaymentWebhookEvents
      WHERE (
          LTRIM(RTRIM(ISNULL(TransactionId, N''))) = @txn
          OR CHARINDEX(N'"transaction_number":"' + @txn + N'"', Payload) > 0
          OR CHARINDEX(N'"transaction_number": "' + @txn + N'"', Payload) > 0
          OR CHARINDEX(N'"transaction_id":"' + @txn + N'"', Payload) > 0
        )
        AND (
          LOWER(ISNULL(EventType, N'')) LIKE N'%recurring%'
          AND (
            LOWER(ISNULL(EventType, N'')) LIKE N'%success%'
            OR EventType LIKE N'recurring_payment.success'
          )
        )
      ORDER BY CreatedDate DESC
    `);

  const row = r.recordset?.[0];
  if (!row) return null;
  return {
    webhookEventId: Number(row.WebhookEventId),
    processorTxn: txnClean,
    eventType: row.EventType || null,
    createdDate: row.CreatedDate ? new Date(row.CreatedDate) : null,
    whTxn: row.WhTxn != null ? String(row.WhTxn) : null
  };
}

/**
 * @param {import('mssql').ConnectionPool} pool
 */
async function fetchWebhookRow(pool, webhookEventId) {
  const r = await pool
    .request()
    .input('wid', sql.Int, webhookEventId)
    .query(`
      SELECT WebhookEventId, EventType, Payload, TransactionId AS WhTxn, CreatedDate
      FROM oe.PaymentWebhookEvents
      WHERE WebhookEventId = @wid
    `);
  return r.recordset?.[0] || null;
}

async function main() {
  const explicitIds = parseWebhookEventIds(process.env.WEBHOOK_EVENT_IDS);
  const processorTxns = parseProcessorTxnIds(process.env.PROCESSOR_TXN_IDS);
  const dryRun =
    process.env.DRY_RUN === '1' ||
    String(process.env.DRY_RUN || '').toLowerCase() === 'true';

  const directDb = process.env.RECURRING_REPLAY_DIRECT_DB === '1';

  const baseUrl =
    process.env.BACKEND_INTERNAL_BASE_URL ||
    process.env.BACKEND_API_URL;
  const token = process.env.INTERNAL_API_TOKEN;

  if (!processorTxns.length && !explicitIds.length) {
    console.error(
      'Set PROCESSOR_TXN_IDS (e.g. 371,355,356,313) and/or WEBHOOK_EVENT_IDS.'
    );
    process.exit(1);
  }
  if (!dryRun && !directDb && (!baseUrl || !token)) {
    console.error(
      'Live HTTP replay requires BACKEND_INTERNAL_BASE_URL (or BACKEND_API_URL) and INTERNAL_API_TOKEN.'
    );
    console.error(
      'Or set RECURRING_REPLAY_DIRECT_DB=1 to apply via database (loads credentials from backend/.env getPool()).'
    );
    process.exit(1);
  }

  const postUrl =
    dryRun || directDb ?
      ''
    : `${String(baseUrl).replace(/\/$/, '')}/api/internal/recurring-payment-success/apply`;

  if (dryRun) {
    console.error(JSON.stringify({ mode: 'dry_run_preview' }));
  } else if (directDb) {
    console.error(JSON.stringify({ mode: 'direct_db_writes' }));
  }

  const pool = await getPool();

  /** @type {Map<number, { webhookEventId: number; processorTxn: string|null; createdMs: number }>} */
  const jobMap = new Map();

  try {
    for (const txn of processorTxns) {
      const found = await lookupWebhookByProcessorTxn(pool, txn);
      if (!found) {
        console.error(JSON.stringify({ error: 'webhook_row_not_found', processorTxn: txn }));
        await closePool();
        process.exit(1);
      }
      if (jobMap.has(found.webhookEventId)) {
        const prev = jobMap.get(found.webhookEventId);
        if (prev && prev.processorTxn === txn) {
          console.error(JSON.stringify({ warn: 'duplicate_processor_txn_in_env', processorTxn: txn }));
          continue;
        }
        console.error(
          JSON.stringify({
            error: 'two_processor_txns_resolved_same_WebhookEventId',
            WebhookEventId: found.webhookEventId,
            processorTxns: [prev?.processorTxn, txn].filter(Boolean)
          })
        );
        await closePool();
        process.exit(1);
      }
      jobMap.set(found.webhookEventId, {
        webhookEventId: found.webhookEventId,
        processorTxn: txn,
        createdMs: found.createdDate && !Number.isNaN(found.createdDate.getTime())
          ? found.createdDate.getTime()
          : 0
      });
      console.error(
        JSON.stringify({
          resolved: true,
          processorTxn: txn,
          WebhookEventId: found.webhookEventId,
          EventType: found.eventType,
          CreatedDate: found.createdDate ? found.createdDate.toISOString() : null
        })
      );
    }

    for (const wid of explicitIds) {
      if (jobMap.has(wid)) continue;
      const row = await fetchWebhookRow(pool, wid);
      if (!row) {
        console.error(JSON.stringify({ error: 'explicit_webhook_not_found', WebhookEventId: wid }));
        await closePool();
        process.exit(1);
      }
      const cd = row.CreatedDate ? new Date(row.CreatedDate) : null;
      jobMap.set(wid, {
        webhookEventId: wid,
        processorTxn: null,
        createdMs: cd && !Number.isNaN(cd.getTime()) ? cd.getTime() : wid
      });
    }

    const jobs = [...jobMap.values()].sort((a, b) => {
      const t = a.createdMs - b.createdMs;
      return t !== 0 ? t : a.webhookEventId - b.webhookEventId;
    });

    if (dryRun) {
      console.log(
        JSON.stringify({
          dryRun: true,
          webhookEventIdsChronological: jobs.map((j) => j.webhookEventId),
          mappedByTxn: processorTxns.length
            ? jobs
                .filter((j) => j.processorTxn)
                .map((j) => ({ processorTxn: j.processorTxn, WebhookEventId: j.webhookEventId }))
            : []
        })
      );
      await closePool();
      return;
    }

    for (const job of jobs) {
      const row = await fetchWebhookRow(pool, job.webhookEventId);
      if (!row) {
        console.log(JSON.stringify({ webhookEventId: job.webhookEventId, skip: true, reason: 'row_missing' }));
        await closePool();
        process.exit(1);
      }
      let dimePayload = {};
      try {
        dimePayload = JSON.parse(String(row.Payload || '{}'));
      } catch (_) {
        console.error(JSON.stringify({ webhookEventId: job.webhookEventId, error: 'invalid_json_payload' }));
        await closePool();
        process.exit(1);
      }
      const et = row.EventType || 'recurring_payment.success';
      const rawBody = { event_type: et, data: dimePayload };

      /** @type {Record<string, unknown>} */
      let body = {};

      if (directDb) {
        const { applyRecurringPaymentSuccessFromWebhook } = require('../services/recurringPaymentWebhookApply.service');
        body = /** @type {Record<string, unknown>} */ (
          await applyRecurringPaymentSuccessFromWebhook({
            dimePayload,
            webhookEventId: job.webhookEventId,
            rawBody
          })
        );
        console.log(
          JSON.stringify({
            processorTxn: job.processorTxn,
            webhookEventId: job.webhookEventId,
            mode: 'direct_db',
            ...body
          })
        );
      } else {
        const response = await axios.post(
          postUrl,
          {
            dimePayload,
            webhookEventId: job.webhookEventId,
            rawBody
          },
          {
            headers: { 'x-internal-token': token, 'Content-Type': 'application/json' },
            timeout: 90000,
            validateStatus: () => true
          }
        );
        body = response.data || {};
        console.log(
          JSON.stringify({
            processorTxn: job.processorTxn,
            webhookEventId: job.webhookEventId,
            httpStatus: response.status,
            ...body
          })
        );
      }

      const ok =
        body &&
        (body.success === true || body.alreadyProcessed === true);
      if (!ok) {
        await closePool();
        process.exit(1);
      }
    }
  } finally {
    await closePool();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
