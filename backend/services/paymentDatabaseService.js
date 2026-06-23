const sql = require('mssql');
const { getPool } = require('../config/database');
const { requireShared } = require('../config/shared-modules');
const {
  buildHouseholdProductSnapshots,
  getHouseholdFeeBucketsAsOf,
  householdAsOfDate
} = requireShared('payment-product-snapshots');

/**
 * Payment Database Service
 * Handles all database operations for individual enrollment payments
 */
class PaymentDatabaseService {
  /**
   * Store payment record in database
   * @param {Object} paymentData - Payment data to store
   * @param {Object} transaction - Optional transaction object
   * @returns {Promise<Object>} Stored payment record
   */
  static async storePaymentRecord(paymentData, transaction = null) {
    try {
      const { enrollmentId, householdId, amount, status, paymentMethod, processorTransactionId, processorTransactionInfoId, processorResponse, paymentDate, processingFeeAmount, setupFee, failureReason, invoiceId, createdBy } = paymentData;
      let asOfDate = paymentDate || new Date();

      // For household (individual) payments, enrollments are often effective next month. Use end of next month
      // so bucket and JSON aggregation include them (same logic as paymentAudit.service.js).
      if (householdId && !paymentData.groupId) {
        const d = asOfDate instanceof Date ? new Date(asOfDate.getTime()) : new Date(asOfDate);
        const y = d.getUTCFullYear();
        const m = d.getUTCMonth();
        asOfDate = new Date(Date.UTC(y, m + 2, 0));
      }

      // Get AgentId, TenantId from enrollment if enrollmentId provided
      let agentId = paymentData.agentId || null;
      let tenantId = paymentData.tenantId || null;
      
      if (enrollmentId && !agentId) {
        try {
          const pool = await getPool();
          const enrollmentRequest = transaction ? transaction.request() : pool.request();
          enrollmentRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
          const enrollmentResult = await enrollmentRequest.query(`
            SELECT 
              e.AgentId,
              COALESCE(g.TenantId, p.ProductOwnerId) as TenantId
            FROM oe.Enrollments e
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            WHERE e.EnrollmentId = @enrollmentId
          `);
          if (enrollmentResult.recordset.length > 0) {
            agentId = enrollmentResult.recordset[0].AgentId || null;
            tenantId = enrollmentResult.recordset[0].TenantId || tenantId || null;
          }
        } catch (e) {
          console.warn('⚠️ Could not get enrollment data for payment:', e.message);
        }
      }
      
      // Aggregate pricing fields from active enrollments in the household
      // New field names: Commission (agent pool), OverrideRate, NetRate, SystemFees
      let commission = paymentData.commission || 0;
      let overrideRate = paymentData.overrideRate || 0;
      let netRate = paymentData.netRate || 0;
      let systemFees = paymentData.systemFees != null && paymentData.systemFees !== ''
        ? Number(paymentData.systemFees) || 0
        : null;
      let productCommissionsJSON = paymentData.productCommissions || null;
      
      // If not provided, aggregate from enrollments in household (active at payment date; do not use Status)
      if (
        householdId &&
        paymentData.commission == null &&
        paymentData.overrideRate == null &&
        paymentData.netRate == null
      ) {
        try {
          const pool = await getPool();
          const enrollmentRequest = transaction ? transaction.request() : pool.request();
          enrollmentRequest.input('householdId', sql.UniqueIdentifier, householdId);
          enrollmentRequest.input('asOfDate', sql.DateTime, asOfDate);
          const enrollmentResult = await enrollmentRequest.query(`
            SELECT 
              SUM(COALESCE(e.Commission, 0)) as Commission,
              SUM(COALESCE(e.OverrideRate, 0)) as OverrideRate,
              SUM(COALESCE(e.NetRate, 0)) as NetRate
            FROM oe.Enrollments e
            WHERE e.HouseholdId = @householdId
              AND e.EffectiveDate <= @asOfDate
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
              AND e.Commission IS NOT NULL
          `);
          
          if (enrollmentResult.recordset.length > 0 && enrollmentResult.recordset[0].Commission !== null) {
            commission = Number(enrollmentResult.recordset[0].Commission) || 0;
            overrideRate = Number(enrollmentResult.recordset[0].OverrideRate) || 0;
            netRate = Number(enrollmentResult.recordset[0].NetRate) || 0;
          }
        } catch (e) {
          console.warn('⚠️ Could not aggregate pricing fields from enrollments for payment:', e.message);
        }
      }

      // Build ProductCommissions, ProductVendorAmounts, and ProductOwnerAmounts JSON from enrollments if not provided
      let productVendorAmountsJSON = paymentData.productVendorAmounts || null;
      let productOwnerAmountsJSON = paymentData.productOwnerAmounts || null;
      
      if ((!productCommissionsJSON || !productVendorAmountsJSON || !productOwnerAmountsJSON) && householdId) {
        try {
          const pool = await getPool();
          const executor = transaction || pool;
          const built = await buildHouseholdProductSnapshots(executor, householdId, asOfDate, null);
          if (built) {
            if (!productCommissionsJSON) productCommissionsJSON = built.productCommissionsJSON;
            if (!productVendorAmountsJSON) productVendorAmountsJSON = built.productVendorAmountsJSON;
            if (!productOwnerAmountsJSON) productOwnerAmountsJSON = built.productOwnerAmountsJSON;
          }
        } catch (e) {
          console.warn('⚠️ Could not build ProductCommissions/VendorAmounts/OwnerAmounts JSON from enrollments:', e.message);
        }
      }

      // Fill fee buckets from dedicated fee enrollment rows (SystemFee / PaymentProcessingFee / SetupFee)
      // using the same as-of logic as payment audit and webhook processing.
      let resolvedProcessingFeeAmount =
        processingFeeAmount != null && processingFeeAmount !== '' ? Number(processingFeeAmount) || 0 : null;
      let resolvedSetupFee = setupFee != null && setupFee !== '' ? Number(setupFee) || 0 : null;
      if (householdId && (systemFees == null || resolvedProcessingFeeAmount == null || resolvedSetupFee == null)) {
        try {
          const pool = await getPool();
          const feeAsOfDate = asOfDate || householdAsOfDate(paymentDate) || new Date();
          const feeBuckets = await getHouseholdFeeBucketsAsOf(pool, householdId, feeAsOfDate, sql);
          if (systemFees == null) systemFees = Number(feeBuckets.systemFees) || 0;
          if (resolvedProcessingFeeAmount == null) resolvedProcessingFeeAmount = Number(feeBuckets.processingFeeAmount) || 0;
          if (resolvedSetupFee == null) resolvedSetupFee = Number(feeBuckets.setupFee) || 0;
        } catch (e) {
          console.warn('⚠️ Could not aggregate fee buckets from enrollments:', e.message);
        }
      }
      if (systemFees == null) systemFees = 0;
      if (resolvedProcessingFeeAmount == null) resolvedProcessingFeeAmount = 0;
      if (resolvedSetupFee == null) resolvedSetupFee = 0;
      
      const paymentId = require('crypto').randomUUID();
      
      const query = `
        INSERT INTO oe.Payments (
          PaymentId, EnrollmentId, AgentId, TenantId, HouseholdId, Amount, Status, PaymentMethod, 
          ProcessorTransactionId, ProcessorTransactionInfoId, ProcessorResponse, FailureReason, Commission, OverrideRate, NetRate, SystemFees, ProcessingFeeAmount, SetupFee, ProductCommissions,
          ProductVendorAmounts, ProductOwnerAmounts,
          InvoiceId, PaymentDate, CreatedBy, ModifiedBy, CreatedDate, ModifiedDate
        ) 
        VALUES (@paymentId, @enrollmentId, @agentId, @tenantId, @householdId, @amount, @status, @paymentMethod, @processorTransactionId, @processorTransactionInfoId, @processorResponse, @failureReason, @commission, @overrideRate, @netRate, @systemFees, @processingFeeAmount, @setupFee, @productCommissions, @productVendorAmounts, @productOwnerAmounts, @invoiceId, @paymentDate, @createdBy, @createdBy, GETDATE(), GETDATE())
      `;
      
      const resolvedInvoiceId = invoiceId || null;

      let result;
      if (transaction) {
        // Use existing transaction
        result = await transaction.request()
          .input('paymentId', sql.UniqueIdentifier, paymentId)
          .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
          .input('agentId', sql.UniqueIdentifier, agentId)
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('householdId', sql.UniqueIdentifier, householdId)
          .input('amount', sql.Decimal(10, 2), amount) // Amount is already in dollars (includes processing fee if applicable)
          .input('status', sql.NVarChar(50), status)
          .input('paymentMethod', sql.NVarChar(50), paymentMethod)
          .input('processorTransactionId', sql.NVarChar(255), processorTransactionId)
          .input('processorTransactionInfoId', sql.NVarChar(255), processorTransactionInfoId || null)
          .input('processorResponse', sql.NText, processorResponse)
          .input('failureReason', sql.NVarChar(sql.MAX), failureReason != null ? String(failureReason) : null)
          .input('commission', sql.Decimal(18, 2), commission)
          .input('overrideRate', sql.Decimal(18, 2), overrideRate)
          .input('netRate', sql.Decimal(18, 2), netRate)
          .input('systemFees', sql.Decimal(18, 2), systemFees)
          .input('processingFeeAmount', sql.Decimal(10, 2), resolvedProcessingFeeAmount)
          .input('setupFee', sql.Decimal(18, 2), resolvedSetupFee)
          .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
          .input('productVendorAmounts', sql.NVarChar(sql.MAX), productVendorAmountsJSON)
          .input('productOwnerAmounts', sql.NVarChar(sql.MAX), productOwnerAmountsJSON)
          .input('invoiceId', sql.UniqueIdentifier, resolvedInvoiceId)
          .input('paymentDate', sql.DateTime, paymentDate)
          .input('createdBy', sql.UniqueIdentifier, createdBy || null)
          .query(query);
      } else {
        // Create new connection
        const pool = await getPool();
        result = await pool.request()
          .input('paymentId', sql.UniqueIdentifier, paymentId)
          .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
          .input('agentId', sql.UniqueIdentifier, agentId)
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('householdId', sql.UniqueIdentifier, householdId)
          .input('amount', sql.Decimal(10, 2), amount) // Amount is already in dollars (includes processing fee if applicable)
          .input('status', sql.NVarChar(50), status)
          .input('paymentMethod', sql.NVarChar(50), paymentMethod)
          .input('processorTransactionId', sql.NVarChar(255), processorTransactionId)
          .input('processorTransactionInfoId', sql.NVarChar(255), processorTransactionInfoId || null)
          .input('processorResponse', sql.NText, processorResponse)
          .input('failureReason', sql.NVarChar(sql.MAX), failureReason != null ? String(failureReason) : null)
          .input('commission', sql.Decimal(18, 2), commission)
          .input('overrideRate', sql.Decimal(18, 2), overrideRate)
          .input('netRate', sql.Decimal(18, 2), netRate)
          .input('systemFees', sql.Decimal(18, 2), systemFees)
          .input('processingFeeAmount', sql.Decimal(10, 2), resolvedProcessingFeeAmount)
          .input('setupFee', sql.Decimal(18, 2), resolvedSetupFee)
          .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
          .input('productVendorAmounts', sql.NVarChar(sql.MAX), productVendorAmountsJSON)
          .input('productOwnerAmounts', sql.NVarChar(sql.MAX), productOwnerAmountsJSON)
          .input('invoiceId', sql.UniqueIdentifier, resolvedInvoiceId)
          .input('paymentDate', sql.DateTime, paymentDate)
          .input('createdBy', sql.UniqueIdentifier, createdBy || null)
          .query(query);
      }
      
      // Return the paymentId since we can't use OUTPUT clause with triggers
      return { 
        PaymentId: paymentId, 
        HouseholdId: householdId, 
        Amount: amount, 
        Status: status 
      };
    } catch (error) {
      console.error('❌ Error storing payment record:', error);
      throw error;
    }
  }

