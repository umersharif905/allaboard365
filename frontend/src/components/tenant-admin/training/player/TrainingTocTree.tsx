import React from 'react';

import { Check, ChevronDown, ChevronRight, ClipboardList } from 'lucide-react';

export type TocStepQuizStatus = 'not_started' | 'in_progress' | 'completed';

export type TocStepItem = {
  id: string;
  key: string;
  title: string;
  subtitle?: string;
  hasSectionQuiz?: boolean;
  quizStatus?: TocStepQuizStatus;
};

export type TocModuleItem = {
  id: string;
  title: string;
  modulePurpose: string;
  required: boolean;
  steps: TocStepItem[];
  missing?: boolean;
};

type Props = {
  modules: TocModuleItem[];
  expandedModuleIds: string[];
  selectedModuleId: string;
  selectedStepKey: string;
  /** Average completion across steps in each module (0–100) */
  modulePercentById?: Record<string, number>;
  /** Per step key (0–100) */
  stepPercentByKey?: Record<string, number>;
  onToggleModule: (moduleId: string) => void;
  onSelectModule: (moduleId: string) => void;
  onSelectStep: (stepKey: string) => void;
};

function quizStatusLabel(status: TocStepQuizStatus | undefined): string {
  if (status === 'completed') {
    return 'Quiz done';
  }
  if (status === 'in_progress') {
    return 'Quiz in progress';
  }
  return 'Quiz not started';
}

type SegmentedProgressRingProps = {
  percent: number;
  size?: number;
  strokeWidth?: number;
  segments?: number;
  colorClassName?: string;
  trackClassName?: string;
  textClassName?: string;
  title: string;
};

const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const SegmentedProgressRing: React.FC<SegmentedProgressRingProps> = ({
  percent,
  size = 28,
  strokeWidth = 2.75,
  segments = 10,
  colorClassName = 'text-emerald-600',
  trackClassName = 'text-gray-200',
  textClassName = 'text-[9px] text-gray-600',
  title
}) => {
  const safePercent = clampPercent(percent);
  const isComplete = safePercent >= 100;
  const filledSegments = Math.round((safePercent / 100) * segments);
  const center = size / 2;
  const radius = center - strokeWidth / 2;
  const circumference = 2 * Math.PI * radius;
  const segmentArc = circumference / segments;
  const dashLength = segmentArc * 0.72;

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      title={title}
      aria-label={`${title}: ${safePercent}%`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        {Array.from({ length: segments }, (_, index) => (
          <circle
            key={`track-${index}`}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${dashLength} ${circumference}`}
            strokeDashoffset={-index * segmentArc}
            className={trackClassName}
          />
        ))}
        {Array.from({ length: filledSegments }, (_, index) => (
          <circle
            key={`fill-${index}`}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${dashLength} ${circumference}`}
            strokeDashoffset={-index * segmentArc}
            className={colorClassName}
          />
        ))}
      </svg>
      <span className={`absolute font-semibold tabular-nums ${textClassName}`}>{safePercent}</span>
      {isComplete ? (
        <span className="absolute -right-1 -top-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-emerald-500 bg-emerald-500 text-white shadow-sm">
          <Check className="h-2.5 w-2.5" />
        </span>
      ) : null}
    </span>
  );
};

