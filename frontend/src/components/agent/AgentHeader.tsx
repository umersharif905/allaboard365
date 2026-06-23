// frontend/src/components/agent/AgentHeader.tsx
import { AlertTriangle, CheckCircle2, GraduationCap, PlayCircle } from 'lucide-react';
import React from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { useAgentTrainingIncomplete } from '../../contexts/AgentTrainingIncompleteContext';

interface AgentHeaderProps {
  tenantName?: string;
  logoUrl?: string;
}

const AgentHeader: React.FC<AgentHeaderProps> = ({ tenantName, logoUrl }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { trainingSummary } = useAgentTrainingIncomplete();
  const summaryMode = searchParams.get('training-summary-mode') === 'advanced' ? 'advanced' : 'simple';
  const isOnAgentTrainingRoute = location.pathname.startsWith('/agent/training');

  const tone = trainingSummary?.statusTone || 'in_progress';
  const toneStyles =
    tone === 'complete'
      ? {
          chip: 'border-emerald-200 bg-emerald-50 text-emerald-800',
          icon: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />,
          label: 'On track'
        }
      : tone === 'needs_attention'
        ? {
            chip: 'border-amber-200 bg-amber-50 text-amber-800',
            icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden />,
            label: 'Needs attention'
          }
        : {
            chip: 'border-sky-200 bg-sky-50 text-sky-800',
            icon: <GraduationCap className="h-3.5 w-3.5" aria-hidden />,
            label: 'In progress'
          };

  const maxVisibleSegments = 24;
  const segments = trainingSummary?.moduleSegments || [];
  const visibleSegments = segments.slice(0, maxVisibleSegments);
  const hiddenSegmentsCount = Math.max(0, segments.length - visibleSegments.length);
  const modulesPercent =
    trainingSummary && trainingSummary.modulesTotal > 0
      ? Math.round((trainingSummary.modulesCompleted / trainingSummary.modulesTotal) * 100)
      : 0;

  const temperatureTone =
    modulesPercent > 66
      ? {
          chip: 'border-emerald-200 bg-emerald-100 text-emerald-900',
          label: 'good'
        }
      : modulesPercent > 33
        ? {
            chip: 'border-amber-200 bg-amber-100 text-amber-900',
            label: 'medium'
          }
        : {
            chip: 'border-rose-200 bg-rose-100 text-rose-900',
            label: 'at risk'
          };

  return (
    <header className="min-h-[88px] bg-white border-b border-gray-200 flex items-center justify-between px-6 py-3 gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-lg font-semibold text-gray-900 truncate">{tenantName || ''}</div>

        {trainingSummary?.hasAssignedTraining && summaryMode === 'simple' ? (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${toneStyles.chip}`}
              title={trainingSummary.statusLine}
            >
              {toneStyles.icon}
              {toneStyles.label}
            </span>

            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${temperatureTone.chip}`}
              title={`Module completion: ${modulesPercent}%`}
            >
              Modules {trainingSummary.modulesCompleted}/{trainingSummary.modulesTotal}
            </span>

            {!isOnAgentTrainingRoute ? (
              <button
                type="button"
                onClick={() => navigate('/agent/training')}
                className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
                title="Open training"
              >
                <PlayCircle className="h-3 w-3" aria-hidden />
                {trainingSummary.remainingItems > 0 ? 'Continue' : 'View'}
              </button>
            ) : null}
          </div>
        ) : null}

        {trainingSummary?.hasAssignedTraining && summaryMode === 'advanced' ? (
          <div className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${toneStyles.chip}`}
                title={trainingSummary.statusLine}
              >
                {toneStyles.icon}
                {toneStyles.label}
              </span>

              <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700">
                Modules:&nbsp;
                <strong className="font-semibold text-slate-900">
                  {trainingSummary.modulesCompleted}/{trainingSummary.modulesTotal}
                </strong>
              </span>

              {!isOnAgentTrainingRoute ? (
                <button
                  type="button"
                  onClick={() => navigate('/agent/training')}
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-sky-200 bg-white px-2 py-1 text-[11px] font-semibold text-sky-800 hover:bg-sky-50"
                  title="Open training"
                >
                  <PlayCircle className="h-3.5 w-3.5" aria-hidden />
                  {trainingSummary.remainingItems > 0 ? 'Continue training' : 'View training'}
                </button>
              ) : null}
            </div>

            <div className="mt-1 text-[11px] text-slate-600 truncate" title={trainingSummary.statusLine}>
              {trainingSummary.statusLine}
            </div>

            {visibleSegments.length > 0 ? (
              <div className="mt-1.5">
                <div className="mb-1 text-[11px] text-slate-500 truncate" title={trainingSummary.focusPackageTitle}>
                  Package progress: {trainingSummary.focusPackageTitle}
                </div>
                <div className="flex flex-wrap items-center gap-1" aria-label="Module completion segments">
                  {visibleSegments.map(segment => (
                    <span
                      key={segment.key}
                      className={`h-2.5 w-5 rounded-full border ${
                        segment.completed
                          ? 'border-emerald-300 bg-emerald-200'
                          : 'border-slate-300 bg-slate-200'
                      }`}
                      title={`${segment.label}: ${segment.completed ? 'Complete' : 'Pending'}`}
                      aria-hidden
                    />
                  ))}
                  {hiddenSegmentsCount > 0 ? (
                    <span className="text-[11px] text-slate-500">+{hiddenSegmentsCount} more</span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {logoUrl ? (
        <img
          src={logoUrl}
          alt={tenantName ? `${tenantName} logo` : 'Tenant logo'}
          className="h-12 w-auto shrink-0 object-contain"
        />
      ) : (
        <div className="h-12 w-12 shrink-0" />
      )}
    </header>
  );
};

export default AgentHeader;
