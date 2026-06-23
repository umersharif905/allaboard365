import { apiService } from './api.service';

export interface EnrollmentData {
  memberId: string;
  memberInfo: any;
  memberTier: string;
  selectedProducts: string[];
  selectedConfigs: Record<string, string>;
  frontendPricing: Array<{
    productId: string;
    productName: string;
    monthlyPremium: number;
    selectedConfig: string | null;
  }>;
  frontendCalculatedAmount?: number;
  /** Full wizard snapshot for reproducing pricing/payment mismatches (stored in SystemIntegrationErrors). */
  submitForensics?: Record<string, unknown>;
  pricingFingerprint?: string | null;
  pricingContext?: Record<string, unknown> | null;
  householdMembers: any[];
  effectiveDate: string;
  dependents?: any[];
  acknowledgements: any[];
  digitalSignature: string;
  ipAddress: string;
  userAgent: string;
  paymentMethod?: {
    paymentMethodType: string;
    cardholderName: string;
    cardNumber: string;
    expiryDate: string;
    cvv: string;
    cardBrand: string;
    bankName: string;
    accountType: string;
    routingNumber: string;
    accountNumber: string;
    accountHolderName: string;
    billingAddress: string;
    billingCity: string;
    billingState: string;
    billingZip: string;
    billingCountry: string;
    email: string;
    phone: string;
  };
  /** Local/dev flag to bypass charging during enrollment submission. */
  skipPaymentProcessing?: boolean;
  /** Whether the user consented to receive SMS (e.g. on acknowledgements step). */
  smsConsent?: boolean;
  /** Product questionnaire responses (from ProductQuestionnaireStep) */
  questionnaireResponses?: {
    productId: string;
    questionnaireVersion: number;
    answeredAt: string;
    answers: Array<{ questionId: string; answer: any }>;
    acknowledgementAccepted: boolean;
    acknowledgedAt: string | null;
  };
}

export interface EnrollmentResponse {
  success: boolean;
  data?: any;
  message?: string;
  error?: {
    message: string;
    code: string;
    details?: any;
  };
}

export class EnrollmentService {
  /**
   * Get enrollment link details (PUBLIC)
   */
  static async getEnrollmentLink(linkToken: string): Promise<EnrollmentResponse> {
    return apiService.get(`/api/enrollment-links/${linkToken}`);
  }

  /**
   * Get enrollment data for a link token (PUBLIC)
   */
  static async getEnrollmentData(linkToken: string): Promise<EnrollmentResponse> {
    return apiService.get(`/api/enrollment-links/${linkToken}/enrollment-data`);
  }

  /**
   * Get enrollment status (PUBLIC)
   */
  static async getEnrollmentStatus(linkToken: string): Promise<EnrollmentResponse> {
    return apiService.get(`/api/enrollment-links/${linkToken}/enrollment-status`);
  }

  /**
   * Get tenant redirect info (PUBLIC)
   */
  static async getTenantRedirect(linkToken: string): Promise<EnrollmentResponse> {
    return apiService.get(`/api/enrollment-links/${linkToken}/tenant-redirect`);
  }
  
  /**
   * Get tenant payment processor settings (PUBLIC)
   */
  static async getTenantPaymentSettings(tenantId: string): Promise<EnrollmentResponse> {
    return apiService.get(`/api/tenants/${tenantId}/payment-settings`);
  }

  /**
   * Get effective dates for enrollment (PUBLIC)
   */
  static async getEffectiveDates(linkToken: string): Promise<EnrollmentResponse> {
    return apiService.get(`/api/enrollment-links/${linkToken}/effective-dates`);
  }

  /**
   * Get fresh product info for Product Info modal (current productDocuments; avoids stale/deleted docs)
   */
  static async getProductInfo(linkToken: string, productId: string): Promise<EnrollmentResponse> {
    return apiService.get(`/api/enrollment-links/${linkToken}/product-info/${productId}`);
  }

  /**
   * Get product acknowledgements (PUBLIC)
   */
  static async getProductAcknowledgements(linkToken: string, selectedProducts: string[]): Promise<EnrollmentResponse> {
    const params = new URLSearchParams({ selectedProducts: selectedProducts.join(',') });
    return apiService.get(`/api/enrollment-links/${linkToken}/product-acknowledgements?${params}`);
  }

  /**
   * Submit acknowledgements (PUBLIC)
   */
  static async submitAcknowledgements(
    linkToken: string,
    data: {
      memberId?: string;
      acknowledgements: any[];
      digitalSignature: string;
      ipAddress: string;
      userAgent: string;
    }
  ): Promise<EnrollmentResponse> {
    return apiService.post(`/api/enrollment-links/${linkToken}/submit-acknowledgements`, data);
  }

  /**
   * Setup password after enrollment (PUBLIC)
   */
  static async setupPassword(
    linkToken: string,
    data: {
      email: string;
      password: string;
      memberId: string;
      smsConsent?: boolean;
      acknowledgements?: any;
    }
  ): Promise<EnrollmentResponse> {
    return apiService.post(`/api/enrollment-links/${linkToken}/setup-password`, data);
  }

