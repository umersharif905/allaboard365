import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  reasonText: string;
  className: string;
  children: React.ReactNode;
};

function usePrefersCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const apply = () => setCoarse(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return coarse;
}

/**
 * Failed payment status pill: shows reason in a portaled panel on hover (no delay)
 * or on tap/click for touch / coarse pointers. Closes on outside press or Escape.
 */
export const FailedPaymentReasonBadge: React.FC<Props> = ({ reasonText, className, children }) => {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipId = useId();
  const coarse = usePrefersCoarsePointer();

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current != null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    if (coarse) return;
    cancelClose();
    closeTimerRef.current = setTimeout(() => setOpen(false), 100);
  }, [coarse, cancelClose]);

  const reveal = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const pop = popoverRef.current;
    if (!anchor || !pop) return;
    const ar = anchor.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    let top = ar.bottom + gap;
    let left = ar.left;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    if (left + pw > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - pw - margin);
    }
    if (left < margin) left = margin;
    if (top + ph > window.innerHeight - margin) {
      top = Math.max(margin, ar.top - ph - gap);
    }
    setCoords({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const raf = requestAnimationFrame(reposition);
    return () => cancelAnimationFrame(raf);
  }, [open, reasonText, reposition]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => reposition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const portalTarget = typeof document !== 'undefined' ? document.body : null;

  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        className={`${className} focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-red-500/70`}
        aria-expanded={open}
        aria-controls={tipId}
        aria-describedby={open ? tipId : undefined}
        onMouseEnter={() => {
          if (!coarse) reveal();
        }}
        onMouseLeave={() => {
          if (!coarse) scheduleClose();
        }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {children}
      </button>
      {open &&
        portalTarget &&
        createPortal(
          <div
            ref={popoverRef}
            id={tipId}
            role="tooltip"
            className="fixed z-[10000] max-w-sm min-w-[12rem] rounded-md border border-gray-200 bg-white px-3 py-2 text-xs font-normal text-gray-800 shadow-lg"
            style={{ top: coords.top, left: coords.left }}
            onMouseEnter={() => {
              if (!coarse) cancelClose();
            }}
            onMouseLeave={() => {
              if (!coarse) scheduleClose();
            }}
          >
            <span className="block whitespace-pre-wrap text-left">{reasonText}</span>
          </div>,
          portalTarget
        )}
    </>
  );
};
