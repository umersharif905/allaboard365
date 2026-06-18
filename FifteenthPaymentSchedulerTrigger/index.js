const monthlyScheduler = require('../MonthlyPaymentScheduler');

/**
 * Timer Trigger — 15th of each month at 6:00 AM UTC (FIFTEENTH cohort).
 * Mirrors MonthlyPaymentSchedulerTrigger but for groups on the 15th billing cycle:
 * invoices are anchored to the 15th and the DIME draft is scheduled for the 20th.
 *
 * Schedule: "0 0 6 15 * *" = 6 AM UTC on the 15th of every month.
 *
 * Runs the SAME MonthlyPaymentScheduler module; passing cohort='FIFTEENTH' makes it
 * select only groups with AllowMidMonthEffective=1 and charge on the 20th. The FIRST
 * cohort run on the 1st selects only AllowMidMonthEffective=0 groups, so the two runs
 * never bill the same group.
 */
module.exports = async function (context, myTimer) {
  try {
    context.log('📅 FifteenthPaymentSchedulerTrigger fired (15th of month at 6 AM UTC) — FIFTEENTH cohort');
    await monthlyScheduler(context, myTimer, { cohort: 'FIFTEENTH' });
    context.log('✅ FifteenthPaymentSchedulerTrigger completed');
  } catch (error) {
    context.log.error('❌ FifteenthPaymentSchedulerTrigger failed:', error);
    throw error;
  }
};
