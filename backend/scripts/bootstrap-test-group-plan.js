/**
 * Resume from where setup-test-group-pm.js left off: the DIME customer + PM
 * already exist for ABC Plumbing. Create the DIME recurring schedule and the
 * GroupRecurringPaymentPlans row with cohort=FIFTEENTH.
 *
 * Run from /backend:
 *   node scripts/bootstrap-test-group-plan.js
 */
'use strict';

require('dotenv').config();

const { getPool, sql } = require('../config/database');
const DimeService = require('../services/dimeService');
const { getChargeDayForCohort } = require('../utils/billingCohort');

const GROUP_ID = '5FF6AAF4-CE26-4C2F-8B1F-144BD94FCD3F';
const TENANT_ID = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
const COHORT = 'FIFTEENTH';

async function main() {
  const pool = await getPool();

  const ctx = await pool.request().query(`
    SELECT g.Name, g.ProcessorCustomerId,
           (SELECT TOP 1 ProcessorPaymentMethodId FROM oe.GroupPaymentMethods
              WHERE GroupId = '${GROUP_ID}' AND Status = 'Active' AND IsDefault = 1) AS PMId
    FROM oe.Groups g WHERE g.GroupId = '${GROUP_ID}'
  `);
  const { Name, ProcessorCustomerId, PMId } = ctx.recordset[0];
  if (!ProcessorCustomerId || !PMId) {
    console.error('❌ Missing customerId or PMId; run setup-test-group-pm.js first');
    process.exit(1);
  }
  console.log(`Group: ${Name}, customerId=${ProcessorCustomerId}, paymentMethodId=${PMId}\n`);

  const billingDay = getChargeDayForCohort(COHORT);
  const totalRes = await pool.request()
    .input('groupId', sql.UniqueIdentifier, GROUP_ID)
    .input('billingDate', sql.DateTime2, null)
    .execute('oe.sp_CalculateGroupTotalPremium');
  const monthlyAmount = totalRes.recordset[0]?.TotalPremium || 0;
  const today = new Date();
  let nextBillingDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), billingDay));
  if (nextBillingDate <= today) {
    nextBillingDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, billingDay));
  }
  console.log(`amount=$${monthlyAmount}  billingDay=${billingDay}  next=${nextBillingDate.toISOString().split('T')[0]}\n`);

  console.log('Creating DIME recurring schedule…');
  const scheduleResult = await DimeService.setupRecurringPayment({
    customerId: ProcessorCustomerId,
    paymentMethodId: PMId,
    amount: monthlyAmount,
    description: `Group recurring payment for ${Name}`,
    startDate: nextBillingDate,
    scheduleName: `${Name} (15th cohort test)`
  }, TENANT_ID);

  if (!scheduleResult.success) {
    console.error('❌ setupRecurringPayment failed:', scheduleResult.error || scheduleResult);
    process.exit(1);
  }
  console.log(`✅ scheduleId: ${scheduleResult.scheduleId}\n`);

  console.log('Inserting GroupRecurringPaymentPlans…');
  await pool.request()
    .input('groupId', sql.UniqueIdentifier, GROUP_ID)
    .input('scheduleId', sql.NVarChar(255), scheduleResult.scheduleId)
    .input('amount', sql.Decimal(10, 2), monthlyAmount)
    .input('billingDay', sql.Int, billingDay)
    .input('nextBilling', sql.DateTime2, nextBillingDate)
    .input('cohort', sql.NVarChar(20), COHORT)
    .query(`
      INSERT INTO oe.GroupRecurringPaymentPlans (
        PlanId, GroupId, DimeScheduleId, MonthlyAmount, BillingDay,
        NextBillingDate, IsActive, Cohort, CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @groupId, @scheduleId, @amount, @billingDay,
        @nextBilling, 1, @cohort, GETUTCDATE(), GETUTCDATE()
      )
    `);
  console.log('✅ inserted\n');

  const verify = await pool.request().query(`
    SELECT BillingDay, MonthlyAmount, NextBillingDate, DimeScheduleId, IsActive
    FROM oe.GroupRecurringPaymentPlans WHERE GroupId = '${GROUP_ID}' AND IsActive = 1
  `);
  console.log('Final plan:', verify.recordset[0]);

  await pool.close();
}

main().catch(err => { console.error(err); process.exit(1); });
