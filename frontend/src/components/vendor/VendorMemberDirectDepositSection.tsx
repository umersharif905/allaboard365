import { useEffect, useState } from 'react';
import { Banknote, CheckCircle2, Eye, EyeOff, Loader2 } from 'lucide-react';
import {
  VendorMemberDirectDepositService,
  type MemberDirectDepositSummary,
  type MemberDirectDepositRevealed
} from '../../services/vendor/vendorMemberDirectDeposit.service';

interface Props {
  memberId: string;
  /** Optional title override (e.g. "Direct Deposit (Reimbursement)"). */
  title?: string;
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

const VendorMemberDirectDepositSection = ({
  memberId,
  title = 'Direct deposit (member reimbursement)'
}: Props) => {
  const [rows, setRows] = useState<MemberDirectDepositSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, MemberDirectDepositRevealed>>({});
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  useEffect(() => {
    if (!memberId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    VendorMemberDirectDepositService.list(memberId)
      .then((res) => {
        if (cancelled) return;
        setRows(Array.isArray(res.data) ? res.data : []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load direct deposits');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [memberId]);

  const onReveal = async (directDepositId: string) => {
    if (revealed[directDepositId]) {
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
      setRevealingId(directDepositId);
      const resp = await VendorMemberDirectDepositService.reveal(memberId, directDepositId);
      setRevealed((prev) => ({ ...prev, [directDepositId]: resp.data }));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to reveal direct deposit');
    } finally {
      setRevealingId(null);
    }
  };

  const active = rows.find(isActive) || null;
  const inactive = rows.filter((r) => !isActive(r));

  const renderRow = (row: MemberDirectDepositSummary) => {
    const a = isActive(row);
    const reveal = revealed[row.DirectDepositId];
    return (
      <div
        key={row.DirectDepositId}
        className={`rounded-md border ${a ? 'border-oe-primary/40 bg-oe-light/30' : 'border-gray-200 bg-white'} p-3`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {a ? (
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
              {reveal ? (
                <span>{reveal.AccountNumber}</span>
              ) : (
                <>
                  <span className="text-gray-500">····</span>
                  <span className="font-semibold">{row.AccountNumberLast4}</span>
                </>
              )}
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
              {!a && row.DeactivatedDate ? ` · deactivated ${fmtDate(row.DeactivatedDate)}` : ''}
            </div>
          </div>

          <div className="flex flex-shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onReveal(row.DirectDepositId)}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              disabled={revealingId === row.DirectDepositId}
            >
              {revealingId === row.DirectDepositId ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : reveal ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
              {reveal ? 'Hide' : 'Reveal'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="mb-4 flex items-center gap-2">
        <Banknote className="h-5 w-5 text-oe-primary" aria-hidden />
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-600">
          No direct deposit on file for this member's household. Reimbursements will be paid by paper check.
        </p>
      ) : (
        <div className="space-y-2">
          {active ? renderRow(active) : (
            <p className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
              No active direct deposit. Reimbursements will be paid by paper check until one is set active.
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
              {showInactive ? <div className="mt-2 space-y-2">{inactive.map(renderRow)}</div> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default VendorMemberDirectDepositSection;
