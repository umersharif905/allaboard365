#!/usr/bin/env node
'use strict';

/**
 * Replays stored oe.PaymentWebhookEvents rows through DimeWebhookHandler logic
 * (same code path as the Azure Function, without inserting a duplicate webhook row).
 *
 * Dry run — resolve rows only:
 *   DRY_RUN=1 WEBHOOK_EVENT_IDS=1105 node backend/scripts/replay-dime-webhook-events.js
 *
 * Replay by DIME transaction_number:
 *   DRY_RUN=1 PROCESSOR_TXN_IDS=778 EVENT_TYPES=ach_payment_return node backend/scripts/replay-dime-webhook-events.js
 *
 * Live replay (uses backend/.env DB_* + BACKEND_API_URL for processBounce):
 *   WEBHOOK_EVENT_IDS=1105 FORCE_REPROCESS=1 node backend/scripts/replay-dime-webhook-events.js
 *
 * Target prod explicitly:
 *   DB_NAME=allaboard-prod WEBHOOK_EVENT_IDS=1105 FORCE_REPROCESS=1 node backend/scripts/replay-dime-webhook-events.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getPool, sql } = require('../../oe_payment_manager/shared/db');
const {
  replayStoredPaymentWebhook,
  createConsoleReplayLogger
} = require('../../oe_payment_manager/DimeWebhookHandler/index.js');

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
    .filter((s) => s.length > 0);
}

/** @returns {string[]} */
function parseEventTypes(raw) {
  return (raw || '')
    .split(/[\s,]+/)
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} txnClean
 * @param {string[]} eventTypes
 */
async function lookupWebhookByProcessorTxn(pool, txnClean, eventTypes) {
  const req = pool.request().input('txn', sql.NVarChar(64), txnClean);
  let eventFilter = '';
  if (eventTypes.length) {
    const placeholders = eventTypes.map((_, i) => `@et${i}`).join(', ');
    eventTypes.forEach((et, i) => req.input(`et${i}`, sql.NVarChar(100), et));
    eventFilter = ` AND LOWER(ISNULL(EventType, N'')) IN (${placeholders})`;
  }
  const r = await req.query(`
    SELECT TOP (1)
      WebhookEventId,
      EventType,
      TransactionId AS WhTxn,
      Processed,
      ErrorMessage,
      CreatedDate
    FROM oe.PaymentWebhookEvents
    WHERE (
        LTRIM(RTRIM(ISNULL(TransactionId, N''))) = @txn
        OR CHARINDEX(N'"transaction_number":"' + @txn + N'"', Payload) > 0
        OR CHARINDEX(N'"transaction_number": "' + @txn + N'"', Payload) > 0
      )
      ${eventFilter}
    ORDER BY CreatedDate DESC
  `);
  return r.recordset?.[0] || null;
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {number} webhookEventId
 */
async function fetchWebhookRow(pool, webhookEventId) {
  const r = await pool
    .request()
    .input('wid', sql.Int, webhookEventId)
    .query(`
      SELECT WebhookEventId, EventType, TransactionId AS WhTxn, Processed, ErrorMessage, Amount, CreatedDate
      FROM oe.PaymentWebhookEvents
      WHERE WebhookEventId = @wid
    `);
  return r.recordset?.[0] || null;
}

async function main() {
  const explicitIds = parseWebhookEventIds(process.env.WEBHOOK_EVENT_IDS);
  const processorTxns = parseProcessorTxnIds(process.env.PROCESSOR_TXN_IDS);
  const eventTypes = parseEventTypes(process.env.EVENT_TYPES);
  const dryRun =
    process.env.DRY_RUN === '1' || String(process.env.DRY_RUN || '').toLowerCase() === 'true';
  const force = process.env.FORCE_REPROCESS === '1';

  if (!processorTxns.length && !explicitIds.length) {
    console.error('Set WEBHOOK_EVENT_IDS (e.g. 1105) and/or PROCESSOR_TXN_IDS (e.g. 778).');
    console.error('Optional: EVENT_TYPES=ach_payment_return to narrow txn lookup.');
    process.exit(1);
  }

  console.error(
    JSON.stringify({
      mode: dryRun ? 'dry_run' : 'live_replay',
      database: process.env.DB_NAME || '(from .env)',
      forceReprocess: force,
      eventTypeFilter: eventTypes.length ? eventTypes : null
    })
  );

  const pool = await getPool();
  const logger = createConsoleReplayLogger();

  /** @type {Map<number, { webhookEventId: number; processorTxn: string|null }>} */
  const jobMap = new Map();

  try {
    for (const txn of processorTxns) {
      const found = await lookupWebhookByProcessorTxn(pool, txn, eventTypes);
      if (!found) {
        console.error(JSON.stringify({ error: 'webhook_row_not_found', processorTxn: txn, eventTypes }));
        await pool.close();
        process.exit(1);
      }
      jobMap.set(Number(found.WebhookEventId), {
        webhookEventId: Number(found.WebhookEventId),
        processorTxn: txn
      });
      console.error(
        JSON.stringify({
          resolved: true,
          processorTxn: txn,
          WebhookEventId: found.WebhookEventId,
          EventType: found.EventType,
          Processed: !!found.Processed,
          ErrorMessage: found.ErrorMessage || null,
          CreatedDate: found.CreatedDate ? new Date(found.CreatedDate).toISOString() : null
        })
      );
    }

    for (const wid of explicitIds) {
      if (jobMap.has(wid)) continue;
      const row = await fetchWebhookRow(pool, wid);
      if (!row) {
        console.error(JSON.stringify({ error: 'explicit_webhook_not_found', WebhookEventId: wid }));
        await pool.close();
        process.exit(1);
      }
      if (eventTypes.length && !eventTypes.includes(String(row.EventType || '').toLowerCase())) {
        console.error(
          JSON.stringify({
            error: 'event_type_mismatch',
            WebhookEventId: wid,
            EventType: row.EventType,
            expected: eventTypes
          })
        );
        await pool.close();
        process.exit(1);
      }
      jobMap.set(wid, { webhookEventId: wid, processorTxn: null });
      console.error(
        JSON.stringify({
          resolved: true,
          WebhookEventId: wid,
          EventType: row.EventType,
          Processed: !!row.Processed,
          ErrorMessage: row.ErrorMessage || null,
          WhTxn: row.WhTxn,
          Amount: row.Amount
        })
      );
    }

    const jobs = [...jobMap.values()].sort((a, b) => a.webhookEventId - b.webhookEventId);

    if (dryRun) {
      console.log(JSON.stringify({ dryRun: true, webhookEventIds: jobs.map((j) => j.webhookEventId) }));
      await pool.close();
      return;
    }

    let hadFailure = false;
    for (const job of jobs) {
      const result = await replayStoredPaymentWebhook(pool, job.webhookEventId, logger, { force });
      console.log(JSON.stringify({ processorTxn: job.processorTxn, ...result }));
      if (!result.success) hadFailure = true;
    }

    await pool.close();
    process.exit(hadFailure ? 1 : 0);
  } catch (e) {
    try {
      await pool.close();
    } catch (_) {
      /* ignore */
    }
    console.error(e);
    process.exit(1);
  }
}

main();
