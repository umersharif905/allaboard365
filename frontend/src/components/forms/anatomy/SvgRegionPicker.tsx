// frontend/src/components/forms/anatomy/SvgRegionPicker.tsx
// Renders an SVG body diagram keyed from svgRegistry. Clickable shapes must
// carry data-region="<id>". Falls back to nothing when the registry entry is
// undefined — the caller renders button fallbacks instead.

import { useRef, useEffect } from 'react';
import { ANATOMY_SVGS } from './svgRegistry';

export interface SvgRegionPickerProps {
  /** Key into ANATOMY_SVGS (e.g. "overview", "head"). */
  registryKey: string;
  selectedRegion: string | null;
  onSelect: (regionId: string) => void;
}

const HOVER_CLASS = 'svg-region-hover';
const SELECTED_CLASS = 'svg-region-selected';

// Inject shared styles once — avoids a <style> tag per mount.
let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    [data-region] { transition: fill 0.15s, stroke 0.15s; }
    .${HOVER_CLASS} { fill: rgba(214,238,248,0.75) !important; stroke: #1f8dbf !important; stroke-width: 2px !important; }
    .${SELECTED_CLASS} { fill: rgba(31,141,191,0.35) !important; stroke: #1f8dbf !important; stroke-width: 2.5px !important; }
  `;
  document.head.appendChild(style);
}

export default function SvgRegionPicker({
  registryKey,
  selectedRegion,
  onSelect,
}: SvgRegionPickerProps) {
  const svgString = ANATOMY_SVGS[registryKey];
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !svgString) return;

    ensureStyles();

    const els = wrapper.querySelectorAll<HTMLElement>('[data-region]');

    const handlers: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];

    const addListener = (el: HTMLElement, type: string, fn: EventListener) => {
      el.addEventListener(type, fn);
      handlers.push({ el, type, fn });
    };

    els.forEach((el) => {
      el.style.cursor = 'pointer';
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute(
        'aria-label',
        el.dataset.region ?? el.getAttribute('aria-label') ?? 'region',
      );

      // Sync selected state
      const syncSelected = () => {
        if (el.dataset.region === selectedRegion) {
          el.classList.add(SELECTED_CLASS);
        } else {
          el.classList.remove(SELECTED_CLASS);
        }
      };
      syncSelected();

      const handleClick: EventListener = () => {
        const id = el.dataset.region;
        if (id) onSelect(id);
      };

      const handleKeyDown: EventListener = (evt) => {
        const ke = evt as KeyboardEvent;
        if (ke.key === 'Enter' || ke.key === ' ') {
          ke.preventDefault();
          const id = el.dataset.region;
          if (id) onSelect(id);
        }
      };

      const handleMouseEnter: EventListener = () => el.classList.add(HOVER_CLASS);
      const handleMouseLeave: EventListener = () => el.classList.remove(HOVER_CLASS);
      const handleFocus: EventListener = () => el.classList.add(HOVER_CLASS);
      const handleBlur: EventListener = () => el.classList.remove(HOVER_CLASS);

      addListener(el, 'click', handleClick);
      addListener(el, 'keydown', handleKeyDown);
      addListener(el, 'mouseenter', handleMouseEnter);
      addListener(el, 'mouseleave', handleMouseLeave);
      addListener(el, 'focus', handleFocus);
      addListener(el, 'blur', handleBlur);
    });

    return () => {
      handlers.forEach(({ el, type, fn }) => el.removeEventListener(type, fn));
    };
    // selectedRegion intentionally excluded — we handle it via a separate effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgString, onSelect]);

  // Keep selected class in sync without re-attaching all listeners
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !svgString) return;
    wrapper.querySelectorAll<HTMLElement>('[data-region]').forEach((el) => {
      if (el.dataset.region === selectedRegion) {
        el.classList.add(SELECTED_CLASS);
      } else {
        el.classList.remove(SELECTED_CLASS);
      }
    });
  }, [selectedRegion, svgString]);

  if (!svgString) return null;

  return (
    <div
      ref={wrapperRef}
      className="w-full flex justify-center"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted static SVG markup from svgRegistry
      dangerouslySetInnerHTML={{ __html: svgString }}
    />
  );
}
