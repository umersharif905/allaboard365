const monthlyScheduler = require('../MonthlyPaymentScheduler');

/**
 * Timer Trigger - 1st of each month at 6:00 AM UTC
 * Runs the same invoice generation + DIME schedule + email logic as DimeManualScheduler (manual-run).
 *
 * Schedule: "0 0 6 1 * *" = 6 AM UTC on the 1st of every month
 *
 * Uses the same MonthlyPaymentScheduler module as the manual trigger.
 */
module.exports = async function (context, myTimer) {
  try {
    context.log('📅 MonthlyPaymentSchedulerTrigger fired (1st of month at 6 AM UTC) — FIRST cohort');
    await monthlyScheduler(context, myTimer, { cohort: 'FIRST' });
    context.log('✅ MonthlyPaymentSchedulerTrigger completed');
  } catch (error) {
    context.log.error('❌ MonthlyPaymentSchedulerTrigger failed:', error);
    throw error;
  }
};
