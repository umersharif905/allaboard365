import { apiService } from './api.service';

export interface MemberPaymentMethod {
  paymentMethodId: string;
  paymentMethodType: 'ACH' | 'CreditCard' | 'DebitCard';
  isDefault: boolean;
  status: string;
  bankName?: string;
  accountType?: 'Checking' | 'Savings' | 'Business';
  routingNumber?: string;
  accountNumberLast4?: string;
  accountHolderName?: string;
  cardBrand?: 'Visa' | 'MasterCard' | 'American Express' | 'Discover' | 'JCB' | 'Diners Club' | 'Other';
  cardLast4?: string;
  expiryMonth?: number;
  expiryYear?: number;
  cardholderName?: string;
  billingAddress?: string;
  billingAddress2?: string;
  billingCity?: string;
  billingState?: string;
  billingZip?: string;
  billingCountry?: string;
  createdDate: string;
  modifiedDate: string;
  modifiedByUserId?: string | null;
  modifiedByName?: string | null;
  modifiedByEmail?: string | null;
  lastUpdatedByActor?: 'member' | 'staff' | 'unknown';
  // DIME integration fields
  processorToken?: string;
  processorCustomerId?: string;
  processorPaymentMethodId?: string;
}

export interface CreatePaymentMethodData {
  paymentMethodType: 'ACH' | 'CreditCard' | 'DebitCard';
  bankName?: string;
  accountType?: 'Checking' | 'Savings' | 'Business';
  routingNumber?: string;
  accountNumber?: string;
  accountHolderName?: string;
  cardBrand?: 'Visa' | 'MasterCard' | 'American Express' | 'Discover' | 'JCB' | 'Diners Club' | 'Other';
  cardNumber?: string;
  expiryMonth?: number;
  expiryYear?: number;
  cvv?: string;
  cardholderName?: string;
  billingAddress?: string;
  billingAddress2?: string;
  billingCity?: string;
  billingState?: string;
  billingZip?: string;
  billingCountry?: string;
  phoneNumber?: string;
  isDefault?: boolean;
}

export interface UpdatePaymentMethodData extends Partial<CreatePaymentMethodData> {
  paymentMethodId: string;
}

export interface OutstandingInvoicePrompt {
  invoiceId: string;
  invoiceNumber?: string | null;
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
  balanceDue: number;
  status?: string;
}

export interface PaymentMethodRecurringSyncPayload {
  recurringRecreated?: boolean;
  recurringWarning?: string;
  newRecurringStartDate?: string;
  duplicateRecurringRisk?: boolean;
  outstandingInvoice?: OutstandingInvoicePrompt;
}

export class MemberPaymentMethodsService {
  /**
   * Get all payment methods for the current member
   */
  static async getPaymentMethods(): Promise<{ success: boolean; data: MemberPaymentMethod[]; message?: string }> {
    return await apiService.get('/api/me/member/payment-methods');
  }

  /**
   * Add a new payment method
   */
  static async addPaymentMethod(data: CreatePaymentMethodData): Promise<{
    success: boolean;
    message?: string;
    data?: PaymentMethodRecurringSyncPayload & {
      paymentMethodType?: string;
      isDefault?: boolean;
      processorToken?: string;
      processorCustomerId?: string;
      processorPaymentMethodId?: string;
    };
  }> {
    return await apiService.post('/api/me/member/payment-methods', data);
  }

  /**
   * Update an existing payment method
   */
  static async updatePaymentMethod(data: UpdatePaymentMethodData): Promise<{ success: boolean; message?: string }> {
    const { paymentMethodId, ...updateData } = data;
    return await apiService.put(`/api/me/member/payment-methods/${paymentMethodId}`, updateData);
  }

  /**
   * Delete a payment method
   */
  static async deletePaymentMethod(paymentMethodId: string): Promise<{ success: boolean; message?: string }> {
    return await apiService.delete(`/api/me/member/payment-methods/${paymentMethodId}`);
  }

