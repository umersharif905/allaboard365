// services/commissionService.js - Complete Commission Service Implementation
const { getPool, sql } = require('../config/database');
const logger = require('../config/logger');

class CommissionService {
  
  /**
   * Get commission hierarchy for an agent
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Commission hierarchy
   */
  async getCommissionHierarchy(agentId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      request.input('AgentId', sql.UniqueIdentifier, agentId);
      
      const result = await request.query(`
        WITH CommissionHierarchy AS (
          SELECT 
            ah.AgentId,
            ah.ParentId,
            ah.ParentType,
            ah.TierLevel,
            ah.OverridePercentage,
            u.FirstName + ' ' + u.LastName as AgentName,
            u.Email,
            0 as Level
          FROM oe.AgentHierarchy ah
          JOIN oe.Users u ON ah.AgentId = u.UserId
          WHERE ah.AgentId = @AgentId
          
          UNION ALL
          
          SELECT 
            ah.AgentId,
            ah.ParentId,
            ah.ParentType,
            ah.TierLevel,
            ah.OverridePercentage,
            u.FirstName + ' ' + u.LastName as AgentName,
            u.Email,
            h.Level + 1
          FROM oe.AgentHierarchy ah
          JOIN oe.Users u ON ah.AgentId = u.UserId
          JOIN CommissionHierarchy h ON ah.ParentId = h.AgentId
          WHERE h.Level < 10
        )
        SELECT 
          AgentId,
          ParentId,
          ParentType,
          TierLevel,
          OverridePercentage,
          AgentName,
          Email,
          Level
        FROM CommissionHierarchy
        ORDER BY Level, AgentName
      `);
      
      return {
        agentId,
        hierarchy: result.recordset
      };
      
    } catch (error) {
      logger.error('Error getting commission hierarchy', { error: error.message, agentId }, 'Commission');
      throw error;
    }
  }

  /**
   * Get commission summary for entity
   * @param {string} entityType - Entity type (Agent, Agency, etc.)
   * @param {string} entityId - Entity ID
   * @param {string} period - Period (current, ytd, etc.)
   * @returns {Promise<Object>} Commission summary
   */
  async getCommissionSummary(entityType, entityId, period = 'current') {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      request.input('EntityType', sql.NVarChar(20), entityType);
      request.input('EntityId', sql.UniqueIdentifier, entityId);
      
      // Build date filter based on period
      let dateFilter = '';
      if (period === 'current') {
        dateFilter = 'AND YEAR(cl.PaymentPeriod) = YEAR(GETDATE()) AND MONTH(cl.PaymentPeriod) = MONTH(GETDATE())';
      } else if (period === 'ytd') {
        dateFilter = 'AND YEAR(cl.PaymentPeriod) = YEAR(GETDATE())';
      } else if (period === 'last30') {
        dateFilter = 'AND cl.CreatedDate >= DATEADD(DAY, -30, GETDATE())';
      }
      
      const result = await request.query(`
        SELECT 
          COUNT(*) as TotalCommissions,
          SUM(CASE WHEN cl.PaymentStatus = 'Paid' THEN cl.CommissionAmount ELSE 0 END) as TotalPaid,
          SUM(CASE WHEN cl.PaymentStatus IN ('Pending', 'Hold') THEN cl.CommissionAmount ELSE 0 END) as TotalPending,
          SUM(cl.CommissionAmount) as TotalCommissionAmount,
          AVG(cl.CommissionAmount) as AverageCommission,
          COUNT(DISTINCT cl.AgentId) as ActiveAgents
        FROM oe.CommissionLogs cl
        WHERE cl.BeneficiaryType = @EntityType 
          AND cl.BeneficiaryId = @EntityId
          ${dateFilter}
      `);
      
      const summary = result.recordset[0];
      
      return {
        totalCommissions: summary.TotalCommissions || 0,
        totalPaid: summary.TotalPaid || 0,
        totalPending: summary.TotalPending || 0,
        totalCommissionAmount: summary.TotalCommissionAmount || 0,
        averageCommission: summary.AverageCommission || 0,
        activeAgents: summary.ActiveAgents || 0,
        period
      };
      
    } catch (error) {
      logger.error('Error getting commission summary', { error: error.message, entityType, entityId, period }, 'Commission');
      throw error;
    }
  }

  /**
   * Get commission statement for entity
   * @param {string} entityType - Entity type
   * @param {string} entityId - Entity ID
   * @param {string} startDate - Start date
   * @param {string} endDate - End date
   * @returns {Promise<Object>} Commission statement
   */
  async getCommissionStatement(entityType, entityId, startDate, endDate) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      request.input('EntityType', sql.NVarChar(20), entityType);
      request.input('EntityId', sql.UniqueIdentifier, entityId);
      request.input('StartDate', sql.Date, startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1));
      request.input('EndDate', sql.Date, endDate || new Date());
      
      const result = await request.query(`
        SELECT 
          cl.LogId,
          cl.CommissionId,
          cl.PaymentId,
          cl.PaymentPeriod,
          cl.CommissionType,
          cl.CommissionAmount,
          cl.PaymentStatus,
          cl.CalculationDate,
          cl.HoldUntilDate,
          cl.PremiumAmount,
          cl.CommissionRate,
          cl.Notes,
          p.ProductName,
          m.FirstName + ' ' + m.LastName as MemberName,
          a.FirstName + ' ' + a.LastName as AgentName
        FROM oe.CommissionLogs cl
        LEFT JOIN oe.Products p ON cl.ProductId = p.ProductId
        LEFT JOIN oe.Members m ON cl.MemberId = m.MemberId
        LEFT JOIN oe.Users a ON cl.AgentId = a.UserId
        WHERE cl.BeneficiaryType = @EntityType 
          AND cl.BeneficiaryId = @EntityId
          AND cl.PaymentPeriod >= @StartDate
          AND cl.PaymentPeriod <= @EndDate
        ORDER BY cl.PaymentPeriod DESC, cl.CreatedDate DESC
      `);
      
      return {
        entityType,
        entityId,
        startDate,
        endDate,
        records: result.recordset
      };
      
    } catch (error) {
      logger.error('Error getting commission statement', { error: error.message, entityType, entityId }, 'Commission');
      throw error;
    }
  }

  /**
   * Get upcoming commission payments
   * @param {string} entityType - Entity type
   * @param {string} entityId - Entity ID
   * @returns {Promise<Object>} Upcoming payments
   */
  async getUpcomingPayments(entityType, entityId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      request.input('EntityType', sql.NVarChar(20), entityType);
      request.input('EntityId', sql.UniqueIdentifier, entityId);
      
      const result = await request.query(`
        SELECT 
          cl.LogId,
          cl.CommissionId,
          cl.PaymentId,
          cl.PaymentPeriod,
          cl.CommissionType,
          cl.CommissionAmount,
          cl.PaymentStatus,
          cl.HoldUntilDate,
          cl.Notes,
          p.ProductName,
          m.FirstName + ' ' + m.LastName as MemberName,
          a.FirstName + ' ' + a.LastName as AgentName
        FROM oe.CommissionLogs cl
        LEFT JOIN oe.Products p ON cl.ProductId = p.ProductId
        LEFT JOIN oe.Members m ON cl.MemberId = m.MemberId
        LEFT JOIN oe.Users a ON cl.AgentId = a.UserId
        WHERE cl.BeneficiaryType = @EntityType 
          AND cl.BeneficiaryId = @EntityId
          AND cl.PaymentStatus IN ('Pending', 'Hold')
          AND cl.HoldUntilDate IS NOT NULL
        ORDER BY cl.HoldUntilDate ASC, cl.PaymentPeriod ASC
      `);
      
      return {
        entityType,
        entityId,
        upcomingPayments: result.recordset
      };
      
    } catch (error) {
      logger.error('Error getting upcoming payments', { error: error.message, entityType, entityId }, 'Commission');
      throw error;
    }
  }

  /**
   * Simulate commission calculation
   * @param {Object} simulationData - Simulation parameters
   * @returns {Promise<Object>} Simulation results
   */
  async simulateCommission(simulationData) {
    try {
      const { productId, premiumAmount, agentId } = simulationData;
      
      const pool = await getPool();
      const request = pool.request();
      
      request.input('ProductId', sql.UniqueIdentifier, productId);
      request.input('PremiumAmount', sql.Decimal(10, 2), premiumAmount);
      request.input('AgentId', sql.UniqueIdentifier, agentId);
      
      // Call stored procedure for commission calculation
      const result = await request.execute('oe.CalculateCommissionSimulation');
      
      return {
        productId,
        premiumAmount,
        agentId,
        simulation: result.recordset[0]
      };
      
    } catch (error) {
      logger.error('Error simulating commission', { error: error.message, simulationData }, 'Commission');
      throw error;
    }
  }

  /**
   * Process commission batch
   * @param {Date} paymentPeriod - Payment period
   * @param {Object} options - Processing options
   * @returns {Promise<Object>} Batch processing results
   */
  async processCommissionBatch(paymentPeriod, options = {}) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      const batchId = require('uuid').v4();
      
      request.input('BatchId', sql.UniqueIdentifier, batchId);
      request.input('PaymentPeriod', sql.Date, paymentPeriod);
      request.input('BatchType', sql.NVarChar(20), options.batchType || 'Regular');
      request.input('ProcessedBy', sql.UniqueIdentifier, options.processedBy);
      
      // Call stored procedure for batch processing
      const result = await request.execute('oe.ProcessCommissionBatch');
      
      return {
        batchId,
        paymentPeriod,
        batchType: options.batchType || 'Regular',
        processedCount: result.recordset[0]?.ProcessedCount || 0,
        totalAmount: result.recordset[0]?.TotalAmount || 0
      };
      
    } catch (error) {
      logger.error('Error processing commission batch', { error: error.message, paymentPeriod, options }, 'Commission');
      throw error;
    }
  }

  /**
   * Phase 2 — DEPRECATED: legacy chargeback stub.
   *
   * Replaced by CommissionService.clawBackForRefund() in
   * backend/services/commissionService.advances.js, which is invoked from
   * RefundService.processRefund() inside the unified refund transaction.
   *
   * This method now throws so any stale callers fail loudly instead of
   * invoking the dead `oe.ProcessCommissionChargeback` stored proc.
   */
  async processChargeback(paymentId, reason, processedBy) {
    logger.warn('Deprecated commissionService.processChargeback called', { paymentId, reason, processedBy }, 'Commission');
    throw new Error('Deprecated. Use RefundService.processRefund() — commission clawback runs automatically via clawBackForRefund.');
  }

  /**
   * Create manual commission adjustment
   * @param {Object} adjustmentData - Adjustment details
   * @returns {Promise<Object>} Created adjustment
   */
  async createCommissionAdjustment(adjustmentData) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      const {
        paymentId,
        memberId,
        productId,
        enrollmentId,
        agentId,
        beneficiaryType,
        beneficiaryId,
        amount,
        reason,
        createdBy
      } = adjustmentData;
      
      const logId = require('uuid').v4();
      const commissionId = require('uuid').v4();
      
      request.input('LogId', sql.UniqueIdentifier, logId);
      request.input('CommissionId', sql.UniqueIdentifier, commissionId);
      request.input('PaymentId', sql.UniqueIdentifier, paymentId);
      request.input('MemberId', sql.UniqueIdentifier, memberId);
      request.input('ProductId', sql.UniqueIdentifier, productId);
      request.input('EnrollmentId', sql.UniqueIdentifier, enrollmentId);
      request.input('AgentId', sql.UniqueIdentifier, agentId);
      request.input('BeneficiaryType', sql.NVarChar(20), beneficiaryType);
      request.input('BeneficiaryId', sql.UniqueIdentifier, beneficiaryId);
      request.input('CommissionAmount', sql.Decimal(10, 2), amount);
      request.input('Notes', sql.NVarChar(sql.MAX), `Manual adjustment: ${reason}`);
      request.input('CreatedBy', sql.UniqueIdentifier, createdBy);
      
      await request.query(`
        INSERT INTO oe.CommissionLogs (
          LogId, CommissionId, PaymentId, MemberId, ProductId, EnrollmentId,
          AgentId, BeneficiaryType, BeneficiaryId, TierLevel, 
          PremiumAmount, CommissionRate, CommissionAmount, CommissionType,
          PaymentPeriod, CalculationDate, HoldUntilDate, PaymentStatus, 
          Notes, CreatedBy, CreatedDate
        ) VALUES (
          @LogId, @CommissionId, @PaymentId, @MemberId, @ProductId, @EnrollmentId,
          @AgentId, @BeneficiaryType, @BeneficiaryId, 0,
          0, 0, @CommissionAmount, 'Adjustment',
          DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), CASE WHEN DAY(GETDATE()) <= 15 THEN 1 ELSE 15 END),
          GETUTCDATE(), DATEADD(DAY, 10, GETUTCDATE()), 'Hold',
          @Notes, @CreatedBy, GETUTCDATE()
        )
      `);
      
      logger.info(`Manual commission adjustment created: ${logId}`, {
        logId,
        amount,
        reason,
        beneficiaryType,
        beneficiaryId,
        createdBy
      }, 'Commission');
      
      return {
        success: true,
        logId,
        amount,
        reason
      };
      
    } catch (error) {
      logger.error('Error creating commission adjustment', { error: error.message, adjustmentData }, 'Commission');
      throw error;
    }
  }
}

module.exports = new CommissionService();