  /**
   * Update payment record with recurring schedule info
   * @param {Object} updateData - Update data
   * @param {Object} transaction - Optional transaction object
   * @returns {Promise<void>}
   */
  static async updatePaymentRecord(updateData, transaction = null) {
    try {
      const { householdId, recurringScheduleId, nextBillingDate } = updateData;
      
      console.log('🔍 DEBUG: updatePaymentRecord called with:', {
        householdId,
        recurringScheduleId,
        nextBillingDate,
        hasTransaction: !!transaction
      });
      
      // Include 'Pending': ACH (and some card) enrollment charges are stored as Pending while DIME
      // settlement is in flight, even when status_code is 00 / recurring was created successfully.
      const query = `
        UPDATE TOP (1) oe.Payments 
        SET RecurringScheduleId = @recurringScheduleId, 
            NextBillingDate = @nextBillingDate, 
            ModifiedDate = GETDATE()
        WHERE PaymentId = (
          SELECT TOP 1 PaymentId
          FROM oe.Payments
          WHERE HouseholdId = @householdId 
            AND Status IN ('succeeded', 'APPROVAL', 'Completed', 'Pending')
            AND RecurringScheduleId IS NULL
          ORDER BY PaymentDate DESC
        )
      `;
      
      let result;
      if (transaction) {
        result = await transaction.request()
          .input('recurringScheduleId', sql.NVarChar(255), recurringScheduleId)
          .input('nextBillingDate', sql.DateTime, nextBillingDate)
          .input('householdId', sql.UniqueIdentifier, householdId)
          .query(query);
      } else {
        const pool = await getPool();
        result = await pool.request()
          .input('recurringScheduleId', sql.NVarChar(255), recurringScheduleId)
          .input('nextBillingDate', sql.DateTime, nextBillingDate)
          .input('householdId', sql.UniqueIdentifier, householdId)
          .query(query);
      }
      
      console.log('✅ DEBUG: Payment record updated. Rows affected:', result.rowsAffected);
      if (result.rowsAffected[0] === 0) {
        console.warn('⚠️ DEBUG: No payment record was updated! Rows affected:', result.rowsAffected);
      }
      
      return result;
    } catch (error) {
      console.error('❌ Error updating payment record:', error);
      throw error;
    }
  }

