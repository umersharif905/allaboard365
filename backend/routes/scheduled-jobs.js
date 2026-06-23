/**
 * Scheduled Jobs API Routes
 * 
 * Endpoints for running scheduled maintenance tasks
 * These should be called by a cron job or Azure Scheduler
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../config/database');
const groupPaymentScheduler = require('../services/groupPaymentScheduler');
const VendorExportService = require('../services/vendorExportService');
const { executeNewGroupFormScheduledJob } = require('../services/newGroupFormScheduledJobService');
const { runProductApiForProduct, listProductIdsWithRunDaily } = require('../services/productAPIRunJob');
const { sendProductApiDailyRunReport } = require('../services/productApiDailyReportEmail');
const { runDailyBillingAuditJob } = require('../services/billingAuditDailyJob.service');
const { runBillingNightlyOrchestrator } = require('../services/billingNightlyOrchestrator.service');
const { runDimeLedgerReconcile } = require('../services/dimeLedgerReconcile.service');
const { recordIntegrationError } = require('../services/integrationErrorService');
const Sentry = require('@sentry/node');
const overdueReminderRunner = require('../services/overdueInvoiceReminderRunner.service');
const {
  syncEnrollmentsPastTerminationDate,
  cleanupStalePaymentHoldEnrollments
} = require('../services/enrollmentScheduledJobsService');
const { runIntegrationErrorDigestJob } = require('../services/integrationErrorDigestJob.service');
const belowMinimumCheckService = require('../services/belowMinimumCheckService');
const { runAutoVendorGroupIdsJob } = require('../services/autoVendorGroupIdsNightlyJob.service');

/**
 * POST /api/scheduled-jobs/monthly-recurring-payments
 * Run monthly recurring payment calculation (should run on 1st of each month)
 * 
 * Security: This endpoint should be protected by API key in production
 */
router.post('/monthly-recurring-payments', async (req, res) => {
  try {
    // Validate API key for scheduled jobs (optional but recommended)
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - Invalid API key'
      });
    }
    
    console.log('📅 Monthly recurring payment calculation triggered');
    console.log('🔍 Request source:', req.headers['user-agent'] || 'Unknown');
    
    const results = await groupPaymentScheduler.calculateMonthlyRecurringPayments();
    
    res.json({
      success: true,
      message: 'Monthly recurring payment calculation completed',
      data: results
    });
    
  } catch (error) {
    console.error('❌ Monthly calculation endpoint error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to run monthly calculation',
      error: error.message
    });
  }
});

/**
 * GET /api/scheduled-jobs/monthly-recurring-payments/status
 * Check if monthly calculation is due (debugging/testing)
 */
router.get('/monthly-recurring-payments/status', async (req, res) => {
  try {
    const isFirstOfMonth = groupPaymentScheduler.isFirstOfMonth();
    const today = new Date();
    const cohortsDueToday = groupPaymentScheduler.getCohortsToProcessToday(today);

    // Next FIRST-cohort run: 1st of next UTC month
    const nextFirst = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth() + 1,
      1
    ));

    // Next FIFTEENTH-cohort run: 15th of this UTC month if still in future, else 15th of next month
    let nextFifteenth = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      15
    ));
    if (nextFifteenth <= today) {
      nextFifteenth = new Date(Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth() + 1,
        15
      ));
    }

    const nextFirstCohortRun = nextFirst.toISOString().split('T')[0];
    const nextFifteenthCohortRun = nextFifteenth.toISOString().split('T')[0];

    res.json({
      success: true,
      data: {
        currentDate: today.toISOString(),
        dayOfMonth: today.getUTCDate(),
        isFirstOfMonth,
        isDue: cohortsDueToday.length > 0,
        cohortsDueToday,
        // Preserve backward-compatible field; aliases the FIRST-cohort next run.
        nextRunDate: nextFirstCohortRun,
        nextFirstCohortRun,
        nextFifteenthCohortRun
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to check status',
      error: error.message
    });
  }
});

/**
 * POST /api/scheduled-jobs/vendor-exports
 * Run scheduled vendor exports (should be called by Azure Logic App or cron)
 * 
 * Security: This endpoint should be protected by API key in production
 */
