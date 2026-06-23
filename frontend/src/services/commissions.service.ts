// frontend/src/services/commissionService.ts
import { apiService } from './api.service';

interface CommissionMetrics {
  totalCommissions: number;
  commissionsPaid: number;
  commissionsPending: number;
  commissionsHeld: number;
  activeAgents: number;
  totalAgents: number;
  nextPaymentDate: string;
  monthlyGrowth: number;
  ytdCommissions: number;
  avgCommissionPerAgent: number;
}

interface CommissionSummaryFilters {
  entityType: 'Agent' | 'Agency';
  entityId: string;
  startDate?: string;
  endDate?: string;
}

interface CommissionStatementFilters {
  entityType: 'Agent' | 'Agency';
  entityId: string;
  paymentPeriod: string;
}

interface CommissionSimulation {
  productId: string;
  premiumAmount: number;
  agentId: string;
}

interface PaymentBatchRequest {
  paymentPeriod: string;
  batchType?: string;
}

interface ChargebackRequest {
  paymentId: string;
  reason: string;
}

interface CommissionAdjustment {
  paymentId: string;
  memberId: string;
  productId: string;
  enrollmentId: string;
  agentId: string;
  beneficiaryType: 'Agent' | 'Agency';
  beneficiaryId: string;
  amount: number;
  reason: string;
}

class CommissionService {
  private baseURL = '/api/commissions';

  // Get agent hierarchy
  async getAgentHierarchy(agentId: string, asOfDate?: string): Promise<any> {
    try {
      const params = new URLSearchParams({ agentId });
      if (asOfDate) params.append('asOfDate', asOfDate);
      
      const response = await apiService.get(`${this.baseURL}/hierarchy/${agentId}?${params}`);
      return response;
    } catch (error) {
      console.error('Error fetching agent hierarchy:', error);
      throw error;
    }
  }

  // Get commission summary
  async getCommissionSummary(filters: CommissionSummaryFilters): Promise<any> {
    try {
      const params = new URLSearchParams(filters as any);
      const response = await apiService.get(`${this.baseURL}/summary?${params}`);
      return response;
    } catch (error) {
      console.error('Error fetching commission summary:', error);
      throw error;
    }
  }

  // Get commission statement
  async getCommissionStatement(filters: CommissionStatementFilters): Promise<any> {
    try {
      const params = new URLSearchParams(filters as any);
      const response = await apiService.get(`${this.baseURL}/statement?${params}`);
      return response;
    } catch (error) {
      console.error('Error fetching commission statement:', error);
      throw error;
    }
  }

  // Get upcoming payments
  async getUpcomingPayments(entityType?: string, entityId?: string): Promise<any> {
    try {
      const params = new URLSearchParams();
      if (entityType) params.append('entityType', entityType);
      if (entityId) params.append('entityId', entityId);
      
      const response = await apiService.get(`${this.baseURL}/upcoming?${params}`);
      return response;
    } catch (error) {
      console.error('Error fetching upcoming payments:', error);
      throw error;
    }
  }

  // Simulate commission calculation (legacy)
  async simulateCommission(simulation: CommissionSimulation): Promise<any> {
    try {
      const response = await apiService.post(`${this.baseURL}/simulate`, simulation);
      return response;
    } catch (error) {
      console.error('Error simulating commission:', error);
      throw error;
    }
  }

  // Simulate commission calculation with detailed breakdown
  async simulateCommissionDetailed(params: {
    tenantId?: string; // SysAdmin only
    agentId?: string;
    commissionRuleId?: string; // For TenantAdmin/SysAdmin
    allocatedCommissionAmount: number;
    vendorCommissionAmount?: number; // NetRate (100% paid to vendor)
    overrideAmount?: number; // OverrideRate (paid to override destinations)
    productPricingId?: string; // ProductPricingId (for matching oe.ProductOverrides)
    productId?: string;
    paymentDate?: string;
    productTier?: string; // Product tier code (EE, ES, EC, EF) for tier-specific commission amounts
    groupId?: string;
    allowUnlockedRules?: boolean;
  }): Promise<any> {
    try {
      const response = await apiService.post(`${this.baseURL}/simulate-detailed`, params);
      return response;
    } catch (error) {
      console.error('Error simulating commission (detailed):', error);
      throw error;
    }
  }

