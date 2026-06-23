import React from 'react';

import { Trash2 } from 'lucide-react';

import type { TrainingModule } from './trainingTypes';

export type ModuleLibraryArchiveFilter = 'all' | 'active' | 'archived';

type Props = {
  modules: TrainingModule[];
  moduleSearch: string;
  activeModuleId: string;
  selectedPackageModuleIds: string[];
  hasSelectedPackage: boolean;
  selectedPackageName: string;
  onModuleSearchChange: (value: string) => void;
  onAddToPackage: (moduleId: string) => void;
  onEditModule: (moduleId: string) => void;
  onOpenNewModuleModal: () => void;

  showArchivedModules: boolean;
  onShowArchivedModulesChange: (value: boolean) => void;
  moduleArchiveFilter: ModuleLibraryArchiveFilter;
  onModuleArchiveFilterChange: (value: ModuleLibraryArchiveFilter) => void;

  canArchiveModules?: boolean;
  onRequestArchiveModule?: (moduleId: string) => void;
  onRequestPermanentDeleteModule?: (moduleId: string) => void;
};

const ModuleLibraryPanel: React.FC<Props> = ({
  modules,
  moduleSearch,
  activeModuleId,
  selectedPackageModuleIds,
  hasSelectedPackage,
  selectedPackageName,
  onModuleSearchChange,
  onAddToPackage,
  onEditModule,
  onOpenNewModuleModal,
  showArchivedModules,
  onShowArchivedModulesChange,
  moduleArchiveFilter,
  onModuleArchiveFilterChange,
  canArchiveModules = false,
  onRequestArchiveModule,
  onRequestPermanentDeleteModule
}) => {
  const selectedIds = new Set(selectedPackageModuleIds);

  return (
    <section className="xl:col-span-4 bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Module Library</h2>
        <button
          type="button"
          onClick={onOpenNewModuleModal}
          className="rounded-md bg-oe-primary text-white px-3 py-1.5 text-sm hover:bg-oe-dark"
        >
          + New Module
        </button>
      </div>

      <p className="text-xs text-gray-600 mb-3">
        Package target: {selectedPackageName || 'Select a package first'}
      </p>

      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-gray-800">
          <input
            type="checkbox"
            role="switch"
            checked={showArchivedModules}
            onChange={event => onShowArchivedModulesChange(event.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
          />
          Show archived
        </label>
        <div className="flex items-center gap-2">
          <label htmlFor="module-library-archive-filter" className="text-xs text-gray-600 whitespace-nowrap">
            Show:
          </label>
          <select
            id="module-library-archive-filter"
            value={moduleArchiveFilter}
            onChange={event =>
              onModuleArchiveFilterChange(event.target.value as ModuleLibraryArchiveFilter)
            }
            className="rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-800"
          >
            <option value="all">All</option>
            <option value="active">Active only</option>
            <option value="archived">Archived only</option>
          </select>
        </div>
      </div>

      <input
        value={moduleSearch}
        onChange={event => onModuleSearchChange(event.target.value)}
        placeholder="Search modules..."
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm mb-3"
      />

      <div className="space-y-2 max-h-[720px] overflow-y-auto pr-1">
        {modules.map(module => {
          const alreadyAdded = selectedIds.has(module.id);
          const quizCount = module.moduleSteps.filter(step => step.sectionQuiz).length;
          const isEditing = module.id === activeModuleId;

          return (
            <div
              key={module.id}
              className={`rounded-md border p-3 transition-colors ${
                isEditing
                  ? 'border-blue-300 bg-blue-50 ring-1 ring-blue-200'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-gray-900">{module.title}</p>
                {module.archived ? (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                    Archived
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-gray-500 mt-1">{module.id}</p>
              <p className="text-xs text-gray-600 mt-1">
                {module.moduleSteps.length} step(s), {quizCount} quiz section(s)
              </p>
              {isEditing && (
                <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-blue-700">
                  Editing in Module Editor
                </p>
              )}
              <p className="text-xs text-gray-600 mt-1 line-clamp-2">{module.modulePurpose}</p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onAddToPackage(module.id)}
                  disabled={alreadyAdded || !hasSelectedPackage || Boolean(module.archived)}
                  className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {alreadyAdded ? 'Already Added' : 'Add To Package'}
                </button>
                <button
                  type="button"
                  onClick={() => onEditModule(module.id)}
                  className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                >
                  Edit Module
                </button>
                {canArchiveModules && !module.archived && onRequestArchiveModule ? (
                  <button
                    type="button"
                    onClick={() => onRequestArchiveModule(module.id)}
                    className="ml-auto inline-flex items-center gap-1 rounded border border-red-300 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                    title="Archive module"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Archive
                  </button>
                ) : null}
                {canArchiveModules && module.archived && onRequestPermanentDeleteModule ? (
                  <button
                    type="button"
                    onClick={() => onRequestPermanentDeleteModule(module.id)}
                    className="ml-auto inline-flex items-center gap-1 rounded border border-red-800 bg-red-900 px-2 py-1 text-xs font-semibold text-white hover:bg-red-950"
                    title="Remove this module from the library permanently"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Delete forever
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        {modules.length === 0 && (
          <div className="rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-500 text-center">
            No modules match your search.
          </div>
        )}
      </div>
    </section>
  );
};

export default ModuleLibraryPanel;