router.post('/vendor-exports', async (req, res) => {
  try {
    // Validate API key for scheduled jobs (optional but recommended)
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - Invalid API key'
      });
    }
    
    console.log('📅 Vendor export scheduler triggered');
    console.log('🔍 Request source:', req.headers['user-agent'] || 'Unknown');
    
    const workItems = await VendorExportService.getVendorScheduledExportsForScheduler();

    if (workItems.length === 0) {
      return res.json({
        success: true,
        message: 'No scheduled export work items at this time',
        data: { workItemsProcessed: 0, results: [] }
      });
    }

    console.log(`📤 Found ${workItems.length} scheduled export work item(s)`);

    const results = [];
    for (const item of workItems) {
      try {
        if (item.kind === 'job') {
          console.log(`📤 Job ${item.vendorScheduledJobId} (${item.jobType}) — vendor ${item.vendorName} (${item.vendorId})`);
          let result;
          if (item.jobType === 'payables_export') {
            result = await VendorExportService.executePayablesExport(item.vendorId, {
              scheduledJobId: item.vendorScheduledJobId,
              sftpPathOverride: item.sftpPathOverride,
              emailRecipients: item.emailRecipients,
              lastExportedNachaId: item.lastExportedNachaId,
              useVendorDefaultSftp: item.useVendorDefaultSftp !== false
            });
          } else if (item.jobType === 'new_group_form') {
            result = await executeNewGroupFormScheduledJob(item.vendorId, {
              emailRecipients: item.emailRecipients,
              generateVendorGroupIdsIfNeeded: item.generateVendorGroupIdsIfNeeded === true
            });
          } else {
            result = await VendorExportService.executeExport(item.vendorId, {
              scheduledJobId: item.vendorScheduledJobId,
              sftpPathOverride: item.sftpPathOverride,
              emailRecipients: item.emailRecipients,
              useVendorDefaultSftp: item.useVendorDefaultSftp !== false,
              excludeGroupsMissingVendorGroupId: item.excludeGroupsMissingVendorGroupId === true
            });
          }
          // Always update LastRunAt after an attempt so failed exports don't re-queue every minute
          // (Azure Function timer hits the API each minute). Only advance LastExportedNachaId on successful payables upload.
          if (item.jobType === 'payables_export') {
            const shouldSetNacha =
              result &&
              result.success !== false &&
              !result.exportSkipped &&
              result.nachaId;
            if (shouldSetNacha) {
              await VendorExportService.touchScheduledJobLastRun(item.vendorScheduledJobId, {
                lastExportedNachaId: result.nachaId
              });
            } else {
              await VendorExportService.touchScheduledJobLastRun(item.vendorScheduledJobId);
            }
          } else {
            await VendorExportService.touchScheduledJobLastRun(item.vendorScheduledJobId);
          }
          await VendorExportService.recordScheduledJobRun({
            vendorScheduledJobId: item.vendorScheduledJobId,
            vendorId: item.vendorId,
            jobType: item.jobType,
            result,
            error: null
          });
          results.push({
            kind: 'job',
            vendorScheduledJobId: item.vendorScheduledJobId,
            vendorId: item.vendorId,
            vendorName: item.vendorName,
            jobType: item.jobType,
            ...result,
            success: result?.success !== false
          });
        } else {
          console.log(`📤 Legacy schedule — vendor ${item.vendorName} (${item.vendorId})`);
          const result = await VendorExportService.executeExport(item.vendorId, {});
          await VendorExportService.recordScheduledJobRun({
            vendorScheduledJobId: null,
            vendorId: item.vendorId,
            jobType: 'eligibility_export',
            result,
            error: null
          });
          results.push({
            kind: 'legacy',
            vendorId: item.vendorId,
            vendorName: item.vendorName,
            ...result,
            success: result?.success !== false
          });
        }
      } catch (error) {
        console.error(`❌ Failed export work item:`, error);
        await VendorExportService.recordScheduledJobRun({
          vendorScheduledJobId: item.kind === 'job' ? item.vendorScheduledJobId : null,
          vendorId: item.vendorId,
          jobType: item.kind === 'job' ? item.jobType : 'eligibility_export',
          result: null,
          error: error.message
        });
        results.push({
          kind: item.kind,
          vendorId: item.vendorId,
          vendorName: item.vendorName,
          vendorScheduledJobId: item.kind === 'job' ? item.vendorScheduledJobId : undefined,
          success: false,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: `Vendor export scheduler completed. Processed ${workItems.length} work item(s).`,
      data: {
        workItemsProcessed: workItems.length,
        results
      }
    });
    
  } catch (error) {
    console.error('❌ Vendor export scheduler error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to run vendor export scheduler',
      error: error.message
    });
  }
});

