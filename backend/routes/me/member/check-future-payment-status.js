/**
 * Check Future Payment Status Endpoint
 * 
 * Returns payment status for future enrollments to help frontend
 * calculate accurate "Due Today" amounts for plan changes
 */

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { getEffectiveMemberId } = require('../../../middleware/attachMemberHouseholdContext');

// Note: Auth middleware is applied by parent router (/me/member/index.js)
router.post('/', async (req, res) => {
  let pool;
  
  try {
    console.log('🔍 Checking future payment status for member...');
    
    pool = await getPool();
    
    // Get member from OAuth token
    const memberQuery = `
      SELECT m.MemberId, m.UserId, m.GroupId, m.HouseholdId
      FROM oe.Members m
      WHERE m.MemberId = @memberId AND m.Status = 'Active'
    `;
    
    const memberResult = await pool.request()
      .input('memberId', sql.UniqueIdentifier, getEffectiveMemberId(req))
      .query(memberQuery);
    
    if (memberResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Member not found'
      });
    }
    
    const member = memberResult.recordset[0];
    
    // Check for future enrollments (effective date > today)
    const futureEnrollmentsQuery = `
      SELECT 
        e.EnrollmentId,
        e.ProductId,
        e.ProductBundleID,
        e.EffectiveDate,
        e.PremiumAmount
      FROM oe.Enrollments e
      WHERE e.MemberId = @memberId
        AND e.Status = 'Active'
        AND e.EffectiveDate > GETDATE()
    `;
    
    const futureEnrollmentsResult = await pool.request()
      .input('memberId', sql.UniqueIdentifier, member.MemberId)
      .query(futureEnrollmentsQuery);
    
    const futureEnrollments = futureEnrollmentsResult.recordset;
    
    if (futureEnrollments.length === 0) {
      return res.json({
        success: true,
        data: {
          hasFutureEnrollments: false,
          futureEnrollmentsAlreadyPaid: false,
          nextBillingDate: null,
          futureEffectiveDate: null
        }
      });
    }
    
    console.log(`✅ Found ${futureEnrollments.length} future enrollments`);
    
    // Check for payment (oe.Payments uses HouseholdId, not MemberId!)
    const paymentQuery = `
      SELECT TOP 1
        p.PaymentId,
        p.RecurringScheduleId,
        p.NextBillingDate,
        p.Amount,
        p.Status
      FROM oe.Payments p
      WHERE p.HouseholdId = @householdId
        AND p.Status IN ('succeeded', 'APPROVAL', 'Completed')
      ORDER BY p.CreatedDate DESC
    `;
    
    const paymentResult = await pool.request()
      .input('householdId', sql.UniqueIdentifier, member.HouseholdId)
      .query(paymentQuery);
    
    let futureEnrollmentsAlreadyPaid = false;
    let nextBillingDate = null;
    
    if (paymentResult.recordset.length > 0) {
      const payment = paymentResult.recordset[0];
      
      console.log('💰 Found payment record:', {
        status: payment.Status,
        amount: payment.Amount,
        hasRecurringSchedule: !!payment.RecurringScheduleId,
        nextBillingDate: payment.NextBillingDate
      });
      
      // Check if recurring schedule exists AND next billing date exists
      if (payment.RecurringScheduleId && payment.NextBillingDate) {
        nextBillingDate = payment.NextBillingDate;
        const futureEffectiveDate = new Date(futureEnrollments[0].EffectiveDate);
        const nextBilling = new Date(nextBillingDate);
        
        // If next billing date is AFTER the effective date, it means first month is already paid
        futureEnrollmentsAlreadyPaid = nextBilling > futureEffectiveDate;
        
        console.log('🔍 Payment status check:', {
          nextBillingDate: nextBilling.toISOString().split('T')[0],
          futureEffectiveDate: futureEffectiveDate.toISOString().split('T')[0],
          futureEnrollmentsAlreadyPaid
        });
      } else {
        // Payment exists but no recurring schedule - first month IS paid, recurring not set up yet
        console.log('⚠️ Payment exists but no recurring schedule - treating as PAID');
        futureEnrollmentsAlreadyPaid = true;
      }
    } else {
      console.log('⚠️ No payment found for household');
    }
    
    return res.json({
      success: true,
      data: {
        hasFutureEnrollments: true,
        futureEnrollmentsAlreadyPaid,
        nextBillingDate: nextBillingDate ? new Date(nextBillingDate).toISOString().split('T')[0] : null,
        futureEffectiveDate: futureEnrollments[0].EffectiveDate,
        futureEnrollmentsCount: futureEnrollments.length
      }
    });
    
  } catch (error) {
    console.error('❌ Error checking future payment status:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to check payment status',
      message: error.message
    });
  }
});

module.exports = router;

