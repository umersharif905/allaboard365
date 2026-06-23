// frontend/src/services/businessProposal.service.ts
// Service for generating and sending business proposals

import { apiService } from './api.service';

/**
 * New request shape: raw inputs, no pre-computed calculationResults.
 * Backend computes all calculations server-side.
 */
export interface GenerateBusinessProposalData {
  // Document selection — one or more templates to generate
  documentIds: string[];
  /** Optional: for TenantAdmin - which agent the proposal is generated for */
  agentId?: string;

  // Company info
  companyName: string;
  companyAddress?: string;

  // Workforce
  totalEmployees: number;

  // Current Coverage
  hasExistingCoverage: boolean;
  // Per-tier current enrollment counts (replaces single currentlyEnrolled).
  // EC fields are optional — only sent when the selected product has an EC tier.
  currentCountEE: number;
  currentCountE1: number;
  currentCountEC?: number;
  currentCountEF: number;
  // Per-tier current monthly premiums (replaces single currentMonthlyPremium)
  currentPremiumEE: number;
  currentPremiumE1: number;
  currentPremiumEC?: number;
  currentPremiumEF: number;
  // Current employer contribution (per-tier with individual value types)
  currentContributionValueEE?: number;
  currentContributionValueE1?: number;
  currentContributionValueEC?: number;
  currentContributionValueEF?: number;
  currentContributionValueTypeEE?: 'dollar' | 'percentage';
  currentContributionValueTypeE1?: 'dollar' | 'percentage';
  currentContributionValueTypeEC?: 'dollar' | 'percentage';
  currentContributionValueTypeEF?: 'dollar' | 'percentage';

  // Plan Configuration — dynamically derived from product config
  oopLevel: string;

  // MW Tier Counts. Most products use 3 tiers (EE/E1/EF).
  // 4-tier products (e.g. Concierge) also send EC.
  mwCountEE: number;
  mwCountE1: number;
  mwCountEC?: number;
  mwCountEF: number;

  // Partial Switch (per-tier: employees remaining on current plan)
  currentRemainCountEE?: number;
  currentRemainCountE1?: number;
  currentRemainCountEC?: number;
  currentRemainCountEF?: number;

  // MW Employer Contribution (per-tier with individual value types)
  contributionValueEE: number;
  contributionValueE1: number;
  contributionValueEC?: number;
  contributionValueEF: number;
  contributionValueTypeEE: 'dollar' | 'percentage';
  contributionValueTypeE1: 'dollar' | 'percentage';
  contributionValueTypeEC?: 'dollar' | 'percentage';
  contributionValueTypeEF: 'dollar' | 'percentage';

  // Enrollment Date
  enrollmentDate?: string;

  // Send options
  sendMethod: 'email' | 'text' | 'download';
  recipientEmail?: string;
  recipientPhone?: string;
  emailMessage?: string;
  textMessage?: string;

  // Optional extras
  enrollmentLinkUrls?: Record<string, string>;
  customFieldValues?: Record<string, string>;
}

export interface GeneratedDocument {
  proposalSendId: string;
  proposalDocumentId: string;
  documentName: string;
  pdfUrl: string;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: {
    message: string;
    code: string;
  };
}

export class BusinessProposalService {
  private static readonly GENERATE_TIMEOUT_MS = 300000; // 5 minutes for multi-doc PDF generation

  /**
   * Generate and send one or more business proposal documents.
   * The backend computes calculations server-side from raw inputs.
   */
  static async generateBusinessProposal(data: GenerateBusinessProposalData): Promise<ApiResponse<{
    documents: GeneratedDocument[];
    proposalSendId: string;
    pdfUrl: string;
    sendMethod: string;
    sentAt: string;
  }>> {
    return await apiService.post<ApiResponse<{
      documents: GeneratedDocument[];
      proposalSendId: string;
      pdfUrl: string;
      sendMethod: string;
      sentAt: string;
    }>>(
      '/api/business-proposal-sends',
      data,
      { timeout: this.GENERATE_TIMEOUT_MS }
    );
  }
}

export default BusinessProposalService;