  /**
   * Force-set recurring schedule info on the latest successful payment record.
   * This is used for recurring schedule changes that happen without creating a new payment.
   *
   * NOTE: This intentionally does NOT require RecurringScheduleId to be NULL.
   */
  static async setLatestSuccessfulRecurringSchedule(updateData, transaction = null) {
    try {
      const { householdId, recurringScheduleId, nextBillingDate } = updateData;

      console.log('🔍 DEBUG: setLatestSuccessfulRecurringSchedule called with:', {
        householdId,
        recurringScheduleId,
        nextBillingDate,
        hasTransaction: !!transaction
      });

      const query = `
        UPDATE oe.Payments
        SET RecurringScheduleId = @recurringScheduleId,
            NextBillingDate = @nextBillingDate,
            ModifiedDate = GETDATE()
        WHERE PaymentId = (
          SELECT TOP 1 PaymentId
          FROM oe.Payments
          WHERE HouseholdId = @householdId
            AND Status IN ('succeeded', 'APPROVAL', 'Completed', 'Pending')
          ORDER BY PaymentDate DESC
        )
      `;

      let result;
      if (transaction) {
        result = await transaction.request()
          .input('recurringScheduleId', sql.NVarChar(255), recurringScheduleId)
          .input('nextBillingDate', sql.DateTime, nextBillingDate)
          .input('householdId', sql.UniqueIdentifier, householdId)
          .query(query);
      } else {
        const pool = await getPool();
        result = await pool.request()
          .input('recurringScheduleId', sql.NVarChar(255), recurringScheduleId)
          .input('nextBillingDate', sql.DateTime, nextBillingDate)
          .input('householdId', sql.UniqueIdentifier, householdId)
          .query(query);
      }

      console.log('✅ DEBUG: setLatestSuccessfulRecurringSchedule updated. Rows affected:', result.rowsAffected);
      if (result.rowsAffected[0] === 0) {
        console.warn('⚠️ DEBUG: No successful payment record found to update for recurring schedule');
      }

      return result;
    } catch (error) {
      console.error('❌ Error setting latest successful recurring schedule:', error);
      throw error;
    }
  }

