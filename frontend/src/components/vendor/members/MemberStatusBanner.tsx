import { AlertTriangle, ArrowUpRight, Info } from 'lucide-react';

export type MemberStatus = 'Active' | 'Terminated' | 'PendingMigration' | 'Inactive';

interface MemberStatusBannerProps {
  status: MemberStatus | string | undefined;
  migrationSource?: string | null;
  rawStatus?: string | null;
}

const MemberStatusBanner = ({ status, migrationSource, rawStatus }: MemberStatusBannerProps) => {
  if (!status || status === 'Active') return null;

  if (status === 'Terminated') {
    return (
      <div className="relative overflow-hidden border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0 relative z-10">
          <div className="font-semibold uppercase tracking-wide">Terminated member</div>
          <div className="text-red-700/90 text-xs mt-0.5">
            This member&rsquo;s coverage has ended. Details remain visible for reference.
            {rawStatus && rawStatus !== 'Terminated' ? ` (Status: ${rawStatus})` : ''}
          </div>
        </div>
        <span
          aria-hidden="true"
          className="pointer-events-none select-none absolute inset-y-0 right-4 flex items-center text-red-200/70 font-extrabold text-3xl tracking-widest"
        >
          TERMINATED
        </span>
      </div>
    );
  }

  if (status === 'PendingMigration') {
    return (
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
        <ArrowUpRight className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold">
            Pending migration{migrationSource ? ` from ${migrationSource}` : ''}
          </div>
          <div className="text-amber-800/90 text-xs mt-0.5">
            This member was imported as a placeholder and has not yet activated on AllAboard365. Available
            data is shown below; some fields may be empty until migration completes.
          </div>
        </div>
      </div>
    );
  }

  if (status === 'Inactive') {
    return (
      <div className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-700 flex items-center gap-2">
        <Info className="h-3.5 w-3.5 shrink-0" />
        <span>Inactive member{rawStatus && rawStatus !== 'Inactive' ? ` (${rawStatus})` : ''}</span>
      </div>
    );
  }

  return null;
};

export default MemberStatusBanner;