  /**
   * Set a payment method as default
   */
  static async setDefaultPaymentMethod(paymentMethodId: string): Promise<{
    success: boolean;
    message?: string;
    data?: PaymentMethodRecurringSyncPayload;
  }> {
    return await apiService.put(`/api/me/member/payment-methods/${paymentMethodId}/set-default`);
  }

  /**
   * Add a payment method for a member (Admin only)
   * Uses existing DIME customer if available; otherwise creates a new one.
   */
  static async addPaymentMethodForMember(memberId: string, data: CreatePaymentMethodData): Promise<{
    success: boolean;
    message?: string;
    data?: PaymentMethodRecurringSyncPayload & { paymentMethodId?: string };
  }> {
    return await apiService.post(`/api/members/${memberId}/payment-methods`, data);
  }

  /** Admin: list active + soft-removed payment methods. */
  static async getPaymentMethodsForMember(
    memberId: string,
    options?: { includeRemoved?: boolean }
  ): Promise<{
    success: boolean;
    data: MemberPaymentMethod[];
    removed?: MemberPaymentMethod[];
    hasExistingDimeCustomerId?: boolean;
    message?: string;
  }> {
    const qs = options?.includeRemoved ? '?includeRemoved=true' : '';
    return await apiService.get(`/api/members/${memberId}/payment-methods${qs}`);
  }

  /** Admin: soft-remove payment method (Inactive — hidden from member portal). */
  static async deletePaymentMethodForMember(
    memberId: string,
    paymentMethodId: string
  ): Promise<{ success: boolean; message?: string }> {
    return await apiService.delete(`/api/members/${memberId}/payment-methods/${paymentMethodId}`);
  }

  /** Admin: restore soft-removed payment method (visible on member portal again). */
  static async restorePaymentMethodForMember(
    memberId: string,
    paymentMethodId: string
  ): Promise<{ success: boolean; message?: string }> {
    return await apiService.post(
      `/api/members/${memberId}/payment-methods/${paymentMethodId}/restore`
    );
  }

  /** Admin: update billing / masked metadata (partial merge on server — omit full card/account to keep stored last4). */
  static async updatePaymentMethodForMember(
    memberId: string,
    paymentMethodId: string,
    body: Omit<UpdatePaymentMethodData, 'paymentMethodId'>
  ): Promise<{
    success: boolean;
    message?: string;
    data?: PaymentMethodRecurringSyncPayload;
  }> {
    return await apiService.put(`/api/members/${memberId}/payment-methods/${paymentMethodId}`, body);
  }

  /** Admin: load decrypted ACH account number for edit form (not sent in list endpoint). */
  static async getDecryptedAchAccountNumber(
    memberId: string,
    paymentMethodId: string
  ): Promise<{
    success: boolean;
    data?: {
      accountNumber: string | null;
      accountNumberLast4?: string | null;
      decryptionUnavailable?: boolean;
    };
    message?: string;
  }> {
    return await apiService.get(
      `/api/members/${memberId}/payment-methods/${paymentMethodId}/decrypted-account`
    );
  }

  /**
   * Retry syncing an existing member payment method to the payment processor.
   * Optional `cvv` is used only for the in-flight retry call (e.g. when DIME rejects
   * the card-on-file re-vault with "CVV is required"). PCI DSS 3.2.2: the CVV is
   * forwarded straight to DIME and never persisted locally.
   */
  static async addToPaymentProcessorForMember(
    memberId: string,
    paymentMethodId: string,
    options?: { cvv?: string; forceReplaceProcessorPaymentMethod?: boolean }
  ): Promise<{
    success: boolean;
    message?: string;
    code?: string;
    data?: PaymentMethodRecurringSyncPayload & {
      paymentMethodId?: string;
      processorCustomerId?: string;
      processorPaymentMethodId?: string;
    };
  }> {
    const body: Record<string, unknown> = {};
    if (options?.cvv) body.cvv = options.cvv;
    if (options?.forceReplaceProcessorPaymentMethod === true) {
      body.forceReplaceProcessorPaymentMethod = true;
    }
    return await apiService.post(`/api/members/${memberId}/payment-methods/${paymentMethodId}/add-to-processor`, body);
  }
}

export default MemberPaymentMethodsService;
