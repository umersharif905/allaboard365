import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import type { FormPage } from '../../../types/publicFormDefinition';
import { fbInspectorIconBtn } from './formBuilderButtonClasses';

/**
 * Page navigation for multi-page forms — a horizontal tab strip at the top of
 * the builder card. The active tab carries a settings control that opens a
 * popover (title, description, hidden-by-default, reorder, delete); an inline
 * "+ Add page" sits at the end of the strip.
 */
export function PageManager({
  pages,
  activePageId,
  fieldCountByPage,
  onSelectPage,
  onAddPage,
  onUpdatePage,
  onRemovePage,
  onMovePage
}: {
  pages: FormPage[];
  activePageId: string;
  fieldCountByPage: Record<string, number>;
  onSelectPage: (id: string) => void;
  onAddPage: () => void;
  onUpdatePage: (id: string, patch: Partial<FormPage>) => void;
  onRemovePage: (id: string) => void;
  onMovePage: (id: string, dir: -1 | 1) => void;
}) {
  const [settingsOpenId, setSettingsOpenId] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Close the settings popover on an outside click.
  useEffect(() => {
    if (!settingsOpenId) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setSettingsOpenId(null);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [settingsOpenId]);

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 pb-2">
      {pages.map((page, i) => {
        const count = fieldCountByPage[page.id] ?? 0;
        const isActive = page.id === activePageId;
        const settingsOpen = settingsOpenId === page.id;
        return (
          <div key={page.id} className="relative">
            <div
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                isActive ? 'bg-oe-light text-oe-dark' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectPage(page.id)}
                className="flex items-baseline gap-1.5 min-w-0"
              >
                <span className="font-medium truncate max-w-[12rem]">
                  {page.title?.trim() || `Page ${i + 1}`}
                </span>
                <span className="text-[10px] text-gray-400">{count}</span>
                {page.defaultHidden && (
                  <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-amber-100 text-amber-800">
                    hidden
                  </span>
                )}
              </button>
              {isActive && (
                <button
                  type="button"
                  onClick={() => setSettingsOpenId(settingsOpen ? null : page.id)}
                  aria-label="Page settings"
                  aria-expanded={settingsOpen}
                  className="text-oe-dark/60 hover:text-oe-dark rounded"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {settingsOpen && (
              <div
                ref={popoverRef}
                className="absolute left-0 top-full z-20 mt-1 w-72 rounded-lg border border-gray-200 bg-white p-3 shadow-lg space-y-3"
              >
                <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                  Page settings
                </span>
                <label className="block text-sm">
                  <span className="text-gray-600">Title</span>
                  <input
                    className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                    value={page.title}
                    placeholder="e.g. Personal information"
                    onChange={(e) => onUpdatePage(page.id, { title: e.target.value })}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-gray-600">Description (optional)</span>
                  <textarea
                    className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm min-h-[56px] focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                    rows={2}
                    value={page.description ?? ''}
                    placeholder="Shown to the recipient under the page title."
                    onChange={(e) =>
                      onUpdatePage(page.id, { description: e.target.value || undefined })
                    }
                  />
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-gray-300"
                    checked={!!page.defaultHidden}
                    onChange={(e) =>
                      onUpdatePage(page.id, { defaultHidden: e.target.checked ? true : undefined })
                    }
                  />
                  <span>
                    <span className="text-gray-800">Hidden by default</span>
                    <span className="block text-xs text-gray-500">
                      Shown only if a pre-screening answer reveals it.
                    </span>
                  </span>
                </label>
                <div className="flex items-center justify-between gap-2 border-t border-gray-100 pt-2">
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className={fbInspectorIconBtn}
                      onClick={() => onMovePage(page.id, -1)}
                      disabled={i === 0}
                      title="Move page left"
                    >
                      ← Move
                    </button>
                    <button
                      type="button"
                      className={fbInspectorIconBtn}
                      onClick={() => onMovePage(page.id, 1)}
                      disabled={i === pages.length - 1}
                      title="Move page right"
                    >
                      Move →
                    </button>
                  </div>
                  <button
                    type="button"
                    className="text-[11px] text-red-700 hover:underline disabled:opacity-40 disabled:no-underline"
                    onClick={() => {
                      onRemovePage(page.id);
                      setSettingsOpenId(null);
                    }}
                    disabled={pages.length <= 1}
                    title={pages.length <= 1 ? 'A form needs at least one page' : 'Delete page'}
                  >
                    Delete page
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={onAddPage}
        className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm text-oe-primary hover:text-oe-dark hover:bg-oe-light/40"
      >
        <Plus className="h-3.5 w-3.5" /> Add page
      </button>
    </div>
  );
}