  // Resolve payout destinations (masked bank info) for simulation results
  async getPayoutDestinations(params: { vendorIds?: string[]; overrideRecipientIds?: string[]; overrideAchIds?: string[] }): Promise<any> {
    try {
      const response = await apiService.post(`${this.baseURL}/payout-destinations`, params);
      return response;
    } catch (error) {
      console.error('Error fetching payout destinations:', error);
      throw error;
    }
  }

  // Get commission rules for simulation (role-based filtered)
  async getSimulationRules(tenantId?: string): Promise<any> {
    try {
      const params = new URLSearchParams();
      if (tenantId) params.append('tenantId', tenantId);
      
      const response = await apiService.get(`${this.baseURL}/simulate/rules?${params}`);
      return response;
    } catch (error) {
      console.error('Error fetching simulation rules:', error);
      throw error;
    }
  }

  // Process payment batch (TenantAdmin/SysAdmin only)
  async processPaymentBatch(batchRequest: PaymentBatchRequest): Promise<any> {
    try {
      const response = await apiService.post(`${this.baseURL}/process-batch`, batchRequest);
      return response;
    } catch (error) {
      console.error('Error processing payment batch:', error);
      throw error;
    }
  }

  /**
   * Phase 2 — DEPRECATED.
   *
   * Commission chargebacks are processed automatically by the unified
   * refund flow (RefundService.processRefund). Refund a payment via
   * POST /api/accounting/payments/:paymentId/refund instead — the backend
   * runs CommissionService.clawBackForRefund() inside the same transaction.
   * Calling this endpoint now returns 410 Gone.
   */
  async processChargeback(chargebackRequest: ChargebackRequest): Promise<any> {
    console.warn('[commissions.service] processChargeback is deprecated. Use accountingService refund flow instead.');
    try {
      const response = await apiService.post(`${this.baseURL}/chargeback`, chargebackRequest);
      return response;
    } catch (error) {
      console.error('Error processing chargeback (deprecated):', error);
      throw error;
    }
  }

  // Create commission adjustment (TenantAdmin/SysAdmin only)
  async createCommissionAdjustment(adjustment: CommissionAdjustment): Promise<any> {
    try {
      const response = await apiService.post(`${this.baseURL}/adjustment`, adjustment);
      return response;
    } catch (error) {
      console.error('Error creating commission adjustment:', error);
      throw error;
    }
  }

  // Get commission rules (TenantAdmin/SysAdmin only)
  async getCommissionRules(filters?: {
    productId?: string;
    entityType?: string;
    entityId?: string;
    status?: string;
  }): Promise<any> {
    try {
      const params = new URLSearchParams();
      if (filters?.productId) params.append('productId', filters.productId);
      if (filters?.entityType) params.append('entityType', filters.entityType);
      if (filters?.entityId) params.append('entityId', filters.entityId);
      if (filters?.status) params.append('status', filters.status);
      
      const response = await apiService.get(`${this.baseURL}/rules?${params}`);
      return response;
    } catch (error) {
      console.error('Error fetching commission rules:', error);
      throw error;
    }
  }

