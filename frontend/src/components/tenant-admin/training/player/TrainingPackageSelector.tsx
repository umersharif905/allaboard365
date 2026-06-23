import React from 'react';

import { Package } from 'lucide-react';

import type { TrainingPackage } from '../trainingTypes';

import { PackagePickCardInner } from './TrainingPackageCardVisual';

type Props = {
  packages: TrainingPackage[];
  selectedPackageId: string;
  onSelectPackage: (packageId: string) => void;
};

const TrainingPackageSelector: React.FC<Props> = ({
  packages,
  selectedPackageId,
  onSelectPackage
}) => {
  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50/80 p-6">
      <div className="flex items-start gap-3">
        <Package className="mt-0.5 h-5 w-5 shrink-0 text-slate-700" strokeWidth={2} aria-hidden />
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-slate-900">Training packages</h3>
          <p className="mt-1 text-sm text-slate-700">
            Choose a package to open its table of contents and training steps.
          </p>
        </div>
      </div>

      {packages.length === 0 ? (
        <p className="pt-4 text-sm text-slate-600">No packages available.</p>
      ) : (
        <div
          className="grid grid-cols-1 gap-4 pt-6 sm:grid-cols-2 xl:grid-cols-3"
          role="group"
          aria-label="Training packages"
        >
          {packages.map(trainingPackage => {
            const isSelected = trainingPackage.id === selectedPackageId;

            return (
              <button
                key={trainingPackage.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectPackage(isSelected ? '' : trainingPackage.id)}
                className={`rounded-xl border bg-white p-3 text-left shadow-md outline-none transition-all hover:border-slate-300 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${
                  isSelected
                    ? 'border-indigo-400 ring-2 ring-indigo-500/90 ring-offset-2 ring-offset-slate-50/80'
                    : 'border-slate-200/90'
                }`}
              >
                <PackagePickCardInner trainingPackage={trainingPackage} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TrainingPackageSelector;
