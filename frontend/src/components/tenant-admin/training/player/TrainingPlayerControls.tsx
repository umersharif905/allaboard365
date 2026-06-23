import React from 'react';

import { RotateCcw, SkipBack, SkipForward } from 'lucide-react';

type Props = {
  canNavigate: boolean;
  canPrev: boolean;
  canNext: boolean;
  completedSteps: number;
  totalSteps: number;
  onPrev: () => void;
  onNext: () => void;
  onRestart: () => void;
};

const TrainingPlayerControls: React.FC<Props> = ({
  canNavigate,
  canPrev,
  canNext,
  completedSteps,
  totalSteps,
  onPrev,
  onNext,
  onRestart
}) => {
  const safeTotal = Math.max(totalSteps, 0);
  const safeCompleted = Math.min(Math.max(completedSteps, 0), safeTotal);
  const progressPercent = safeTotal > 0 ? Math.round((safeCompleted / safeTotal) * 100) : 0;

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-5">
      <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
        Player Controls
      </h4>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onRestart}
          disabled={!canNavigate}
          className="inline-flex items-center gap-3 rounded border border-gray-300 bg-white px-5 py-3 text-2xl text-gray-700 hover:bg-gray-100 disabled:opacity-40"
        >
          <RotateCcw className="h-7 w-7" />
          Restart
        </button>
        <button
          type="button"
          onClick={onPrev}
          disabled={!canNavigate || !canPrev}
          className="inline-flex items-center gap-3 rounded border border-gray-300 bg-white px-5 py-3 text-2xl text-gray-700 hover:bg-gray-100 disabled:opacity-40"
        >
          <SkipBack className="h-7 w-7" />
          Previous
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canNavigate || !canNext}
          className="inline-flex items-center gap-3 rounded border border-gray-300 bg-white px-5 py-3 text-2xl text-gray-700 hover:bg-gray-100 disabled:opacity-40"
        >
          <SkipForward className="h-7 w-7" />
          Next
        </button>
      </div>

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <p className="text-[22px] font-medium uppercase tracking-wide text-gray-600">
            Completion
          </p>
          <p className="text-[22px] text-gray-600">
            {safeCompleted}/{safeTotal} steps ({progressPercent}%)
          </p>
        </div>
        <div className="h-4 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
    </div>
  );
};

export default TrainingPlayerControls;