/**
 * POST /api/scheduled-jobs/product-api-daily
 * Runs tenant product API sync for each product with ConfigJson.runDaily === true (same as manual "Run API for everyone").
 * Called by Azure Functions timer (product-api-jobs).
 */
router.post('/product-api-daily', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - Invalid API key'
      });
    }

    console.log('📅 Product API daily scheduler triggered');
    const pool = await getPool();
    const productIds = await listProductIdsWithRunDaily(pool);

    const results = [];

    if (productIds.length === 0) {
      await sendProductApiDailyRunReport(pool, { results: [], productIds: [] });
      return res.json({
        success: true,
        message: 'No products with runDaily enabled',
        data: { productsProcessed: 0, results: [] }
      });
    }

    for (const productId of productIds) {
      try {
        const data = await runProductApiForProduct(pool, productId, { updateAll: false });
        if (data.skipped) {
          results.push({ productId, skipped: true, reason: data.reason });
        } else {
          const errs = data.errors || [];
          results.push({
            productId,
            activated: data.activated,
            deactivated: data.deactivated,
            updated: data.updated,
            errorCount: errs.length,
            errorsPreview: errs.slice(0, 5)
          });
        }
      } catch (err) {
        console.error(`❌ Product API daily run failed for ${productId}:`, err);
        results.push({ productId, success: false, error: err.message });
      }
    }

    await sendProductApiDailyRunReport(pool, { results, productIds });

    res.json({
      success: true,
      message: `Product API daily run completed for ${productIds.length} product(s).`,
      data: { productsProcessed: productIds.length, results }
    });
  } catch (error) {
    console.error('❌ Product API daily scheduler error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to run product API daily job',
      error: error.message
    });
  }
});

/**
 * POST /api/scheduled-jobs/billing-audit-daily
 * Per-tenant billing audit summary + DB-only audits (no DIME HTTP); persists oe.BillingAuditReports; emails ops.
 */
router.post('/billing-audit-daily', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - Invalid API key'
      });
    }
    console.log('📅 Billing audit daily job triggered');
    const data = await runDailyBillingAuditJob();
    res.json({
      success: true,
      message: 'Billing audit daily completed',
      data
    });
  } catch (error) {
    console.error('❌ billing-audit-daily error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to run billing audit daily job',
      error: error.message
    });
  }
});

/**
 * POST /api/scheduled-jobs/billing-nightly
 * DIME payment-status reconcile (writes, per-tenant) → individual invoice nightly → billing audit daily.
 * Body (optional): { skipDimeReconcile?: boolean, hoursBack?: number, dimeLimit?: number, successRecheckDays?: number, secondaryLimit?: number, pendingLookbackDays?: number, pendingSecondaryLimit?: number }
 */
