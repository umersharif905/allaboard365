// CalcTypeDropdown.tsx
// Custom dropdown for selecting calculation types in the ProposalEditor.
// Shows a description tooltip on hover (after a 200ms delay) in a preview pane
// at the bottom of the dropdown, so sysadmins can understand what each function does.

import React, { useEffect, useRef, useState } from 'react';
import { CALC_TYPE_DESCRIPTIONS, CALC_TYPE_LABELS, CALC_TYPE_OPTION_GROUPS } from './calcTypeMetadata';

interface CalcTypeDropdownProps {
  value: string;
  onChange: (value: string) => void;
}

const CalcTypeDropdown: React.FC<CalcTypeDropdownProps> = ({ value, onChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredType, setHoveredType] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingValue = useRef<string | null>(null);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setHoveredType(null);
        setTooltipPos(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Cleanup hover timer on unmount
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const handleSelect = (val: string) => {
    onChange(val);
    setIsOpen(false);
    setHoveredType(null);
    setTooltipPos(null);
  };

  const handleItemMouseEnter = (e: React.MouseEvent<HTMLDivElement>, val: string) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const rect = e.currentTarget.getBoundingClientRect();
    pendingValue.current = val;
    hoverTimerRef.current = setTimeout(() => {
      if (pendingValue.current === val) {
        setHoveredType(val);
        setTooltipPos({ top: rect.top + rect.height / 2, left: rect.right });
      }
    }, 200);
  };

  const handleItemMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    pendingValue.current = null;
    setHoveredType(null);
    setTooltipPos(null);
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => {
          setIsOpen(prev => !prev);
          setHoveredType(null);
        }}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-left text-sm bg-white flex items-center justify-between hover:border-gray-400 transition-colors"
      >
        <span className={value ? 'text-gray-900 truncate' : 'text-gray-400'}>
          {value ? (CALC_TYPE_LABELS[value] || value) : 'Select Calculation Type'}
        </span>
        <svg
          className={`h-4 w-4 text-gray-400 ml-2 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div
          className="absolute z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl overflow-y-auto"
          style={{ height: '420px', width: '100%' }}
        >
          {/* Reset / empty option */}
          <div
            className="px-3 py-1.5 text-sm text-gray-400 cursor-pointer hover:bg-gray-50"
            onClick={() => handleSelect('')}
            onMouseEnter={() => handleItemMouseLeave()}
          >
            Select Calculation Type
          </div>

          {CALC_TYPE_OPTION_GROUPS.map(group => (
            <div key={group.label}>
              {/* Group header */}
              <div className="px-3 py-1 text-xs font-semibold text-gray-500 bg-gray-100 uppercase tracking-wide sticky top-0 border-y border-gray-200">
                {group.label}
              </div>
              {/* Options */}
              {group.options.map(opt => (
                <div
                  key={opt.value}
                  className={`px-4 py-1.5 text-sm cursor-pointer transition-colors ${
                    value === opt.value
                      ? 'bg-blue-100 text-blue-800 font-medium'
                      : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700'
                  }`}
                  onClick={() => handleSelect(opt.value)}
                  onMouseEnter={(e) => handleItemMouseEnter(e, opt.value)}
                  onMouseLeave={handleItemMouseLeave}
                >
                  {opt.label}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Tooltip — rendered fixed so it floats outside the dropdown's overflow */}
      {hoveredType && tooltipPos && CALC_TYPE_DESCRIPTIONS[hoveredType] && (
        <div
          className="fixed z-[9999] w-72 px-3 py-2.5 bg-white border border-gray-200 rounded-lg shadow-lg text-xs text-gray-700 leading-relaxed animate-fadeIn pointer-events-none"
          style={{ top: tooltipPos.top, left: tooltipPos.left + 8, transform: 'translateY(-50%)' }}
        >
          <span className="font-semibold text-blue-700">
            {CALC_TYPE_LABELS[hoveredType] || hoveredType}:
          </span>{' '}
          {CALC_TYPE_DESCRIPTIONS[hoveredType]}
        </div>
      )}

      {/* CSS animation for fade-in */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-2px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn {
          animation: fadeIn 0.15s ease-out;
        }
      `}</style>
    </div>
  );
};

export default CalcTypeDropdown;
