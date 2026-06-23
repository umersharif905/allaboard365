import { apiService } from './api.service';

export interface PaymentMethodData {
  cardholderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  billingAddress: {
    address: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  email: string;
  phone: string;
  customerId?: string;
  paymentMethodId?: string;
}

export interface ProcessInitialPaymentRequest {
  memberId: string;
  paymentMethodData: PaymentMethodData;
  amount: number; // Amount in cents
  description?: string;
}

export interface ProcessInitialPaymentResponse {
  success: boolean;
  message: string;
  data?: {
    paymentId: string;
    transactionId: string;
    amount: number;
    status: string;
    householdId: string;
    nextBillingDate?: string;
  };
  error?: {
    code: string;
    details: string;
  };
}

export interface PaymentStatusResponse {
  success: boolean;
  data?: {
    payment: {
      PaymentId: string;
      Amount: number;
      Status: string;
      PaymentMethod: string;
      ProcessorTransactionId: string;
      PaymentDate: string;
      NextBillingDate?: string;
      RecurringScheduleId?: string;
      Description: string;
    } | null;
  };
  error?: {
    code: string;
    details: string;
  };
}

export interface PremiumAmountResponse {
  success: boolean;
  data?: {
    totalPremium: number; // Amount in cents
  };
  error?: {
    code: string;
    details: string;
  };
}

export class IndividualPaymentsService {
  /**
   * Process initial payment for individual enrollment (integrated into enrollment completion)
   * This is now handled by the complete-enrollment endpoint with paymentMethod data
   */
  static async processInitialPayment(request: ProcessInitialPaymentRequest): Promise<ProcessInitialPaymentResponse> {
    // This method is now deprecated - payment is handled in enrollment completion
    console.warn('⚠️ processInitialPayment is deprecated - payment is now handled in enrollment completion');
    return {
      success: false,
      message: 'Payment processing is now integrated into enrollment completion',
      error: {
        code: 'DEPRECATED_METHOD',
        details: 'Use enrollment completion endpoint with paymentMethod data instead'
      }
    };
  }

  /**
   * Get payment status for household (public endpoint for enrollment wizard)
   */
  static async getHouseholdPaymentStatus(householdId: string): Promise<PaymentStatusResponse> {
    try {
      return await apiService.get<PaymentStatusResponse>(`/api/public-payments/household/${householdId}/status`);
    } catch (error) {
      console.error('❌ Error getting payment status:', error);
      return {
        success: false,
        error: {
          code: 'API_ERROR',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  /**
   * Get total premium amount for household (public endpoint for enrollment wizard)
   */
  static async getHouseholdPremium(householdId: string): Promise<PremiumAmountResponse> {
    try {
      return await apiService.get<PremiumAmountResponse>(`/api/public-payments/household/${householdId}/premium`);
    } catch (error) {
      console.error('❌ Error getting premium amount:', error);
      return {
        success: false,
        error: {
          code: 'API_ERROR',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }
}

export default IndividualPaymentsService;