router.post('/billing-nightly', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - Invalid API key'
      });
    }
    console.log('📅 Billing nightly orchestrator triggered');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const data = await runBillingNightlyOrchestrator({
      skipDimeReconcile: body.skipDimeReconcile === true,
      hoursBack: body.hoursBack,
      dimeLimit: body.dimeLimit,
      successRecheckDays: body.successRecheckDays,
      secondaryLimit: body.secondaryLimit,
      pendingLookbackDays: body.pendingLookbackDays,
      pendingSecondaryLimit: body.pendingSecondaryLimit
    });
    res.json({
      success: true,
      message: 'Billing nightly orchestrator completed',
      data
    });
  } catch (error) {
    console.error('❌ billing-nightly error:', error);
    // Total orchestrator failure bypasses its own per-step reporting, so surface
    // it here too — AI inspector reads oe.SystemIntegrationErrors ('billing' is a
    // critical category) and Sentry is the second channel.
    try {
      await recordIntegrationError({
        category: 'billing',
        source: 'scheduled-jobs:billing-nightly',
        severity: 'error',
        priority: 'critical',
        message: `Billing nightly orchestrator failed: ${error.message}`,
        detail: { stack: error.stack }
      });
    } catch (_) {}
    try {
      Sentry.captureException(error, { tags: { job: 'billing-nightly' } });
    } catch (_) {}
    res.status(500).json({
      success: false,
      message: 'Failed to run billing nightly orchestrator',
      error: error.message
    });
  }
});

/**
 * POST /api/scheduled-jobs/ledger-reconcile
 * WEEKLY full-ledger settlement audit (report-only). For each active ACH household,
 * pulls the complete DIME customer ledger, nets credits vs returns/rejects, and
 * compares the true settled total against our recorded Completed payments. Over- and
 * under-statements are written to oe.SystemIntegrationErrors (AI inspector watches
 * 'billing') — it does NOT modify payments/invoices. Heavier than the nightly, so it
 * runs on its own weekly schedule.
 *
 * Body (optional): { tenantId?, lookbackDays?, maxHouseholds?, toleranceCents?, paceMs?, dryRun? }
 */
router.post('/ledger-reconcile', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized - Invalid API key' });
    }
    console.log('📅 DIME ledger reconcile (weekly) triggered');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const data = await runDimeLedgerReconcile({
      tenantId: typeof body.tenantId === 'string' ? body.tenantId : null,
      lookbackDays: body.lookbackDays,
      maxHouseholds: body.maxHouseholds,
      toleranceCents: body.toleranceCents,
      paceMs: body.paceMs,
      dryRun: body.dryRun === true
    });
    res.json({
      success: true,
      message:
        `Ledger reconcile complete: scanned ${data.totals.scanned}, ` +
        `${data.totals.overstatedCount} overstated, ${data.totals.understatedCount} understated`,
      data
    });
  } catch (error) {
    console.error('❌ ledger-reconcile error:', error);
    try {
      await recordIntegrationError({
        category: 'billing',
        source: 'scheduled-jobs:ledger-reconcile',
        severity: 'error',
        priority: 'critical',
        message: `Ledger reconcile job failed: ${error.message}`,
        detail: { stack: error.stack }
      });
    } catch (_) {}
    try {
      Sentry.captureException(error, { tags: { job: 'ledger-reconcile' } });
    } catch (_) {}
    res.status(500).json({ success: false, message: 'Failed to run ledger reconcile', error: error.message });
  }
});

/**
 * POST /api/scheduled-jobs/overdue-reminders-run
 * Manual / ops trigger for the overdue invoice reminder pass. Normally rides
 * along inside billing-nightly; this lets ops force a run, optionally scoped
 * to one tenant or in dry-run mode.
 *
 * Body: { tenantId?: string, dryRun?: boolean }
 */
router.post('/overdue-reminders-run', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized - Invalid API key' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const summary = await overdueReminderRunner.run({
      tenantId: typeof body.tenantId === 'string' ? body.tenantId : null,
      dryRun: body.dryRun === true
    });
    res.json({ success: true, message: 'Overdue reminders run completed', data: summary });
  } catch (error) {
    console.error('❌ overdue-reminders-run error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to run overdue reminders',
      error: error.message
    });
  }
});

/**
 * POST /api/scheduled-jobs/enrollment-termination-sync
 * Active enrollments with TerminationDate <= today -> Terminated
 */
