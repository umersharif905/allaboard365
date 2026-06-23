import React from 'react';

import type { ResolvedPackageModule, TrainingPackage, TrainingPackageStatus } from './trainingTypes';

type Props = {
  selectedPackage: TrainingPackage | null;
  assignedTenantCount: number;
  resolvedModules: ResolvedPackageModule[];
  onUpdatePackageField: (
    field:
      | 'title'
      | 'packagePurpose'
      | 'status'
      | 'version'
      | 'packageImageUrl'
      | 'certificate.packageName'
      | 'certificate.certificateName'
      | 'certificate.certificateDetails'
      | 'certificate.certificateImageUrl',
    value: string
  ) => void;
  onToggleRequired: (assignmentId: string) => void;
  onRemoveModule: (assignmentId: string) => void;
  onMoveModule: (assignmentId: string, direction: 'up' | 'down') => void;
  onEditModule: (moduleId: string) => void;
  onOpenAssignTenants: () => void;
};

const PackageBuilderPanel: React.FC<Props> = ({
  selectedPackage,
  assignedTenantCount,
  resolvedModules,
  onUpdatePackageField,
  onToggleRequired,
  onRemoveModule,
  onMoveModule,
  onEditModule,
  onOpenAssignTenants
}) => {
  if (!selectedPackage) {
    return (
      <section className="xl:col-span-5 bg-white rounded-lg border border-gray-200 p-4">
        <div className="rounded-md border border-dashed border-gray-300 p-6 text-center text-gray-500">
          Select a package to configure modules.
        </div>
      </section>
    );
  }

  const stepCount = resolvedModules.reduce(
    (sum, item) => sum + (item.module ? item.module.moduleSteps.length : 0),
    0
  );
  const quizCount = resolvedModules.reduce((sum, item) => {
    if (!item.module) {
      return sum;
    }
    return sum + item.module.moduleSteps.filter(step => step.sectionQuiz).length;
  }, 0);

  return (
    <section className="xl:col-span-5 bg-white rounded-lg border border-gray-200 p-4">
      <div className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-900">Package Builder</h2>
          <div className="flex items-center gap-2">
            <span className="rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600">
              Assigned tenants: {assignedTenantCount}
            </span>
            <button
              type="button"
              onClick={onOpenAssignTenants}
              className="rounded-md border border-oe-primary px-3 py-1.5 text-xs font-semibold text-oe-primary hover:bg-blue-50"
            >
              Assign
            </button>
          </div>
        </div>
        <p className="text-sm text-gray-600 mt-1">
          Configure package metadata and assemble from modules in the shared module library.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Package Title</label>
          <input
            value={selectedPackage.title}
            onChange={event => onUpdatePackageField('title', event.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Version</label>
          <input
            value={selectedPackage.version}
            onChange={event => onUpdatePackageField('version', event.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Package Purpose</label>
          <textarea
            value={selectedPackage.packagePurpose}
            onChange={event => onUpdatePackageField('packagePurpose', event.target.value)}
            rows={2}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Package card image URL <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <input
            value={selectedPackage.packageImageUrl ?? ''}
            onChange={event => onUpdatePackageField('packageImageUrl', event.target.value)}
            placeholder="https://…"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">
            Shown on the agent training package picker. Leave blank to use the certificate image URL below.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
          <select
            value={selectedPackage.status}
            onChange={event => onUpdatePackageField('status', event.target.value as TrainingPackageStatus)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="Draft">Draft</option>
            <option value="Active">Active</option>
            <option value="Archived">Archived</option>
          </select>
        </div>
      </div>

      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 mb-4">
        <h3 className="text-sm font-semibold text-amber-900 mb-2">Package Certificate</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Package Name</label>
            <input
              value={selectedPackage.certificate.packageName}
              onChange={event => onUpdatePackageField('certificate.packageName', event.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Certificate Name</label>
            <input
              value={selectedPackage.certificate.certificateName}
              onChange={event => onUpdatePackageField('certificate.certificateName', event.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Certificate Details</label>
            <textarea
              value={selectedPackage.certificate.certificateDetails}
              onChange={event => onUpdatePackageField('certificate.certificateDetails', event.target.value)}
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Certificate image URL</label>
            <input
              value={selectedPackage.certificate.certificateImageUrl}
              onChange={event => onUpdatePackageField('certificate.certificateImageUrl', event.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">
              Used for the certificates gallery and as the package card image when no package card URL is set.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 mb-4">
        <p className="text-sm text-gray-700">
          Summary: {resolvedModules.length} module(s), {stepCount} step(s), {quizCount} quiz section(s)
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
            Assigned Modules
          </h3>
          <p className="text-xs text-gray-500">Add modules from the Module Library panel.</p>
        </div>
        <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1">
          {resolvedModules.map((item, index) => {
            const module = item.module;
            return (
              <div key={item.assignment.id} className="rounded-md border border-gray-200 p-3">
                {!module ? (
                  <div className="text-sm text-amber-700">
                    Missing module `{item.assignment.moduleId}`. Remove this assignment or restore module.
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-gray-900">{module.title}</p>
                        <p className="text-xs text-gray-500 mt-1">
                          {module.id} | {module.moduleSteps.length} step(s)
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onMoveModule(item.assignment.id, 'up')}
                          disabled={index === 0}
                          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 disabled:opacity-40"
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          onClick={() => onMoveModule(item.assignment.id, 'down')}
                          disabled={index === resolvedModules.length - 1}
                          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 disabled:opacity-40"
                        >
                          Down
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-gray-600 mt-2">{module.modulePurpose}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <label className="inline-flex items-center gap-2 text-sm text-gray-800">
                        <input
                          type="checkbox"
                          checked={item.assignment.required}
                          onChange={() => onToggleRequired(item.assignment.id)}
                          className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                        />
                        Required for package
                      </label>
                      <button
                        type="button"
                        onClick={() => onEditModule(module.id)}
                        className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        Edit Module
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveModule(item.assignment.id)}
                        className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                      >
                        Remove
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
          {resolvedModules.length === 0 && (
            <div className="rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-500 text-center">
              No modules assigned yet. Add from the module library.
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

export default PackageBuilderPanel;
