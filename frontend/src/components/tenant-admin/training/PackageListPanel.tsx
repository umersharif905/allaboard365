import React from 'react';

import type { TrainingPackage, TrainingPackageStatus } from './trainingTypes';

type Props = {
  packages: TrainingPackage[];
  packageAssignmentCounts: Record<string, number>;
  selectedPackageId: string;
  packageSearch: string;
  statusFilter: 'All' | TrainingPackageStatus;
  onPackageSearchChange: (value: string) => void;
  onStatusFilterChange: (value: 'All' | TrainingPackageStatus) => void;
  onSelectPackage: (packageId: string) => void;
  onAddPackage: () => void;
};

const PackageListPanel: React.FC<Props> = ({
  packages,
  packageAssignmentCounts,
  selectedPackageId,
  packageSearch,
  statusFilter,
  onPackageSearchChange,
  onStatusFilterChange,
  onSelectPackage,
  onAddPackage
}) => {
  return (
    <section className="xl:col-span-3 bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Packages</h2>
        <button
          type="button"
          onClick={onAddPackage}
          className="rounded-md bg-oe-primary text-white px-3 py-1.5 text-sm hover:bg-oe-dark"
        >
          + Add
        </button>
      </div>

      <div className="space-y-3 mb-4">
        <input
          value={packageSearch}
          onChange={event => onPackageSearchChange(event.target.value)}
          placeholder="Search packages..."
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <select
          value={statusFilter}
          onChange={event => onStatusFilterChange(event.target.value as 'All' | TrainingPackageStatus)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="All">All statuses</option>
          <option value="Draft">Draft</option>
          <option value="Active">Active</option>
          <option value="Archived">Archived</option>
        </select>
      </div>

      <div className="space-y-2 max-h-[680px] overflow-y-auto pr-1">
        {packages.map(trainingPackage => {
          const isSelected = trainingPackage.id === selectedPackageId;
          return (
            <button
              key={trainingPackage.id}
              type="button"
              onClick={() => onSelectPackage(trainingPackage.id)}
              className={`w-full text-left rounded-md border p-3 transition ${
                isSelected
                  ? 'border-oe-primary bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <p className="text-sm font-semibold text-gray-900">{trainingPackage.title}</p>
              <p className="text-xs text-gray-500 mt-1">ID: {trainingPackage.id}</p>
              <p className="text-xs text-gray-600 mt-1">
                {trainingPackage.moduleAssignments.length} module assignment(s)
              </p>
              <p className="text-xs text-gray-600 mt-1">
                Assigned tenants: {packageAssignmentCounts[trainingPackage.id] || 0}
              </p>
              <p className="text-xs text-gray-600 mt-1">Status: {trainingPackage.status}</p>
            </button>
          );
        })}
        {packages.length === 0 && (
          <div className="rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-500 text-center">
            No packages match your filters.
          </div>
        )}
      </div>
    </section>
  );
};

export default PackageListPanel;