router.post('/enrollment-termination-sync', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized - Invalid API key' });
    }
    const data = await syncEnrollmentsPastTerminationDate();
    res.json({ success: true, message: 'Enrollment termination sync completed', data });
  } catch (error) {
    console.error('❌ enrollment-termination-sync error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/scheduled-jobs/enrollment-cleanup
 * Deletes stale PaymentHold enrollments (4h–3d window); never Members/Users
 */
router.post('/enrollment-cleanup', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized - Invalid API key' });
    }
    const data = await cleanupStalePaymentHoldEnrollments();
    res.json({ success: true, message: 'Enrollment PaymentHold cleanup completed', data });
  } catch (error) {
    console.error('❌ enrollment-cleanup error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/scheduled-jobs/integration-error-digest
 * Emails new high/critical SystemIntegrationErrors to the configured recipient list.
 * Designed to run every 15 minutes from the integration-error-digest-job Azure Function.
 */
router.post('/integration-error-digest', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized - Invalid API key' });
    }
    const data = await runIntegrationErrorDigestJob();
    res.json({ success: true, message: 'Integration error digest run complete', data });
  } catch (error) {
    console.error('❌ integration-error-digest error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/scheduled-jobs/below-minimum-check
 * For each active Standard group with pending enrollments on the next effective date,
 * sends a Warning email at T-10 days and a Lock email at T-5 days, deduped via
 * oe.GroupMinimumAlerts.
 * Designed to run daily from the billing-nightly-job Azure Function.
 */
router.post('/below-minimum-check', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized - Invalid API key' });
    }
    const data = await belowMinimumCheckService.run();
    res.json({ success: true, data });
  } catch (err) {
    console.error('❌ below-minimum-check error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/scheduled-jobs/auto-vendor-group-ids
 * Nightly auto-generate vendor group IDs (Part D).
 *
 * For each oe.Vendors row with AutoGenerateVendorGroupIds = 1 and configured for
 * vendor group IDs, finds groups with active enrollments that don't yet have a
 * group-level Master vendor group ID and runs applyGenerateForGroup against them.
 *
 * Trigger: Azure Logic App / cron once per night.
 * Auth: SCHEDULED_JOB_API_KEY header (x-api-key).
 *
 * Records a per-vendor row in oe.VendorScheduledJobRuns (jobType =
 * 'auto_vendor_group_ids', triggerSource = 'scheduled') so the run history UI
 * surfaces the nightly job alongside other vendor jobs.
 */
router.post('/auto-vendor-group-ids', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized - Invalid API key' });
    }
    console.log('📅 Auto vendor group IDs nightly job triggered');
    const data = await runAutoVendorGroupIdsJob();
    res.json({
      success: true,
      message: `Auto vendor group IDs run completed. Processed ${data.vendorsProcessed} vendor(s), ${data.totalGroupsProcessed} group(s), ${data.totalIdsCreated} new ID(s).`,
      data,
    });
  } catch (error) {
    console.error('❌ auto-vendor-group-ids error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===========================================================================
// Back Office email inbox — keep Graph subscriptions alive + recover gaps.
// Driven by the email-mailbox-job Azure Function timers. See
// docs/superpowers/specs/2026-06-02-back-office-email/ (B-004).
// ===========================================================================
const emailMailboxJobs = require('../services/emailMailboxJobs.service');

/**
 * POST /api/scheduled-jobs/email-subscription-renewal
 * Renew Graph change-notification subscriptions nearing expiry (≤7-day cap),
 * creating one for any configured vendor that's missing it. Run every few hours.
 */
router.post('/email-subscription-renewal', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized - Invalid API key' });
    }
    const data = await emailMailboxJobs.renewDueSubscriptions();
    res.json({ success: true, message: `Subscription renewal completed for ${data.vendors} vendor(s).`, data });
  } catch (error) {
    console.error('❌ email-subscription-renewal error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/scheduled-jobs/email-reconcile
 * Run the Inbox delta for every configured vendor — seeds new mailboxes and
 * recovers any messages the webhook missed. Run every few minutes.
 */
router.post('/email-reconcile', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized - Invalid API key' });
    }
    const data = await emailMailboxJobs.reconcileAllMailboxes();
    res.json({ success: true, message: `Mailbox reconcile completed for ${data.vendors} vendor(s).`, data });
  } catch (error) {
    console.error('❌ email-reconcile error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
