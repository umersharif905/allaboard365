import { useState } from 'react';
import { Check, AlertTriangle } from 'lucide-react';
import {
  SHARE_REQUEST_STEPS,
  SHARE_REQUEST_STEP_TOOLTIPS,
  mapShareRequestStatusToStep,
  type ShareRequestTerminalVariant
} from '../../types/shareRequest.types';

interface ShareRequestProgressBarProps {
  status: string;
}

// Tailwind color classes per terminal variant for the final "Processed" step.
const TERMINAL_CIRCLE: Record<ShareRequestTerminalVariant, string> = {
  success: 'bg-oe-success border-oe-success text-white',
  denied: 'bg-red-500 border-red-500 text-white',
  withdrawn: 'bg-gray-400 border-gray-400 text-white'
};

const TERMINAL_LABEL: Record<ShareRequestTerminalVariant, string> = {
  success: 'text-oe-success',
  denied: 'text-red-600',
  withdrawn: 'text-gray-500'
};

/** Hover copy for a given step index, honoring the terminal variant on step 3. */
function tooltipForStep(
  index: number,
  terminalVariant: ShareRequestTerminalVariant | null
): string {
  switch (index) {
    case 0:
      return SHARE_REQUEST_STEP_TOOLTIPS.Submitted;
    case 1:
      return SHARE_REQUEST_STEP_TOOLTIPS.Acknowledged;
    case 2:
      return SHARE_REQUEST_STEP_TOOLTIPS.Processing;
    case 3:
    default:
      if (terminalVariant === 'denied') return SHARE_REQUEST_STEP_TOOLTIPS.ProcessedDenied;
      if (terminalVariant === 'withdrawn') return SHARE_REQUEST_STEP_TOOLTIPS.ProcessedWithdrawn;
      return SHARE_REQUEST_STEP_TOOLTIPS.ProcessedSuccess;
  }
}

export default function ShareRequestProgressBar({ status }: ShareRequestProgressBarProps) {
  const { stepIndex, terminalVariant, actionNeeded } = mapShareRequestStatusToStep(status);
  const [hoveredStep, setHoveredStep] = useState<number | null>(null);

  return (
    <div className="w-full">
      <div className="flex items-start">
        {SHARE_REQUEST_STEPS.map((label, index) => {
          const isCompleted = index < stepIndex;
          const isActive = index === stepIndex;
          const isLast = index === SHARE_REQUEST_STEPS.length - 1;
          const isTerminalStep = isActive && index === 3 && terminalVariant;

          // Circle styling.
          let circleClass = 'bg-white border-gray-300 text-gray-400'; // pending
          if (isCompleted) {
            circleClass = 'bg-oe-success border-oe-success text-white';
          } else if (isTerminalStep) {
            circleClass = TERMINAL_CIRCLE[terminalVariant];
          } else if (isActive) {
            circleClass = 'bg-oe-primary border-oe-primary text-white';
          }

          // Label styling.
          let labelClass = 'text-gray-400';
          if (isCompleted) {
            labelClass = 'text-oe-success';
          } else if (isTerminalStep) {
            labelClass = TERMINAL_LABEL[terminalVariant];
          } else if (isActive) {
            labelClass = 'text-oe-dark font-medium';
          }

          const tooltip = tooltipForStep(index, terminalVariant);

          // The connector leading INTO the active step fades from green (done) to
          // the active step's own colour, so the green→blue hand-off reads as a
          // smooth gradient rather than an abrupt colour change. The preceding
          // half-connector stays solid green, so the gradient is seamless.
          const activeToColor =
            index === 3 && terminalVariant
              ? terminalVariant === 'denied'
                ? 'to-red-500'
                : terminalVariant === 'withdrawn'
                  ? 'to-gray-400'
                  : 'to-oe-success'
              : 'to-oe-primary';
          const leftConnectorClass =
            index === 0
              ? 'invisible'
              : index < stepIndex
                ? 'bg-oe-success'
                : index === stepIndex
                  ? `bg-gradient-to-r from-oe-success ${activeToColor}`
                  : 'bg-gray-200';

          return (
            <div
              key={label}
              className="flex-1 flex flex-col items-center min-w-0"
              onMouseEnter={() => setHoveredStep(index)}
              onMouseLeave={() => setHoveredStep(null)}
            >
              <div className="flex items-center w-full">
                {/* left connector (hidden on first) — gradient into the active step */}
                <div className={`h-1 flex-1 ${leftConnectorClass}`} />
                {/* circle */}
                <div className="relative">
                  <div
                    className={`flex items-center justify-center w-8 h-8 rounded-full border-2 text-sm font-semibold shrink-0 ${circleClass}`}
                  >
                    {isCompleted ? (
                      <Check className="w-4 h-4" />
                    ) : isTerminalStep && terminalVariant === 'success' ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      index + 1
                    )}
                  </div>
                  {hoveredStep === index && (
                    <div className="absolute z-10 bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-md bg-gray-900 text-white text-xs leading-snug p-2 shadow-lg">
                      {tooltip}
                      <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                    </div>
                  )}
                </div>
                {/* right connector (hidden on last) */}
                <div
                  className={`h-1 flex-1 ${
                    isLast
                      ? 'invisible'
                      : index < stepIndex
                        ? 'bg-oe-success'
                        : 'bg-gray-200'
                  }`}
                />
              </div>
              <span className={`mt-2 text-xs text-center px-1 ${labelClass}`}>
                {label}
              </span>
            </div>
          );
        })}
      </div>

      {actionNeeded && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{SHARE_REQUEST_STEP_TOOLTIPS.ActionNeeded}</span>
        </div>
      )}
    </div>
  );
}
