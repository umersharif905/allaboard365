/** Invoice + payment row display helpers for Group Billing tab (unit-testable). */

export type GroupBillingInvoiceLike = {
  InvoiceId?: string;
  Status: string;
  DueDate?: string;
};

export type GroupBillingPaymentLike = {
  InvoiceId?: string;
  Status: string;
};

export type InvoiceTableDisplay = {
  paymentInFlight: boolean;
  label: string;
  badgeClass: string;
  dueColumnAlert: 'none' | 'due-today' | 'overdue';
};

function isDueToday(dateString?: string): boolean {
  if (!dateString) return false;
  const dateOnly = dateString.split('T')[0];
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return dateOnly === todayStr;
}

/** If a charge is Pending/Sent for this invoice, show Pending even when invoice.Status is Paid. */
export function getInvoiceTableDisplay(
  invoice: GroupBillingInvoiceLike,
  payments: GroupBillingPaymentLike[]
): InvoiceTableDisplay {
  const invId = invoice.InvoiceId?.toUpperCase();
  const paymentInFlight = payments.some(
    (p) =>
      p.InvoiceId &&
      invId &&
      p.InvoiceId.toUpperCase() === invId &&
      (p.Status === 'Pending' || p.Status === 'Sent')
  );
  if (paymentInFlight) {
    return {
      paymentInFlight,
      label: 'Pending',
      badgeClass: 'bg-blue-100 text-blue-800',
      dueColumnAlert: 'none',
    };
  }
  if (invoice.Status === 'Overdue' && isDueToday(invoice.DueDate)) {
    return {
      paymentInFlight,
      label: 'Due Today',
      badgeClass: 'bg-yellow-100 text-yellow-800',
      dueColumnAlert: 'due-today',
    };
  }
  if (invoice.Status === 'Overdue') {
    return {
      paymentInFlight,
      label: 'Overdue',
      badgeClass: 'bg-red-100 text-red-800',
      dueColumnAlert: 'overdue',
    };
  }
  if (invoice.Status === 'Unpaid') {
    return {
      paymentInFlight,
      label: 'Unpaid',
      badgeClass: 'bg-yellow-100 text-yellow-800',
      dueColumnAlert: 'none',
    };
  }
  if (invoice.Status === 'Partial') {
    return {
      paymentInFlight,
      label: 'Partial',
      badgeClass: 'bg-blue-100 text-blue-800',
      dueColumnAlert: 'none',
    };
  }
  if (invoice.Status === 'Paid') {
    return {
      paymentInFlight,
      label: 'Paid',
      badgeClass: 'bg-green-100 text-green-800',
      dueColumnAlert: 'none',
    };
  }
  return {
    paymentInFlight,
    label: invoice.Status,
    badgeClass: 'bg-gray-100 text-gray-800',
    dueColumnAlert: 'none',
  };
}
