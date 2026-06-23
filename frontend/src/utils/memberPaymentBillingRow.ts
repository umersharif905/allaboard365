import type { BillingPaymentRow } from '../services/billing.service';
import { formatChargeSourceAttribution } from '../services/billing.service';
import type { Member } from '../types/member.types';

/** Map member payment-history row to BillingPaymentRow for AdminPaymentDetailsModal / retry / refund. */
export function memberPaymentToBillingRow(
  member: Member,
  p: {
    PaymentId: string;
    Amount: number;
    PaymentDate: string;
    Status: string;
    PaymentMethod: string;
    ProcessorTransactionId?: string;
    FailureReason?: string;
    EnrollmentId?: string;
    NextBillingDate?: string;
    ProductName?: string;
    AttemptNumber?: number;
    ConsecutiveFailureCount?: number;
    TransactionType?: string;
    InvoiceId?: string;
    InvoiceNumber?: string;
    InvoiceBillingPeriodStart?: string;
    InvoiceBillingPeriodEnd?: string;
    InvoiceLinkedStatus?: string;
    LocationId?: string;
    Processor?: string;
    PaymentMethodType?: string;
    HouseholdPaymentMethodType?: string;
    CreatedBy?: string | null;
    CreatedByName?: string | null;
    RecurringScheduleId?: string | null;
  }
): BillingPaymentRow {
  const isManualCharge =
    !p.EnrollmentId &&
    !p.RecurringScheduleId &&
    (!!p.CreatedBy ||
      ['dime', 'ach', 'card'].includes(String(p.PaymentMethod || '').trim().toLowerCase()));
  const memberName = [member.FirstName, member.LastName].filter(Boolean).join(' ').trim() || null;
  return {
    paymentId: p.PaymentId,
    amount: p.Amount,
    paymentDate: p.PaymentDate,
    status: p.Status,
    paymentMethod: p.PaymentMethod,
    processor: p.Processor ?? null,
    failureReason: p.FailureReason ?? null,
    processorTransactionId: p.ProcessorTransactionId?.trim() || null,
    invoiceId: p.InvoiceId ?? null,
    linkedInvoiceNumber: p.InvoiceNumber ?? null,
    linkedInvoiceBillingPeriodStart: p.InvoiceBillingPeriodStart ?? null,
    linkedInvoiceBillingPeriodEnd: p.InvoiceBillingPeriodEnd ?? null,
    linkedInvoiceStatus: p.InvoiceLinkedStatus ?? null,
    enrollmentId: p.EnrollmentId || null,
    locationId: p.LocationId ?? null,
    nextBillingDate: p.NextBillingDate ?? null,
    memberId: member.MemberId ?? null,
    groupId: member.GroupId ?? null,
    memberName,
    groupName: member.GroupName ?? null,
    productName: p.ProductName ?? null,
    transactionType: p.TransactionType ?? null,
    attemptNumber: p.AttemptNumber ?? null,
    consecutiveFailureCount: p.ConsecutiveFailureCount ?? null,
    isManualCharge,
    initiatedByName: (p.CreatedByName && String(p.CreatedByName).trim()) || null,
    recurringScheduleId: p.RecurringScheduleId ?? null,
    createdBy: p.CreatedBy ?? null,
    memberUserId: member.UserId ?? null,
    chargeSourceLabel: formatChargeSourceAttribution({
      paymentMethod: p.PaymentMethod,
      enrollmentId: p.EnrollmentId,
      recurringScheduleId: p.RecurringScheduleId,
      createdBy: p.CreatedBy,
      createdByName: p.CreatedByName,
      isManualCharge,
      memberUserId: member.UserId
    })
  };
}
