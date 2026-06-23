import { CheckCircle2, Circle } from 'lucide-react';
import React from 'react';

export type LibraryModuleStatus = {
  moduleId: string;
  title: string;
  required: boolean;
  order: number;
  completed: boolean;
  completedAt: string | null;
};

export type LibraryPackageStatus = {
  packageId: string;
  title: string;
  status: string | null;
  modulesTotal: number;
  modulesCompleted: number;
  modules: LibraryModuleStatus[];
};

export type ProductTrainingStatus = {
  productId: string;
  name: string;
  requiredForSell: boolean;
  passingScorePercent: number;
  questionsCount: number;
  modulesCount: number;
  lastScorePercent: number | null;
  passed: boolean;
  lastCompletedAt: string | null;
};

export type TrainingStatusPayload = {
  tenantId: string;
  agentId: string | null;
  /** Present on library-status; when false, agent portal training is off for the tenant. */
  agentPortalTrainingEnabled?: boolean;
  libraryPackages: LibraryPackageStatus[];
  productTraining: ProductTrainingStatus[];
};

export function hasAgentTrainingIncomplete(data: TrainingStatusPayload): boolean {
  if (data.agentPortalTrainingEnabled === false) {
    return false;
  }
  const libIncomplete = data.libraryPackages.filter(p => p.modulesCompleted < p.modulesTotal);
  return libIncomplete.length > 0;
}

type AgentTrainingStatusPanelProps = {
  data: TrainingStatusPayload;
  className?: string;
  /** e.g. close modal when navigating to training */
  trainingLinkOnClick?: () => void;
  /** When false, hides the “Open Agent training…” line (e.g. settings page uses a header button). Default true. */
  showProductTrainingLinkLine?: boolean;
};

const AgentTrainingStatusPanel: React.FC<AgentTrainingStatusPanelProps> = ({
  data,
  className = '',
  trainingLinkOnClick,
  showProductTrainingLinkLine = true
}) => {
  const libIncomplete = data.libraryPackages.filter(p => p.modulesCompleted < p.modulesTotal);

  return (
    <div className={`text-sm text-gray-700 ${className}`.trim()}>
      {data.libraryPackages.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 font-semibold text-gray-900">Assigned packages</h3>
          <ul className="space-y-3">
            {data.libraryPackages.map(pkg => (
              <li key={pkg.packageId} className="rounded border border-gray-100 bg-gray-50/80 px-3 py-2">
                <div className="font-medium text-gray-900">{pkg.title}</div>
                <div className="mt-1 text-xs text-gray-600">
                  {pkg.modulesCompleted} / {pkg.modulesTotal} modules completed
                </div>
                {pkg.modules.length > 0 && (
                  <ul className="mt-2 space-y-1 border-t border-gray-200 pt-2">
                    {pkg.modules.map(m => (
                      <li key={m.moduleId} className="flex items-start gap-2 text-xs">
                        {m.completed ? (
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" aria-hidden />
                        ) : (
                          <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
                        )}
                        <span className={m.completed ? 'text-gray-500 line-through' : ''}>{m.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {libIncomplete.length > 0 && (
        <p className="mt-4 rounded bg-amber-50 px-2 py-2 text-xs text-amber-900">
          You still have training to finish
          {libIncomplete.length ? ` (${libIncomplete.length} package(s) with modules left)` : ''}
          .
        </p>
      )}
    </div>
  );
};

export default AgentTrainingStatusPanel;
