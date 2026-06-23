import React, { useEffect, useMemo, useState } from 'react';

import { Loader2 } from 'lucide-react';

import type { TrainingModule, TrainingPackage } from './trainingTypes';
import {
  isModuleLibraryParseFailure,
  isTrainingModuleParseFailure,
  parseModuleLibraryPaste,
  parseModulePasteToTrainingModule
} from './trainingModuleImport';

export type TrainingModuleLibraryRawJsonEditorProps = {
  activeModuleId: string;
  moduleLibrary: TrainingModule[];
  packages: TrainingPackage[];
  disabled?: boolean;
  savingLibrary: boolean;
  onUpsertModule: (module: TrainingModule) => void;
  onReplaceModuleLibrary: (modules: TrainingModule[]) => void;
  onPersist: () => Promise<void>;
};

type EditorMode = 'single' | 'all';

const TrainingModuleLibraryRawJsonEditor: React.FC<TrainingModuleLibraryRawJsonEditorProps> = ({
  activeModuleId,
  moduleLibrary,
  packages,
  disabled = false,
  savingLibrary,
  onUpsertModule,
  onReplaceModuleLibrary,
  onPersist
}) => {
  const [mode, setMode] = useState<EditorMode>('single');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const activeModule = useMemo(
    () => (activeModuleId ? moduleLibrary.find(m => m.id === activeModuleId) ?? null : null),
    [activeModuleId, moduleLibrary]
  );

  const reloadDraftFromWorkspace = (): void => {
    if (mode === 'single') {
      setDraft(activeModule ? JSON.stringify(activeModule, null, 2) : '');
    } else {
      setDraft(JSON.stringify(moduleLibrary, null, 2));
    }
    setError(null);
    setWarning(null);
  };

  useEffect(() => {
    reloadDraftFromWorkspace();
    // Only re-seed when switching module or mode so typing in the form does not wipe the textarea.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeModuleId]);

  const computePackageOrphans = (modules: TrainingModule[]): string | null => {
    const libraryIds = new Set(modules.map(m => m.id));
    const missing: string[] = [];
    packages.forEach(pkg => {
      pkg.moduleAssignments.forEach(a => {
        const id = String(a.moduleId);
        if (!libraryIds.has(id) && !missing.includes(id)) {
          missing.push(id);
        }
      });
    });
    if (missing.length === 0) {
      return null;
    }
    return `Some packages still reference module ids not in this library: ${missing.join(', ')}. Save anyway if intentional.`;
  };

  const handleApply = (): void => {
    setError(null);
    setWarning(null);

    if (mode === 'single') {
      if (!activeModule) {
        setError('Select a module in the library before applying single-module JSON.');
        return;
      }
      const result = parseModulePasteToTrainingModule(draft);
      if (isTrainingModuleParseFailure(result)) {
        setError(result.error);
        return;
      }
      if (result.module.id !== activeModule.id) {
        setError(
          `Module id in JSON ("${result.module.id}") must match the selected module ("${activeModule.id}"). Use "All modules" mode to add or rename modules.`
        );
        return;
      }
      onUpsertModule(result.module);
      setWarning('Applied to workspace. Use Save to database to persist.');
      return;
    }

    const libResult = parseModuleLibraryPaste(draft);
    if (isModuleLibraryParseFailure(libResult)) {
      setError(libResult.error);
      return;
    }
    const orphanMsg = computePackageOrphans(libResult.modules);
    if (orphanMsg) {
      setWarning(orphanMsg);
    }
    onReplaceModuleLibrary(libResult.modules);
    if (!orphanMsg) {
      setWarning('Applied to workspace. Use Save to database to persist.');
    }
  };

  const handleSave = async (): Promise<void> => {
    setError(null);
    await onPersist();
  };

  const applyDisabled =
    disabled || savingLibrary || (mode === 'single' && !activeModule) || !draft.trim();

  return (
    <div id="training-module-raw-json-editor" className="rounded-lg border border-gray-700 bg-gray-900 p-5">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-200">
          Training modules (raw JSON)
        </h2>
        <span className="text-xs text-gray-400">Edits apply to workspace, then Save Library writes SQL</span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium text-gray-400">Mode:</span>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-gray-200">
          <input
            type="radio"
            name="raw-json-mode"
            className="h-3.5 w-3.5"
            checked={mode === 'single'}
            onChange={() => setMode('single')}
            disabled={disabled}
          />
          This module
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-gray-200">
          <input
            type="radio"
            name="raw-json-mode"
            className="h-3.5 w-3.5"
            checked={mode === 'all'}
            onChange={() => setMode('all')}
            disabled={disabled}
          />
          All modules (array)
        </label>
        <button
          type="button"
          onClick={reloadDraftFromWorkspace}
          disabled={disabled}
          className="ml-auto rounded border border-gray-600 px-2 py-1 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-50"
        >
          Reload from workspace
        </button>
      </div>

      {mode === 'single' && !activeModule ? (
        <p className="mb-2 text-xs text-amber-200">Select a module in the library to edit its JSON.</p>
      ) : null}

      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        disabled={disabled}
        spellCheck={false}
        className="mb-3 h-[min(440px,50vh)] w-full resize-y rounded border border-gray-700 bg-black/40 p-3 font-mono text-xs leading-5 text-green-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
        aria-label="Raw module JSON"
      />

      {error ? <p className="mb-2 text-xs text-red-300">{error}</p> : null}
      {warning ? <p className="mb-3 text-xs text-amber-200">{warning}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleApply}
          disabled={applyDisabled}
          className="rounded border border-indigo-500 bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Apply to workspace
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={disabled || savingLibrary}
          className="inline-flex items-center gap-2 rounded border border-emerald-600 bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {savingLibrary ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Saving…
            </>
          ) : (
            'Save to database'
          )}
        </button>
      </div>
    </div>
  );
};

export default TrainingModuleLibraryRawJsonEditor;
