// backend/services/agentAdvanceService.js
const { getPool, sql } = require('../config/database');
const logger = require('../config/logger');

/**
 * Agent Advance Service
 * Handles agent commission advance configuration and tracking
 */
class AgentAdvanceService {
  /**
   * Get agent advance configuration (number of months)
   * @param {string} agentId - Agent ID
   * @returns {Promise<number|null>} Advance months (1-12) or null if disabled
   */
  async getAgentAdvanceConfig(agentId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('agentId', sql.UniqueIdentifier, agentId);
      
      const result = await request.query(`
        SELECT AdvanceMonths 
        FROM oe.Agents 
        WHERE AgentId = @agentId
      `);
      
      if (result.recordset.length === 0) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      
      return result.recordset[0].AdvanceMonths; // NULL or 1-12
    } catch (error) {
      logger.error('Error getting agent advance config', {
        error: error.message,
        agentId
      }, 'Advance');
      throw error;
    }
  }

  /**
   * Set agent advance configuration (TenantAdmin only)
   * @param {string} agentId - Agent ID
   * @param {number|null} months - Advance months (1-12) or null to disable
   * @returns {Promise<void>}
   */
  async setAgentAdvanceConfig(agentId, months) {
    try {
      // Validate months
      if (months !== null && (months < 1 || months > 12)) {
        throw new Error('Advance months must be between 1 and 12, or null to disable');
      }
      
      const pool = await getPool();
      const request = pool.request();
      request.input('agentId', sql.UniqueIdentifier, agentId);
      request.input('advanceMonths', sql.Int, months);
      
      await request.query(`
        UPDATE oe.Agents 
        SET AdvanceMonths = @advanceMonths,
            ModifiedDate = GETUTCDATE()
        WHERE AgentId = @agentId
      `);
      
      logger.info('Agent advance config updated', {
        agentId,
        advanceMonths: months
      }, 'Advance');
    } catch (error) {
      logger.error('Error setting agent advance config', {
        error: error.message,
        agentId,
        months
      }, 'Advance');
      throw error;
    }
  }

  /**
   * Calculate advance amount for enrollment
   * @param {string} enrollmentId - Enrollment ID
   * @param {string} agentId - Agent ID
   * @returns {Promise<number>} Advance amount (Commission × AdvanceMonths)
   */
  async calculateAdvanceForEnrollment(enrollmentId, agentId) {
    try {
      // Get agent advance config
      const advanceMonths = await this.getAgentAdvanceConfig(agentId);
      if (!advanceMonths) {
        return 0; // No advance configured
      }
      
      // Get enrollment commission
      const pool = await getPool();
      const request = pool.request();
      request.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
      
      const result = await request.query(`
        SELECT Commission 
        FROM oe.Enrollments 
        WHERE EnrollmentId = @enrollmentId
      `);
      
      if (result.recordset.length === 0) {
        throw new Error(`Enrollment not found: ${enrollmentId}`);
      }
      
      const commission = parseFloat(result.recordset[0].Commission) || 0;
      const advanceAmount = commission * advanceMonths;
      
      logger.info('Calculated advance for enrollment', {
        enrollmentId,
        agentId,
        commission,
        advanceMonths,
        advanceAmount
      }, 'Advance');
      
      return advanceAmount;
    } catch (error) {
      logger.error('Error calculating advance for enrollment', {
        error: error.message,
        enrollmentId,
        agentId
      }, 'Advance');
      throw error;
    }
  }

  /**
   * Mark enrollment as having advance paid
   * @param {string} enrollmentId - Enrollment ID
   * @param {number} advanceAmount - Total advance amount paid
   * @param {number} advanceMonths - Number of months advance covers
   * @param {number} commissionAmount - Commission amount per month (snapshot)
   * @param {string|null} nachaId - NACHA generation ID (optional)
   * @returns {Promise<void>}
   */
  async markEnrollmentAdvancePaid(enrollmentId, advanceAmount, advanceMonths, commissionAmount, nachaId = null) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
      request.input('advancePaidDate', sql.DateTime2, new Date());
      request.input('advanceMonthsRemaining', sql.Int, advanceMonths);
      request.input('advanceCommissionAmount', sql.Decimal(18, 2), commissionAmount);
      
      await request.query(`
        UPDATE oe.Enrollments 
        SET AdvancePaidDate = @advancePaidDate,
            AdvanceMonthsRemaining = @advanceMonthsRemaining,
            AdvanceCommissionAmount = @advanceCommissionAmount,
            ModifiedDate = GETUTCDATE()
        WHERE EnrollmentId = @enrollmentId
      `);
      
      logger.info('Enrollment marked as advance paid', {
        enrollmentId,
        advanceAmount,
        advanceMonths,
        commissionAmount,
        nachaId
      }, 'Advance');
    } catch (error) {
      logger.error('Error marking enrollment advance paid', {
        error: error.message,
        enrollmentId,
        advanceAmount
      }, 'Advance');
      throw error;
    }
  }

  /**
   * Calculate remaining advance months dynamically
   * @param {string} enrollmentId - Enrollment ID
   * @returns {Promise<number>} Remaining months (0 if advance period expired)
   */
  async calculateAdvanceRemainingMonths(enrollmentId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
      
      const result = await request.query(`
        SELECT 
          AdvancePaidDate,
          AdvanceMonthsRemaining,
          DATEDIFF(MONTH, AdvancePaidDate, GETUTCDATE()) as MonthsElapsed
        FROM oe.Enrollments 
        WHERE EnrollmentId = @enrollmentId
          AND AdvancePaidDate IS NOT NULL
      `);
      
      if (result.recordset.length === 0 || !result.recordset[0].AdvancePaidDate) {
        return 0; // No advance
      }
      
      const { AdvanceMonthsRemaining, MonthsElapsed } = result.recordset[0];
      const remaining = Math.max(0, AdvanceMonthsRemaining - MonthsElapsed);
      
      // Update stored value if different (for consistency)
      if (remaining !== AdvanceMonthsRemaining) {
        const updateRequest = pool.request();
        updateRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
        updateRequest.input('remaining', sql.Int, remaining);
        
        await updateRequest.query(`
          UPDATE oe.Enrollments 
          SET AdvanceMonthsRemaining = @remaining,
              ModifiedDate = GETUTCDATE()
          WHERE EnrollmentId = @enrollmentId
        `);
      }
      
      return remaining;
    } catch (error) {
      logger.error('Error calculating remaining advance months', {
        error: error.message,
        enrollmentId
      }, 'Advance');
      throw error;
    }
  }

  /**
   * Get enrollment advance status
   * @param {string} enrollmentId - Enrollment ID
   * @returns {Promise<Object>} Advance status object
   */
  async getEnrollmentAdvanceStatus(enrollmentId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
      
      const result = await request.query(`
        SELECT 
          AdvancePaidDate,
          AdvanceMonthsRemaining,
          AdvanceCommissionAmount,
          DATEDIFF(MONTH, AdvancePaidDate, GETUTCDATE()) as MonthsElapsed
        FROM oe.Enrollments 
        WHERE EnrollmentId = @enrollmentId
      `);
      
      if (result.recordset.length === 0) {
        throw new Error(`Enrollment not found: ${enrollmentId}`);
      }
      
      const enrollment = result.recordset[0];
      
      if (!enrollment.AdvancePaidDate) {
        return {
          hasAdvance: false,
          advancePaidDate: null,
          advanceMonthsRemaining: 0,
          advanceCommissionAmount: null,
          monthsElapsed: 0
        };
      }
      
      const monthsElapsed = enrollment.MonthsElapsed || 0;
      const remaining = Math.max(0, (enrollment.AdvanceMonthsRemaining || 0) - monthsElapsed);
      
      return {
        hasAdvance: true,
        advancePaidDate: enrollment.AdvancePaidDate,
        advanceMonthsRemaining: remaining,
        advanceCommissionAmount: parseFloat(enrollment.AdvanceCommissionAmount) || 0,
        monthsElapsed
      };
    } catch (error) {
      logger.error('Error getting enrollment advance status', {
        error: error.message,
        enrollmentId
      }, 'Advance');
      throw error;
    }
  }

  /**
   * Check if enrollment has active advance
   * @param {string} enrollmentId - Enrollment ID
   * @returns {Promise<boolean>} True if enrollment has active advance
   */
  async hasActiveAdvance(enrollmentId) {
    try {
      const status = await this.getEnrollmentAdvanceStatus(enrollmentId);
      return status.hasAdvance && status.advanceMonthsRemaining > 0;
    } catch (error) {
      logger.error('Error checking active advance', {
        error: error.message,
        enrollmentId
      }, 'Advance');
      return false;
    }
  }

  /**
   * Get all enrollments with active advances for an agent
   * @param {string} agentId - Agent ID
   * @returns {Promise<Array>} Array of enrollments with active advances
   */
  async getAgentActiveAdvances(agentId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('agentId', sql.UniqueIdentifier, agentId);
      
      const result = await request.query(`
        SELECT 
          e.EnrollmentId,
          e.MemberId,
          e.ProductId,
          e.AdvancePaidDate,
          e.AdvanceMonthsRemaining,
          e.AdvanceCommissionAmount,
          DATEDIFF(MONTH, e.AdvancePaidDate, GETUTCDATE()) as MonthsElapsed,
          pr.Name as ProductName,
          u.FirstName + ' ' + u.LastName as MemberName
        FROM oe.Enrollments e
        INNER JOIN oe.Products pr ON e.ProductId = pr.ProductId
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        INNER JOIN oe.Users u ON m.UserId = u.UserId
        WHERE e.AgentId = @agentId
          AND e.AdvancePaidDate IS NOT NULL
          AND e.AdvanceMonthsRemaining > 0
          AND DATEDIFF(MONTH, e.AdvancePaidDate, GETUTCDATE()) < e.AdvanceMonthsRemaining
        ORDER BY e.AdvancePaidDate DESC
      `);
      
      return result.recordset.map(row => ({
        enrollmentId: row.EnrollmentId,
        memberId: row.MemberId,
        productId: row.ProductId,
        productName: row.ProductName,
        memberName: row.MemberName,
        advancePaidDate: row.AdvancePaidDate,
        advanceMonthsRemaining: Math.max(0, row.AdvanceMonthsRemaining - (row.MonthsElapsed || 0)),
        advanceCommissionAmount: parseFloat(row.AdvanceCommissionAmount) || 0
      }));
    } catch (error) {
      logger.error('Error getting agent active advances', {
        error: error.message,
        agentId
      }, 'Advance');
      throw error;
    }
  }
}

module.exports = new AgentAdvanceService();
