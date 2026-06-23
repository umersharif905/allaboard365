import { useState } from 'react';
import {
  Banknote,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Power,
  RotateCcw
} from 'lucide-react';
import {
  useMemberDirectDeposits,
  useActivateMemberDirectDeposit,
  useDeactivateMemberDirectDeposit,
  useRevealMemberDirectDeposit
} from '../../hooks/members/useMemberDirectDeposits';
import {
  type MemberDirectDepositRevealed,
  type MemberDirectDepositSummary
} from '../../services/memberDirectDeposit.service';
import DirectDepositAddModal from './DirectDepositAddModal';
import { useAuth } from '../../contexts/AuthContext';

const READ_ROLES = new Set(['TenantAdmin', 'TenantAccounting', 'SysAdmin']);

interface Props {
  memberId: string;
  tenantId?: string | null;
  /** Whether the current user can mutate / reveal records. Defaults to true; pass false to render read-only. */
  canEdit?: boolean;
}

function isActive(row: MemberDirectDepositSummary): boolean {
  return row.IsActive === true || row.IsActive === 1;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '';
  try {
    return new Date(s).toLocaleDateString();
  } catch {
    return '';
  }
}

const DirectDepositCard = ({ memberId, tenantId, canEdit = true }: Props) => {
  const { user } = useAuth();
  const userRoles: string[] = [
    ...(user?.roles ?? []),
    ...(user?.currentRole ? [user.currentRole] : [])
  ];
  const canRead = userRoles.some((r) => READ_ROLES.has(r));

  const { data: rows = [], isLoading, isError, error } = useMemberDirectDeposits(
    memberId,
    tenantId,
    { enabled: canRead }
  );
  const activateMutation = useActivateMemberDirectDeposit(memberId, tenantId);
  const deactivateMutation = useDeactivateMemberDirectDeposit(memberId, tenantId);
  const revealMutation = useRevealMemberDirectDeposit(memberId, tenantId);

  const [showAdd, setShowAdd] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, MemberDirectDepositRevealed>>({});

  const active = rows.find(isActive) || null;
  const inactive = rows.filter((r) => !isActive(r));

  const onReveal = async (directDepositId: string) => {
    if (revealed[directDepositId]) {
      // Toggle off
      const next = { ...revealed };
      delete next[directDepositId];
      setRevealed(next);
      return;
    }
    if (!window.confirm(
      'Reveal full account and routing numbers? This action will be recorded in the audit log.'
    )) {
      return;
    }
    try {
      const resp = await revealMutation.mutateAsync(directDepositId);
      setRevealed((prev) => ({ ...prev, [directDepositId]: resp.data }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to reveal direct deposit';
      window.alert(msg);
    }
  };

  const onActivate = async (directDepositId: string) => {
    if (!window.confirm(
      'Make this direct deposit the active reimbursement destination? Any other active record will be deactivated.'
    )) {
      return;
    }
    try {
      await activateMutation.mutateAsync(directDepositId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to activate direct deposit';
      window.alert(msg);
    }
  };

  const onDeactivate = async (directDepositId: string) => {
    if (!window.confirm(
      'Deactivate this direct deposit? Reimbursements will not be issued until a new direct deposit is set as active.'
    )) {
      return;
    }
    try {
      await deactivateMutation.mutateAsync(directDepositId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to deactivate direct deposit';
      window.alert(msg);
    }
  };

  const renderRow = (row: MemberDirectDepositSummary) => {
    const active = isActive(row);
    const reveal = revealed[row.DirectDepositId];
    return (
      <div
        key={row.DirectDepositId}
        className={`rounded-md border ${active ? 'border-oe-primary/40 bg-oe-light/30' : 'border-gray-200 bg-white'} p-3`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {active ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-oe-primary px-2 py-0.5 text-xs font-medium text-white">
                  <CheckCircle2 className="h-3 w-3" /> Active
                </span>
              ) : (
                <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
                  Inactive
                </span>
              )}
              <span className="text-sm font-semibold text-gray-900">
                {row.BankName} <span className="font-normal text-gray-500">·</span> {row.BankAccountType}
              </span>
            </div>
            <div className="mt-1 font-mono text-sm text-gray-800">
              Account&nbsp;
              <span className="text-gray-500">····</span>
              <span>{reveal ? reveal.AccountNumber.slice(-Math.max(reveal.AccountNumber.length - 4, 0)) : ''}</span>
              <span className="font-semibold">{reveal ? reveal.AccountNumber.slice(-4) : row.AccountNumberLast4}</span>
            </div>
            <div className="font-mono text-sm text-gray-800">
              Routing&nbsp;
              {reveal ? (
                <span>{reveal.RoutingNumber}</span>
              ) : (
                <>
                  <span className="text-gray-500">·····</span>
                  <span className="font-semibold">{row.RoutingNumberLast4}</span>
                </>
              )}
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {row.AccountHolderName}
              {row.CreatedDate ? ` · added ${fmtDate(row.CreatedDate)}` : ''}
              {row.Source ? ` · ${row.Source === 'PublicFormSubmission' ? 'from sharing form' : 'manual entry'}` : ''}
              {!active && row.DeactivatedDate ? ` · deactivated ${fmtDate(row.DeactivatedDate)}` : ''}
            </div>
          </div>

          {canEdit ? (
            <div className="flex flex-shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onReveal(row.DirectDepositId)}
                className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                disabled={revealMutation.isPending}
              >
                {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {reveal ? 'Hide' : 'Reveal'}
              </button>
              {active ? (
                <button
                  type="button"
                  onClick={() => onDeactivate(row.DirectDepositId)}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                  disabled={deactivateMutation.isPending}
                >
                  <Power className="h-3.5 w-3.5" />
                  Deactivate
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onActivate(row.DirectDepositId)}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  disabled={activateMutation.isPending}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Make active
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  if (!canRead) return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Banknote className="h-5 w-5 text-oe-primary" aria-hidden />
          <h3 className="text-base font-semibold text-gray-900">Direct deposit (reimbursements)</h3>
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : isError ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {(error as { message?: string } | null)?.message || 'Failed to load direct deposit records.'}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-600">
          No direct deposit on file. Records are auto-created when a member submits a sharing
          request with banking info, or admins can add one manually.
        </p>
      ) : (
        <div className="space-y-2">
          {active ? renderRow(active) : (
            <p className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
              No active direct deposit. Reimbursements will be paid by paper check until one is set
              active.
            </p>
          )}

          {inactive.length > 0 ? (
            <div>
              <button
                type="button"
                onClick={() => setShowInactive((s) => !s)}
                className="mt-2 text-xs font-medium text-oe-primary hover:underline"
              >
                {showInactive ? 'Hide' : 'Show'} previous accounts ({inactive.length})
              </button>
              {showInactive ? (
                <div className="mt-2 space-y-2">{inactive.map(renderRow)}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {showAdd ? (
        <DirectDepositAddModal
          memberId={memberId}
          tenantId={tenantId}
          onClose={() => setShowAdd(false)}
        />
      ) : null}
    </div>
  );
};

export default DirectDepositCard;