const TrainingTocTree: React.FC<Props> = ({
  modules,
  expandedModuleIds,
  selectedModuleId,
  selectedStepKey,
  modulePercentById = {},
  stepPercentByKey = {},
  onToggleModule,
  onSelectModule,
  onSelectStep
}) => {
  const expandedSet = new Set(expandedModuleIds);

  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 h-full min-h-[260px] lg:min-h-0 flex flex-col">
      <div className="space-y-3 flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1">
        {modules.map((module, moduleIndex) => {
          const isExpanded = expandedSet.has(module.id);
          const isSelectedModule = selectedModuleId === module.id;
          const moduleOrdinal = moduleIndex + 1;
          return (
            <div key={module.id} className="rounded-md border border-gray-200 bg-gray-50 p-3">
              <button
                type="button"
                onClick={() => {
                  if (!isSelectedModule) {
                    onSelectModule(module.id);
                  }
                  onToggleModule(module.id);
                }}
                className={`flex w-full min-w-0 items-center justify-between gap-3 rounded px-2 py-2.5 text-left ${
                  isSelectedModule ? 'bg-blue-100 text-blue-900' : 'bg-white text-gray-800'
                }`}
                aria-expanded={isExpanded}
                aria-label={`Module ${moduleOrdinal}: ${module.title}`}
              >
                <span className="flex min-w-0 flex-1 items-start gap-2.5">
                  <span
                    className={`mt-0.5 inline-flex h-7 min-w-[1.75rem] shrink-0 items-center justify-center rounded-full border px-2 text-xs font-bold tabular-nums ${
                      isSelectedModule
                        ? 'border-blue-400 bg-blue-200/70 text-blue-950'
                        : 'border-slate-300 bg-slate-100 text-slate-800'
                    }`}
                    title={`Module ${moduleOrdinal}`}
                  >
                    {moduleOrdinal}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-semibold leading-snug">{module.title}</span>
                    <span
                      className={`mt-1 block text-sm ${
                        isSelectedModule ? 'text-blue-800/85' : 'text-gray-600'
                      }`}
                    >
                      {module.steps.length} step(s) | {module.required ? 'Required' : 'Optional'}
                      {module.missing ? ' | Missing module reference' : ''}
                    </span>
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-2">
                  <SegmentedProgressRing
                    percent={modulePercentById[module.id] ?? 0}
                    size={30}
                    strokeWidth={3}
                    title="Module completion"
                    colorClassName="text-blue-600"
                    trackClassName="text-blue-100"
                    textClassName="text-[9px] text-blue-700"
                  />
                  <span
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700"
                    aria-hidden
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </span>
                </span>
              </button>

              {isExpanded && (
                <div className="border-t border-gray-200/80 px-2 pb-2 pt-3 space-y-2">
                  {module.steps.map((step, index) => {
                    const isSelectedStep = selectedStepKey === step.key;
                    return (
                      <button
                        key={step.id}
                        type="button"
                        onClick={() => onSelectStep(step.key)}
                        className={`flex w-full items-start justify-between gap-2 rounded border px-2 py-2 text-left text-sm ${
                          isSelectedStep
                            ? 'border-blue-300 bg-blue-50 text-blue-900'
                            : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-medium uppercase tracking-wide text-gray-500">
                            Step {index + 1}
                            {step.subtitle ? ` | ${step.subtitle}` : ''}
                          </span>
                          <span className="mt-0.5 block font-medium">{step.title}</span>
                          {step.hasSectionQuiz ? (
                            <span className="mt-1 flex flex-wrap items-center gap-1.5">
                              <span
                                className="inline-flex items-center gap-0.5 rounded-full border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-900"
                                title="This step includes a section quiz"
                              >
                                <ClipboardList className="h-3 w-3 shrink-0" aria-hidden />
                                Quiz
                              </span>
                              <span
                                className={`text-[10px] font-medium ${
                                  step.quizStatus === 'completed'
                                    ? 'text-emerald-700'
                                    : step.quizStatus === 'in_progress'
                                      ? 'text-amber-700'
                                      : 'text-gray-500'
                                }`}
                                title={quizStatusLabel(step.quizStatus)}
                              >
                                {quizStatusLabel(step.quizStatus)}
                              </span>
                            </span>
                          ) : null}
                        </span>
                        <SegmentedProgressRing
                          percent={stepPercentByKey[step.key] ?? 0}
                          size={26}
                          strokeWidth={2.5}
                          title="Step completion"
                          colorClassName={isSelectedStep ? 'text-blue-700' : 'text-emerald-600'}
                          trackClassName={isSelectedStep ? 'text-blue-100' : 'text-gray-200'}
                          textClassName={isSelectedStep ? 'text-[8px] text-blue-800' : 'text-[8px] text-gray-700'}
                        />
                      </button>
                    );
                  })}
                  {module.steps.length === 0 && (
                    <div className="rounded border border-dashed border-gray-300 bg-white p-2 text-[11px] text-gray-500">
                      No steps found for this module.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {modules.length === 0 && (
          <div className="rounded border border-dashed border-gray-300 p-2 text-xs text-gray-500">
            No modules in this package.
          </div>
        )}
      </div>
    </div>
  );
};

export default TrainingTocTree;
