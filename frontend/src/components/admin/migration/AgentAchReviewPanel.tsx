import { Building2 } from 'lucide-react';
import { useEffect } from 'react';
import {
  AgentMigrationAchPayload,
  AgentMigrationBrokerNode,
  AgentMigrationDraftJson,
  AgentMigrationPayablesIndex
} from '../../../services/e123Migration.service';

interface Props {
  brokers: AgentMigrationBrokerNode[];
  payables?: AgentMigrationPayablesIndex | null;
  draftJson: AgentMigrationDraftJson;
  achByBrokerId: Record<string, AgentMigrationAchPayload>;
  onAchChange: (next: Record<string, AgentMigrationAchPayload>) => void;
  onDraftChange: (draft: AgentMigrationDraftJson) => void;
}

export default function AgentAchReviewPanel({
  brokers,
  payables,
  draftJson,
  achByBrokerId,
  onAchChange,
  onDraftChange
}: Props) {
  const needsAch = brokers.filter(
    (b) => (b.action === 'create_new' || b.action === 'promote_user')
      && !draftJson.nodeOverrides?.[b.e123BrokerId]?.excluded
      && !draftJson.nodeOverrides?.[String(b.e123BrokerId)]?.excluded
  );

  useEffect(() => {
    if (!payables?.agents) return;
    const next: Record<string, AgentMigrationAchPayload> = {};
    for (const broker of needsAch) {
      const key = String(broker.e123BrokerId);
      const row = payables.agents[key];
      const skip = !!draftJson.nodeOverrides?.[broker.e123BrokerId]?.skipAch
        || !!draftJson.nodeOverrides?.[String(broker.e123BrokerId)]?.skipAch;
      next[key] = row?.ach
        ? { ach: row.ach, skip }
        : { ach: null, skip };
    }
    onAchChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed ACH once from payables index
  }, [payables]);

  const handleSkip = (brokerId: number, skip: boolean) => {
    onDraftChange({
      ...draftJson,
      nodeOverrides: {
        ...draftJson.nodeOverrides,
        [brokerId]: {
          ...(draftJson.nodeOverrides?.[brokerId] || draftJson.nodeOverrides?.[String(brokerId)]),
          skipAch: skip
        }
      }
    });
    const key = String(brokerId);
    onAchChange({
      ...achByBrokerId,
      [key]: { ...achByBrokerId[key], skip }
    });
  };

  if (needsAch.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
        No new agents to import — ACH review not required.
      </div>
    );
  }

  const withAch = needsAch.filter((b) => achByBrokerId[String(b.e123BrokerId)]?.ach).length;
  const missing = needsAch.length - withAch;

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
          <Building2 className="h-4 w-4 text-gray-500" />
          Bank info from payables
        </div>
        <p className="text-xs text-gray-500 mt-1">
          {withAch} of {needsAch.length} new agents have routing + account in the payables file.
          {missing > 0 ? ` ${missing} missing — skip or add after import.` : ''}
        </p>
      </div>
      <div className="divide-y divide-gray-100 max-h-[min(70vh,52rem)] overflow-y-auto">
        {needsAch.map((broker) => {
          const key = String(broker.e123BrokerId);
          const payload = achByBrokerId[key];
          const skip = !!draftJson.nodeOverrides?.[broker.e123BrokerId]?.skipAch
            || !!payload?.skip;
          const payablesRow = payables?.agents?.[key];

          return (
            <div key={broker.e123BrokerId} className="px-4 py-3 text-sm flex flex-wrap items-start gap-3">
              <div className="min-w-[180px]">
                <div className="font-medium text-gray-900">{broker.label}</div>
                <div className="text-xs text-gray-500 font-mono">{broker.e123BrokerId}</div>
                {payablesRow && payablesRow.overrideLineCount > 0 ? (
                  <div className="text-[11px] text-gray-500 mt-1">
                    {payablesRow.sellerLineCount} seller / {payablesRow.overrideLineCount} upline lines in CSV
                  </div>
                ) : null}
              </div>
              <div className="flex-1 min-w-[200px]">
                {payload?.ach ? (
                  <div className="text-xs text-gray-700 space-y-0.5">
                    <div>{payload.ach.bankName || 'Bank'}</div>
                    <div>Routing: {payload.ach.routingNumber}</div>
                    <div>Account: ****{payload.ach.accountNumberLast4 || payload.ach.accountNumber?.slice(-4)}</div>
                    <div>Type: {payload.ach.accountType}</div>
                  </div>
                ) : (
                  <span className="text-xs text-amber-800">No ACH on payables rows for this payee</span>
                )}
              </div>
              <label className="inline-flex items-center gap-1 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={skip}
                  onChange={(e) => handleSkip(broker.e123BrokerId, e.target.checked)}
                />
                Skip ACH
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
