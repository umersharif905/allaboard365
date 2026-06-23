import { useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import GroupAccountCreditPanel from './GroupAccountCreditPanel';

interface GroupInvoice {
  InvoiceId: string;
  InvoiceNumber?: string | null;
  BillingPeriodStart?: string | null;
  Status?: string | null;
  TotalAmount?: number | string | null;
  PaidAmount?: number | string | null;
  CreditAmount?: number | string | null;
  BalanceDue?: number | string | null;
}

interface Props {
  groupId: string;
  groupName?: string;
  tenantId?: string;
  canManageCredits?: boolean;
  invoices?: GroupInvoice[];
  /**
   * Splits the panel so the underpaid banner can stay at the top of a layout
   * while the credit card sits next to the invoices section.
   *  - 'all'         : default; both pieces.
   *  - 'banner-only' : just the underpaid banner.
   *  - 'credit-only' : just the credit card.
   */
  layout?: 'all' | 'banner-only' | 'credit-only';
}

/**
 * Surfaces GROUP-scoped account credit and underpaid invoices for a group.
 * Credit ledger is keyed off oe.HouseholdCreditEntries.GroupId — credits
 * apply directly to the group's monthly Group invoice.
 */
export default function GroupCreditAndUnderpaidPanel({
  groupId,
  groupName,
  tenantId,
  canManageCredits,
  invoices,
  layout = 'all'
}: Props) {
  const underpaid = useMemo(() => {
    return (invoices || []).filter(inv => {
      const status = String(inv.Status || '').toLowerCase();
      const balance = Number(inv.BalanceDue || 0);
      return balance > 0.005 && (status === 'partial' || status === 'overdue' || status === 'unpaid');
    });
  }, [invoices]);
  const totalDue = underpaid.reduce((acc, inv) => acc + (Number(inv.BalanceDue) || 0), 0);

  const showCredit = layout === 'all' || layout === 'credit-only';
  const showBanner = layout === 'all' || layout === 'banner-only';

  return (
    <div className="space-y-3">
      {showCredit && (
        <GroupAccountCreditPanel
          groupId={groupId}
          groupName={groupName}
          tenantId={tenantId}
          canManageCredits={canManageCredits}
          invoices={invoices}
        />
      )}

      {showBanner && underpaid.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg p-3 flex items-start gap-2">
          <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <span className="font-semibold">Owes ${totalDue.toFixed(2)}</span> across {underpaid.length} invoice{underpaid.length === 1 ? '' : 's'}.
            Past-due / underpaid balances are not auto-charged — admins can collect manually from the invoices section below.
          </div>
        </div>
      )}
    </div>
  );
}