  /**
   * Cancel every DIME recurring schedule we know about for this household except `exceptScheduleId`
   * (typically the schedule just created). Mirrors setup-recurring in routes/payments.js.
   * Updates oe.IndividualRecurringSchedules and clears RecurringScheduleId on oe.Payments for successes only.
   *
   * @param {Object} params
   * @param {string} params.householdId
   * @param {string} params.tenantId
   * @param {string|null} [params.exceptScheduleId] - Skip this DIME id (new schedule). Null = cancel all found.
   * @returns {Promise<{ cancelled: string[], cancelFailures: Array<{ scheduleId: string, error: string }> }>}
   */
  static async cancelAllActiveRecurringSchedulesExcept({ householdId, tenantId, exceptScheduleId = null }) {
    const DimeService = require('./dimeService');
    const pool = await getPool();
    const except =
      exceptScheduleId != null && String(exceptScheduleId).trim() !== ''
        ? String(exceptScheduleId).trim()
        : null;
    const toCancel = [];
    try {
      const existingFromTable = await pool
        .request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(`
          SELECT DimeScheduleId, MonthlyAmount, NextBillingDate
          FROM oe.IndividualRecurringSchedules
          WHERE HouseholdId = @householdId AND IsActive = 1
        `);
      for (const r of existingFromTable.recordset || []) {
        const sid = String(r.DimeScheduleId);
        if (except && sid === except) continue;
        toCancel.push({ scheduleId: sid, amount: r.MonthlyAmount, nextBillingDate: r.NextBillingDate });
      }
    } catch (tableErr) {
      if (!String(tableErr.message || '').includes('IndividualRecurringSchedules')) {
        console.warn('⚠️ cancelAllActiveRecurringSchedulesExcept: IndividualRecurringSchedules query failed:', tableErr.message);
      }
    }

    const existingFromPayments = await pool
      .request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT DISTINCT p.RecurringScheduleId, p.Amount, p.NextBillingDate
        FROM oe.Payments p
        WHERE p.HouseholdId = @householdId AND p.RecurringScheduleId IS NOT NULL
      `);
    for (const r of existingFromPayments.recordset || []) {
      const sid = String(r.RecurringScheduleId);
      if (except && sid === except) continue;
      if (!toCancel.some((x) => String(x.scheduleId) === sid)) {
        toCancel.push({ scheduleId: sid, amount: r.Amount, nextBillingDate: r.NextBillingDate });
      }
    }

    const successfullyCancelledIds = [];
    const cancelFailures = [];

    for (const { scheduleId, amount, nextBillingDate } of toCancel) {
      const cancelResult = await DimeService.cancelRecurringPayment(String(scheduleId), tenantId);
      if (cancelResult.success || cancelResult.wasAlreadyCanceled) {
        successfullyCancelledIds.push(String(scheduleId));
        try {
          const updateResult = await pool
            .request()
            .input('householdId', sql.UniqueIdentifier, householdId)
            .input('dimeScheduleId', sql.NVarChar(255), String(scheduleId))
            .query(`
              UPDATE oe.IndividualRecurringSchedules
              SET IsActive = 0, CancelledDate = GETUTCDATE(), ModifiedDate = GETUTCDATE()
              WHERE HouseholdId = @householdId AND DimeScheduleId = @dimeScheduleId
            `);
          if (updateResult.rowsAffected[0] === 0 && tenantId) {
            await pool
              .request()
              .input('householdId', sql.UniqueIdentifier, householdId)
              .input('tenantId', sql.UniqueIdentifier, tenantId)
              .input('dimeScheduleId', sql.NVarChar(255), String(scheduleId))
              .input('monthlyAmount', sql.Decimal(10, 2), amount || 0)
              .input('nextBillingDate', sql.DateTime2, nextBillingDate || new Date())
              .query(`
                INSERT INTO oe.IndividualRecurringSchedules (HouseholdId, TenantId, DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, CancelledDate, CreatedDate, ModifiedDate)
                VALUES (@householdId, @tenantId, @dimeScheduleId, @monthlyAmount, @nextBillingDate, 0, GETUTCDATE(), GETUTCDATE(), GETUTCDATE())
              `);
          }
        } catch (tableErr) {
          if (!String(tableErr.message || '').includes('IndividualRecurringSchedules')) {
            console.warn('⚠️ cancelAllActiveRecurringSchedulesExcept: IndividualRecurringSchedules update failed:', tableErr.message);
          }
        }
      } else {
        cancelFailures.push({
          scheduleId: String(scheduleId),
          error: cancelResult.error || 'Unknown error'
        });
      }
    }

    for (const sid of successfullyCancelledIds) {
      await pool
        .request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .input('scheduleId', sql.NVarChar(255), sid)
        .query(`
          UPDATE oe.Payments
          SET RecurringScheduleId = NULL, NextBillingDate = NULL, ModifiedDate = GETUTCDATE()
          WHERE HouseholdId = @householdId AND RecurringScheduleId = @scheduleId
        `);
    }

    return { cancelled: successfullyCancelledIds, cancelFailures };
  }

  /**
   * Canonical row for "this household has this DIME recurring schedule" (source of truth for schedule metadata).
   * Safe to call repeatedly (IF NOT EXISTS).
   */
  static async ensureIndividualRecurringScheduleRow({
    householdId,
    tenantId,
    dimeScheduleId,
    monthlyAmount,
    nextBillingDate,
    isActive = true
  }) {
    const pool = await getPool();
    const sid = String(dimeScheduleId);
    const roundedAmount = Math.round(Number(monthlyAmount) * 100) / 100;
    const nextBd =
      nextBillingDate instanceof Date ? nextBillingDate : new Date(nextBillingDate);

    try {
      await pool
        .request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('dimeScheduleId', sql.NVarChar(255), sid)
        .input('monthlyAmount', sql.Decimal(10, 2), roundedAmount)
        .input('nextBillingDate', sql.DateTime2, nextBd)
        .input('isActive', sql.Bit, isActive ? 1 : 0)
        .query(`
          IF NOT EXISTS (
            SELECT 1 FROM oe.IndividualRecurringSchedules
            WHERE HouseholdId = @householdId AND DimeScheduleId = @dimeScheduleId
          )
          INSERT INTO oe.IndividualRecurringSchedules (HouseholdId, TenantId, DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, CreatedDate, ModifiedDate)
          VALUES (@householdId, @tenantId, @dimeScheduleId, @monthlyAmount, @nextBillingDate, @isActive, GETUTCDATE(), GETUTCDATE())
        `);
    } catch (e) {
      if (!String(e.message || '').includes('IndividualRecurringSchedules')) {
        throw e;
      }
      console.warn('⚠️ ensureIndividualRecurringScheduleRow skipped:', e.message);
    }
  }

  /**
   * Lazy repair: insert missing oe.IndividualRecurringSchedules rows from oe.Payments for one household.
   * Idempotent; run before listing recurring schedules so legacy Payments-only data appears in IRS.
   */
  static async syncMissingIndividualRecurringSchedulesForHousehold(householdId) {
    const pool = await getPool();
    try {
      await pool
        .request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(`
          INSERT INTO oe.IndividualRecurringSchedules (HouseholdId, TenantId, DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, CreatedDate, ModifiedDate)
          SELECT src.HouseholdId, src.TenantId, CAST(src.RecurringScheduleId AS NVARCHAR(255)), src.Amount, src.NextBillingDate, 1, GETUTCDATE(), GETUTCDATE()
          FROM (
            SELECT p.HouseholdId, p.TenantId, p.RecurringScheduleId, p.Amount, p.NextBillingDate,
                   ROW_NUMBER() OVER (PARTITION BY p.HouseholdId, p.RecurringScheduleId ORDER BY p.PaymentDate DESC) AS rn
            FROM oe.Payments p
            WHERE p.HouseholdId = @householdId
              AND p.RecurringScheduleId IS NOT NULL
              AND p.TenantId IS NOT NULL
              AND p.Status IN (N'succeeded', N'APPROVAL', N'Completed', N'Pending', N'RecurringScheduled')
          ) src
          WHERE src.rn = 1
            AND NOT EXISTS (
              SELECT 1 FROM oe.IndividualRecurringSchedules irs
              WHERE irs.HouseholdId = src.HouseholdId
                AND irs.DimeScheduleId = CAST(src.RecurringScheduleId AS NVARCHAR(255))
            )
        `);
    } catch (e) {
      if (!String(e.message || '').includes('IndividualRecurringSchedules')) {
        throw e;
      }
      console.warn('⚠️ syncMissingIndividualRecurringSchedulesForHousehold skipped:', e.message);
    }
  }

  /**
   * Insert a placeholder payment row when recurring is set up but no successful payment exists yet.
   * Used for "enrolled but never paid" households so the recurring schedule shows in our DB/UI.
   */
  static async insertRecurringSchedulePlaceholder(insertData, transaction = null) {
    try {
      const { householdId, recurringScheduleId, nextBillingDate, amount, tenantId, agentId } = insertData;
      const paymentId = require('crypto').randomUUID();
      const pool = transaction || await getPool();

      let resolvedAgentId = agentId;
      let resolvedTenantId = tenantId;
      if (!resolvedAgentId || !resolvedTenantId) {
        const memberReq = transaction ? transaction.request() : pool.request();
        const memberResult = await memberReq.input('householdId', sql.UniqueIdentifier, householdId).query(`
          SELECT m.AgentId, u.TenantId
          FROM oe.Members m
          INNER JOIN oe.Users u ON m.UserId = u.UserId
          WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
        `);
        const row = memberResult.recordset?.[0];
        if (row) {
          resolvedAgentId = resolvedAgentId || row.AgentId;
          resolvedTenantId = resolvedTenantId || row.TenantId;
        }
      }

      if (resolvedTenantId) {
        await PaymentDatabaseService.ensureIndividualRecurringScheduleRow({
          householdId,
          tenantId: resolvedTenantId,
          dimeScheduleId: recurringScheduleId,
          monthlyAmount: amount,
          nextBillingDate
        });
      }

      const insertReq = transaction ? transaction.request() : pool.request();
      await insertReq
        .input('paymentId', sql.UniqueIdentifier, paymentId)
        .input('householdId', sql.UniqueIdentifier, householdId)
        .input('amount', sql.Decimal(10, 2), amount)
        .input('recurringScheduleId', sql.NVarChar(255), recurringScheduleId)
        .input('nextBillingDate', sql.DateTime, nextBillingDate)
        .input('agentId', sql.UniqueIdentifier, resolvedAgentId)
        .input('tenantId', sql.UniqueIdentifier, resolvedTenantId)
        .query(`
          INSERT INTO oe.Payments (
            PaymentId, HouseholdId, AgentId, TenantId, Amount, Status, PaymentMethod,
            RecurringScheduleId, NextBillingDate, PaymentDate, CreatedDate, ModifiedDate
          ) VALUES (
            @paymentId, @householdId, @agentId, @tenantId, @amount, 'RecurringScheduled', 'dime',
            @recurringScheduleId, @nextBillingDate, @nextBillingDate, GETUTCDATE(), GETUTCDATE()
          )
        `);

      console.log('✅ insertRecurringSchedulePlaceholder: created payment row for household', householdId);
      return { PaymentId: paymentId };
    } catch (error) {
      console.error('❌ Error inserting recurring schedule placeholder:', error);
      throw error;
    }
  }

  /**
   * After DIME creates a recurring schedule (e.g. complete-enrollment post-commit), persist schedule id on
   * oe.Payments and insert oe.IndividualRecurringSchedules. ACH initial charges often stay Pending for days;
   * we still attach RecurringScheduleId and track the schedule locally.
   *
   * @param {Object} params
   * @param {string} params.householdId
   * @param {string} params.tenantId
   * @param {string|number} params.recurringScheduleId - DIME schedule id
   * @param {Date|string} params.nextBillingDate
   * @param {number} params.monthlyAmount
   */
  static async persistRecurringScheduleAfterDimeSetup({
    householdId,
    tenantId,
    recurringScheduleId,
    nextBillingDate,
    monthlyAmount
  }) {
    const pool = await getPool();
    const sid = String(recurringScheduleId);
    const roundedAmount = Math.round(Number(monthlyAmount) * 100) / 100;
    const nextBd =
      nextBillingDate instanceof Date ? nextBillingDate : new Date(nextBillingDate);

    await PaymentDatabaseService.ensureIndividualRecurringScheduleRow({
      householdId,
      tenantId,
      dimeScheduleId: sid,
      monthlyAmount: roundedAmount,
      nextBillingDate: nextBd
    });

    let result = await this.updatePaymentRecord({
      householdId,
      recurringScheduleId: sid,
      nextBillingDate: nextBd
    });
    if (!result.rowsAffected || result.rowsAffected[0] === 0) {
      result = await this.setLatestSuccessfulRecurringSchedule({
        householdId,
        recurringScheduleId: sid,
        nextBillingDate: nextBd
      });
    }
    if (!result.rowsAffected || result.rowsAffected[0] === 0) {
      await this.insertRecurringSchedulePlaceholder({
        householdId,
        recurringScheduleId: sid,
        nextBillingDate: nextBd,
        amount: roundedAmount,
        tenantId
      });
    }
    return result;
  }

  /**
   * Get payment status for household
   * @param {string} householdId - Household ID
   * @returns {Promise<Object>} Payment status
   */
  static async getHouseholdPaymentStatus(householdId) {
    try {
      const query = `
        SELECT TOP 1 
          PaymentId, Amount, Status, PaymentMethod, 
          ProcessorTransactionId, PaymentDate, NextBillingDate,
          RecurringScheduleId
        FROM oe.Payments 
        WHERE HouseholdId = @householdId 
        ORDER BY CreatedDate DESC
      `;
      
      const pool = await getPool();
      const result = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(query);
      
      if (result.recordset.length > 0) {
        return {
          success: true,
          payment: result.recordset[0]
        };
      } else {
        return {
          success: true,
          payment: null
        };
      }
    } catch (error) {
      console.error('❌ Error getting payment status:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get household ID for a member
   * @param {string} memberId - Member ID
   * @returns {Promise<Object>} Household ID
   */
  static async getHouseholdIdForMember(memberId) {
    try {
      const query = `
        SELECT HouseholdId 
        FROM oe.Members 
        WHERE MemberId = @memberId
      `;
      
      const pool = await getPool();
      const result = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(query);
      
      if (result.recordset.length > 0) {
        return {
          success: true,
          householdId: result.recordset[0].HouseholdId
        };
      } else {
        return {
          success: false,
          error: 'Member not found'
        };
      }
    } catch (error) {
      console.error('❌ Error getting household ID for member:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Calculate total premium amount for household enrollments
   * @param {string} householdId - Household ID
   * @returns {Promise<Object>} Total premium amount
   */
  static async getHouseholdTotalPremium(householdId) {
    try {
      const query = `
        SELECT SUM(e.PremiumAmount) as TotalPremium
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.HouseholdId = @householdId
        AND e.Status = 'Active'
      `;
      
      const pool = await getPool();
      const result = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(query);
      
      const totalPremium = result.recordset[0].TotalPremium || 0;
      
      return {
        success: true,
        totalPremium: Math.round(totalPremium * 100) // Convert to cents
      };
    } catch (error) {
      console.error('❌ Error calculating household total premium:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get effective date for household enrollments
   * @param {string} householdId - Household ID
   * @returns {Promise<Object>} Effective date
   */
  static async getHouseholdEffectiveDate(householdId) {
    try {
      const query = `
        SELECT MIN(e.EffectiveDate) as EffectiveDate
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.HouseholdId = @householdId
        AND e.Status = 'Active'
      `;
      
      const pool = await getPool();
      const result = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(query);
      
      const effectiveDate = result.recordset[0].EffectiveDate;
      
      return {
        success: true,
        effectiveDate: effectiveDate
      };
    } catch (error) {
      console.error('❌ Error getting household effective date:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = PaymentDatabaseService;