  /**
   * Get multiple commission rules by IDs (batch request)
   * @param ruleIds Array of rule IDs to fetch
   * @returns Promise with array of rule objects
   */
  async getCommissionRulesBatch(ruleIds: string[]): Promise<any> {
    try {
      if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
        return { success: true, rules: [] };
      }

      const response = await apiService.post<{ success: boolean; rules: any[] }>(
        `${this.baseURL}/rules/batch`,
        { ruleIds }
      );
      return response;
    } catch (error) {
      console.error('Error fetching commission rules batch:', error);
      throw error;
    }
  }

  // Create commission rule (SysAdmin only)
  async createCommissionRule(rule: any): Promise<any> {
    try {
      const response = await apiService.post(`${this.baseURL}/rules`, rule);
      return response;
    } catch (error) {
      console.error('Error creating commission rule:', error);
      throw error;
    }
  }

  // Update commission rule (SysAdmin only)
  async updateCommissionRule(ruleId: string, rule: any): Promise<any> {
    try {
      const response = await apiService.put(`${this.baseURL}/rules/${ruleId}`, rule);
      return response;
    } catch (error) {
      console.error('Error updating commission rule:', error);
      throw error;
    }
  }

  // Delete commission rule (SysAdmin only)
  async deleteCommissionRule(ruleId: string): Promise<any> {
    try {
      const response = await apiService.delete(`${this.baseURL}/rules/${ruleId}`);
      return response;
    } catch (error) {
      console.error('Error deleting commission rule:', error);
      throw error;
    }
  }

  // Get downline agents
  async getDownlineAgents(agentId: string): Promise<any> {
    try {
      const response = await apiService.get(`${this.baseURL}/agents/${agentId}/downline`);
      return response;
    } catch (error) {
      console.error('Error fetching downline agents:', error);
      throw error;
    }
  }

  // Get commission metrics for dashboard
  async getCommissionMetrics(filters?: {
    startDate?: string;
    endDate?: string;
    entityType?: string;
    entityId?: string;
  }): Promise<CommissionMetrics> {
    try {
      // This would use the summary endpoint with aggregated data
      const summaryData = await this.getCommissionSummary({
        entityType: filters?.entityType as 'Agent' | 'Agency' || 'Agent',
        entityId: filters?.entityId || '',
        startDate: filters?.startDate,
        endDate: filters?.endDate,
      });

      // Transform the summary data into metrics format
      return {
        totalCommissions: summaryData.totalCommissions || 0,
        commissionsPaid: summaryData.paidCommissions || 0,
        commissionsPending: summaryData.pendingCommissions || 0,
        commissionsHeld: summaryData.heldCommissions || 0,
        activeAgents: summaryData.activeAgents || 0,
        totalAgents: summaryData.totalAgents || 0,
        nextPaymentDate: summaryData.nextPaymentDate || '',
        monthlyGrowth: summaryData.monthlyGrowth || 0,
        ytdCommissions: summaryData.ytdCommissions || 0,
        avgCommissionPerAgent: summaryData.avgCommissionPerAgent || 0,
      };
    } catch (error) {
      console.error('Error fetching commission metrics:', error);
      // Return mock data for development
      return {
        totalCommissions: 125750.50,
        commissionsPaid: 98250.25,
        commissionsPending: 21500.00,
        commissionsHeld: 6000.25,
        activeAgents: 47,
        totalAgents: 52,
        nextPaymentDate: '2025-01-15',
        monthlyGrowth: 8.5,
        ytdCommissions: 892450.75,
        avgCommissionPerAgent: 2671.28,
      };
    }
  }

  // Get commission transactions
  async getCommissionTransactions(filters?: {
    startDate?: string;
    endDate?: string;
    agentId?: string;
    productId?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<any> {
    try {
      const params = new URLSearchParams();
      Object.entries(filters || {}).forEach(([key, value]) => {
        if (value !== undefined) params.append(key, value.toString());
      });

      const response = await apiService.get(`${this.baseURL}/transactions?${params}`);
      return response;
    } catch (error) {
      console.error('Error fetching commission transactions:', error);
      throw error;
    }
  }

  // Get payment batches
  async getPaymentBatches(filters?: {
    startDate?: string;
    endDate?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<any> {
    try {
      const params = new URLSearchParams();
      Object.entries(filters || {}).forEach(([key, value]) => {
        if (value !== undefined) params.append(key, value.toString());
      });

      const response = await apiService.get(`${this.baseURL}/batches?${params}`);
      return response;
    } catch (error) {
      console.error('Error fetching payment batches:', error);
      throw error;
    }
  }
}

export const commissionService = new CommissionService();
export default commissionService;