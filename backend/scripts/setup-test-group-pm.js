/**
 * One-shot: add a test ACH payment method to ABC Plumbing and bootstrap a
 * 15th-cohort GroupRecurringPaymentPlan so the end-to-end mid-month flow
 * can be exercised without going through the UI.
 *
 * Uses the DIME sandbox ACH credentials from backend/test-fixtures/dime-test-cards.js.
 *
 * Run from /backend:
 *   node scripts/setup-test-group-pm.js
 */
'use strict';

require('dotenv').config();

const { getPool, sql } = require('../config/database');
const PaymentMethodService = require('../services/PaymentMethodService');
const DimeService = require('../services/dimeService');
const { getChargeDayForCohort, getNextCohortDate } = require('../utils/billingCohort');
const { TEST_ACH } = require('../test-fixtures/dime-test-cards');

const GROUP_ID = '5FF6AAF4-CE26-4C2F-8B1F-144BD94FCD3F'; // ABC Plumbing
const TENANT_ID = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
const COHORT = 'FIFTEENTH';

async function main() {
  console.log(`🏁 Setting up test PM for ABC Plumbing (cohort=${COHORT})\n`);

  const pool = await getPool();

  const groupRes = await pool.request()
    .query(`SELECT Name, PrimaryContact, ContactEmail, ContactPhone FROM oe.Groups WHERE GroupId = '${GROUP_ID}'`);
  const group = groupRes.recordset[0];
  if (!group) throw new Error('Group not found');

  // 1. Ensure DIME customer
  console.log('1️⃣  Ensuring DIME customer…');
  const customerData = {
    firstName: group.PrimaryContact?.split(' ')[0] || 'Group',
    lastName: group.PrimaryContact?.split(' ').slice(1).join(' ') || 'Admin',
    email: group.ContactEmail,
    phone: group.ContactPhone || '+17707892072',
    billingAddress: '6860 Dallas Pkwy',
    billingCity: 'Plano',
    billingState: 'TX',
    billingZip: '75024',
    billingCountry: 'US'
  };

  const customerResult = await PaymentMethodService.ensureDimeCustomer(
    customerData, 'group', GROUP_ID, TENANT_ID
  );
  if (!customerResult.success) {
    console.error('❌ ensureDimeCustomer failed:', customerResult.error);
    process.exit(1);
  }
  console.log(`   ✅ DIME customerId: ${customerResult.customerId}\n`);

  // 2. Create the ACH payment method (sandbox creds)
  console.log('2️⃣  Creating sandbox ACH payment method…');
  const pmData = {
    paymentMethodType: 'ACH',
    bankName: 'Sandbox Test Bank',
    accountType: 'Checking',
    routingNumber: TEST_ACH.routingNumber,
    accountNumber: TEST_ACH.accountNumber,
    accountHolderName: group.PrimaryContact || 'Group Admin',
    billingAddress: '6860 Dallas Pkwy',
    billingAddress2: '',
    billingCity: 'Plano',
    billingState: 'TX',
    billingZip: '75024',
    billingCountry: 'US'
  };

  const validation = PaymentMethodService.validatePaymentMethodData(pmData, 'ACH');
  if (!validation.isValid) {
    console.error('❌ validation failed:', validation.errors);
    process.exit(1);
  }

  const dimeResult = await PaymentMethodService.createPaymentMethod(
    pmData, customerResult.customerId, TENANT_ID
  );
  if (!dimeResult.success) {
    console.error('❌ createPaymentMethod failed:', dimeResult.error);
    process.exit(1);
  }
  console.log(`   ✅ DIME paymentMethodId: ${dimeResult.paymentMethodId}, last4: ${dimeResult.last4}\n`);

  // 3. Insert into oe.GroupPaymentMethods
  console.log('3️⃣  Inserting into oe.GroupPaymentMethods…');
  const insertResult = await PaymentMethodService.insertPaymentMethod(
    pmData, 'group', GROUP_ID, dimeResult, null, null, null, null
  );
  if (!insertResult.success) {
    console.error('❌ insertPaymentMethod failed:', insertResult.error);
    process.exit(1);
  }
  console.log(`   ✅ paymentMethodId: ${insertResult.paymentMethodId}\n`);

  await PaymentMethodService.updatePaymentMethodDefaults(
    'group', GROUP_ID, insertResult.paymentMethodId, null, null, null, null
  );
  console.log('   ✅ marked as default\n');

  // 4. Bootstrap the GroupRecurringPaymentPlan with cohort=FIFTEENTH.
  //
  // The schema requires DimeScheduleId NOT NULL, so we create a real DIME
  // recurring schedule first and use that ID. (groupPaymentService's helper
  // inserts NULL there per its own code comment, which violates the testing
  // DB's schema — pre-existing mismatch, not addressed here.)
  console.log(`4️⃣  Computing plan amount + next billing date for cohort=${COHORT}…`);
  const billingDay = getChargeDayForCohort(COHORT);
  const totalRes = await pool.request()
    .input('groupId', sql.UniqueIdentifier, GROUP_ID)
    .input('billingDate', sql.DateTime2, null)
    .execute('oe.sp_CalculateGroupTotalPremium');
  const monthlyAmount = totalRes.recordset[0]?.TotalPremium || 0;
  const today = new Date();
  // Next billing date = next charge day for this cohort (the 20th for FIFTEENTH).
  let nextBillingDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), billingDay));
  if (nextBillingDate <= today) {
    nextBillingDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, billingDay));
  }
  console.log(`   amount=$${monthlyAmount}  billingDay=${billingDay}  next=${nextBillingDate.toISOString().split('T')[0]}\n`);

  console.log('5️⃣  Creating DIME recurring schedule…');
  const scheduleResult = await DimeService.setupRecurringPayment({
    customerId: customerResult.customerId,
    paymentMethodId: dimeResult.paymentMethodId,
    amount: monthlyAmount,
    description: `Group recurring payment for ${group.Name}`,
    startDate: nextBillingDate,
    scheduleName: `${group.Name} (15th cohort test)`
  }, TENANT_ID);

  if (!scheduleResult.success) {
    console.error('   ❌ setupRecurringPayment failed:', scheduleResult.error);
    process.exit(1);
  }
  console.log(`   ✅ DIME scheduleId: ${scheduleResult.scheduleId}\n`);

  console.log('6️⃣  Inserting oe.GroupRecurringPaymentPlans row…');
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
  console.log('   ✅ inserted\n');

  // 5. Verify
  console.log('5️⃣  Verifying state…');
  const verify = await pool.request().query(`
    SELECT
      g.ProcessorCustomerId,
      (SELECT COUNT(*) FROM oe.GroupPaymentMethods WHERE GroupId = '${GROUP_ID}' AND Status = 'Active') AS PMCount,
      (SELECT TOP 1 BillingDay FROM oe.GroupRecurringPaymentPlans WHERE GroupId = '${GROUP_ID}' AND IsActive = 1) AS BillingDay,
      (SELECT TOP 1 MonthlyAmount FROM oe.GroupRecurringPaymentPlans WHERE GroupId = '${GROUP_ID}' AND IsActive = 1) AS MonthlyAmount,
      (SELECT TOP 1 NextBillingDate FROM oe.GroupRecurringPaymentPlans WHERE GroupId = '${GROUP_ID}' AND IsActive = 1) AS NextBillingDate
    FROM oe.Groups g
    WHERE g.GroupId = '${GROUP_ID}'
  `);
  console.log('   ', verify.recordset[0]);

  await pool.close();
  console.log('\n🎉 Done.');
}

main().catch(err => {
  console.error('💥 Script failed:', err);
  process.exit(1);
});