  /**
   * Decline coverage (PUBLIC)
   */
  static async declineCoverage(
    linkToken: string,
    data: {
      ipAddress: string;
      userAgent: string;
      [key: string]: any;
    }
  ): Promise<EnrollmentResponse> {
    return apiService.post(`/api/enrollment-links/${linkToken}/decline-coverage`, data);
  }

  /**
   * Complete enrollment with pricing validation
   * Used by all enrollment completion flows
   */
  static async completeEnrollment(
    linkToken: string, 
    enrollmentData: EnrollmentData
  ): Promise<EnrollmentResponse> {
    try {
      console.log('🔍 DEBUG: EnrollmentService.completeEnrollment - Submitting enrollment data:', enrollmentData);
      console.log('🔍 DEBUG: selectedConfigs from EnrollmentService:', enrollmentData.selectedConfigs);
      console.log('🔍 DEBUG: frontendPricing from EnrollmentService:', enrollmentData.frontendPricing);
      console.log('🔍 DEBUG: paymentMethod from EnrollmentService:', enrollmentData.paymentMethod);

      const response = await apiService.post<EnrollmentResponse>(
        `/api/enrollment-links/${linkToken}/complete-enrollment`,
        enrollmentData
      );

      return response;
    } catch (error) {
      console.error('❌ EnrollmentService.completeEnrollment error:', error);
      throw error;
    }
  }

  /**
   * Test pricing validation only (no payment, no DB changes). For localhost/dev use.
   */
  static async validatePricing(
    linkToken: string,
    data: {
      memberId?: string;
      memberInfo?: any;
      memberTier?: string;
      selectedProducts: string[];
      selectedConfigs?: Record<string, string>;
      frontendPricing: Array<{ productId: string; productName?: string; monthlyPremium: number; selectedConfig?: string | null }>;
      householdMembers?: any[];
      dependents?: any[];
      effectiveDate?: string;
    }
  ): Promise<{ success: boolean; message?: string; validationResults?: any[] }> {
    const response = await apiService.post<{ success: boolean; message?: string; validationResults?: any[] }>(
      `/api/enrollment-links/${linkToken}/validate-pricing`,
      data
    );
    return response;
  }

  /**
   * Generate agreements PDF for compliance
   * Used by enrollment submission flow
   */
  static async generateAgreementsPdf(
    linkToken: string,
    pdfData: {
      acknowledgements: any[];
      digitalSignature: string;
      memberInfo: any;
      productSelections: Array<{
        productId: string;
        productName: string;
        productType: string;
      }>;
      enrollmentType: string;
    }
  ): Promise<{ success: boolean; data?: { pdfUrl: string } }> {
    try {
      console.log('📄 EnrollmentService.generateAgreementsPdf - Generating PDF for compliance...');
      
      const response = await apiService.post<{ success: boolean; data?: { pdfUrl: string } }>(
        `/api/enrollment-links/${linkToken}/generate-agreements-pdf`,
        pdfData
      );

      return response;
    } catch (error) {
      console.error('❌ EnrollmentService.generateAgreementsPdf error:', error);
      throw error;
    }
  }

  /**
   * Post-enrollment: send a verification code to the just-enrolled member.
   * Authorized via (linkToken, memberId) issued by complete-enrollment.
   */
  static async sendPostEnrollmentVerificationCode(
    linkToken: string,
    memberId: string
  ): Promise<EnrollmentResponse> {
    return apiService.post<EnrollmentResponse>(
      `/api/enrollment-links/${linkToken}/post-enrollment-verify/send`,
      { memberId }
    );
  }

  /**
   * Post-enrollment: verify the code submitted by the just-enrolled member.
   * On success, oe.Users.EmailVerified flips to 1.
   */
  static async verifyPostEnrollmentCode(
    linkToken: string,
    memberId: string,
    code: string
  ): Promise<EnrollmentResponse> {
    return apiService.post<EnrollmentResponse>(
      `/api/enrollment-links/${linkToken}/post-enrollment-verify/verify`,
      { memberId, code }
    );
  }

  /**
   * Send acknowledgements via email/SMS for external signing
   */
  static async sendAcknowledgements(
    linkToken: string,
    deliveryMethod: 'Email' | 'SMS',
    email?: string,
    phone?: string,
    selectedProducts?: string[],
    memberInfo?: { firstName: string; lastName: string; dateOfBirth: string }
  ): Promise<EnrollmentResponse> {
    try {
      console.log(`✅ EnrollmentService.sendAcknowledgements - Sending via ${deliveryMethod}`);
      
      const response = await apiService.post<EnrollmentResponse>(
        `/api/enrollment-links/${linkToken}/send-acknowledgements`,
        { deliveryMethod, email, phone, selectedProducts, memberInfo }
      );

      return response;
    } catch (error) {
      console.error('❌ EnrollmentService.sendAcknowledgements error:', error);
      throw error;
    }
  }

  /**
   * Check if acknowledgements have been signed (via email/SMS or in-wizard)
   */
  static async checkAcknowledgementsStatus(linkToken: string): Promise<EnrollmentResponse> {
    try {
      const response = await apiService.get<EnrollmentResponse>(
        `/api/enrollment-links/${linkToken}/acknowledgements/status`
      );

      return response;
    } catch (error) {
      console.error('❌ EnrollmentService.checkAcknowledgementsStatus error:', error);
      throw error;
    }
  }
}

export default EnrollmentService;
