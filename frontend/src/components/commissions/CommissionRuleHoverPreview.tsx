import { Eye } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  buildCommissionRuleQuickPreview,
  commissionRulePreviewModeLabel,
  type CommissionRulePreviewInput,
} from '../../utils/commissionRuleQuickPreview';

type CommissionRuleHoverPreviewProps = {
  rule: CommissionRulePreviewInput;
  className?: string;
};

export const CommissionRuleHoverPreview: React.FC<CommissionRuleHoverPreviewProps> = ({
  rule,
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lines = useMemo(() => buildCommissionRuleQuickPreview(rule), [rule]);
  const modeLabel = useMemo(() => commissionRulePreviewModeLabel(rule), [rule]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const showPreview = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos({ top: rect.top - 8, left: rect.left + rect.width / 2 });
      setOpen(true);
    }, 120);
  };

  const hidePreview = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setOpen(false);
    setPos(null);
  };

  const popover =
    open &&
    pos &&
    createPortal(
      <div
        className="pointer-events-none fixed z-[200] -translate-x-1/2 -translate-y-full"
        style={{ top: pos.top, left: pos.left }}
        role="tooltip"
      >
        <div className="rounded-lg border border-gray-200 bg-white shadow-lg px-3 py-2 min-w-[220px] max-w-[300px]">
          <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">
            {modeLabel}
          </div>
          {lines.length === 0 ? (
            <p className="text-xs text-gray-500">No payout amounts configured</p>
          ) : (
            <ul className="space-y-1">
              {lines.map((line, idx) => (
                <li key={`${line.tier}-${idx}`} className="flex items-start justify-between gap-2 text-xs">
                  <span className="text-gray-600 truncate max-w-[42%]" title={line.tier}>
                    {line.tier}
                  </span>
                  <span className="text-gray-900 font-medium text-right leading-snug">{line.amount}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>,
      document.body
    );

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`inline-flex items-center justify-center p-1.5 rounded-md text-gray-500 hover:text-oe-primary hover:bg-oe-light/60 transition-colors ${className}`}
        aria-label={`Preview commission for ${rule.RuleName || 'rule'}`}
        onMouseEnter={showPreview}
        onMouseLeave={hidePreview}
        onFocus={showPreview}
        onBlur={hidePreview}
      >
        <Eye className="h-4 w-4" />
      </button>
      {popover}
    </>
  );
};

export default CommissionRuleHoverPreview;
