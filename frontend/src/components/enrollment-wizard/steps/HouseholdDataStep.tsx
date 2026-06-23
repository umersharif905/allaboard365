// frontend/src/components/enrollment-wizard/steps/HouseholdDataStep.tsx
import { Check, Shield, User, Users } from 'lucide-react';
import React from 'react';
import { WizardStepProps } from '../types/wizard.types';

const HOUSEHOLD_FIELDS = [
  {
    key: 'collectSSN' as const,
    label: 'Social Security Number (SSN)',
    description: 'Required for identity verification and tax reporting',
    icon: Shield,
    sensitive: true,
    recommended: false
  },
  {
    key: 'collectDOB' as const,
    label: 'Date of Birth',
    description: 'Required for age-based pricing and eligibility',
    icon: User,
    sensitive: false,
    recommended: true
  },
  {
    key: 'collectGender' as const,
    label: 'Gender',
    description: 'May be required for certain insurance products',
    icon: Users,
    sensitive: false,
    recommended: false
  },
  {
    key: 'collectAddress' as const,
    label: 'Address',
    description: 'Required for service area verification and billing',
    icon: User,
    sensitive: false,
    recommended: true
  },
  {
    key: 'collectPhone' as const,
    label: 'Phone Number',
    description: 'Important for customer service and emergency contact',
    icon: User,
    sensitive: false,
    recommended: true
  }
];

const HouseholdDataStep: React.FC<WizardStepProps> = ({
  data,
  onDataChange
}) => {
  const handleFieldToggle = (fieldKey: keyof typeof data.household) => {
    onDataChange({
      household: {
        ...data.household,
        [fieldKey]: !data.household[fieldKey]
      }
    });
  };

  const selectedCount = Object.values(data.household).filter(Boolean).length;
  const recommendedCount = HOUSEHOLD_FIELDS.filter(f => f.recommended).length;
  const selectedRecommendedCount = HOUSEHOLD_FIELDS.filter(f => f.recommended && data.household[f.key]).length;

  return (
    <div>
      <h3 className="text-lg font-medium text-gray-900 mb-1">Household Collection</h3>
      <p className="text-sm text-gray-600 mb-3">Choose what information you want to collect from members during enrollment</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <div className="flex items-center">
            <div className="p-1 bg-blue-100 rounded mr-2">
              <Check className="h-4 w-4 text-oe-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-blue-900">Selected Fields</p>
              <p className="text-xl font-bold text-oe-primary">{selectedCount}</p>
            </div>
          </div>
        </div>
        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
          <div className="flex items-center">
            <div className="p-1 bg-green-100 rounded mr-2">
              <Users className="h-4 w-4 text-green-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-green-900">Recommended</p>
              <p className="text-xl font-bold text-green-600">{selectedRecommendedCount}/{recommendedCount}</p>
            </div>
          </div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <div className="flex items-center">
            <div className="p-1 bg-amber-100 rounded mr-2">
              <Shield className="h-4 w-4 text-amber-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-amber-900">Sensitive Data</p>
              <p className="text-xl font-bold text-amber-600">{data.household.collectSSN ? '1' : '0'}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2 mb-3">
        {HOUSEHOLD_FIELDS.map((field) => {
          const isSelected = data.household[field.key];
          const FieldIcon = field.icon;
          return (
            <div
              key={field.key}
              className={`cursor-pointer transition-all rounded-lg border ${isSelected ? 'border-oe-primary bg-blue-50' : 'border-gray-200 bg-white'}`}
              onClick={() => handleFieldToggle(field.key)}
            >
              <div className="p-3 flex items-start">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => handleFieldToggle(field.key)}
                  className="h-4 w-4 text-oe-primary border-gray-300 rounded mt-0.5 mr-3"
                />
                <div className={`p-1 rounded mr-3 ${isSelected ? 'bg-blue-100' : 'bg-gray-100'}`}>
                  <FieldIcon className={`h-4 w-4 ${isSelected ? 'text-oe-primary' : 'text-gray-400'}`} />
                </div>
                <div className="flex-1">
                  <div className="flex items-center flex-wrap gap-2 mb-1">
                    <span className={`text-sm font-semibold ${isSelected ? 'text-blue-900' : 'text-gray-900'}`}>{field.label}</span>
                    {field.recommended && (
                      <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full border border-green-600 text-green-700">Recommended</span>
                    )}
                    {field.sensitive && (
                      <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full border border-amber-600 text-amber-700">
                        <Shield className="h-3 w-3 mr-1" /> Sensitive
                      </span>
                    )}
                  </div>
                  <p className={`text-sm ${isSelected ? 'text-oe-primary-dark' : 'text-gray-500'}`}>{field.description}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-3">
        <p className="text-sm font-medium text-blue-800 mb-1">Important Notes</p>
        <ul className="list-disc list-inside text-sm text-oe-primary-dark space-y-1">
          <li>You can always modify these settings later in the template configuration</li>
          <li>Collecting less information makes enrollment faster but may require manual follow-up</li>
          <li>Sensitive data like SSN should only be collected when absolutely necessary</li>
          <li>All collected data is encrypted and stored securely according to HIPAA standards</li>
        </ul>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="px-3 py-1.5 rounded-lg text-sm font-medium text-white bg-oe-primary hover:bg-oe-primary-dark"
          onClick={() => onDataChange({
            household: {
              collectSSN: false,
              collectDOB: true,
              collectGender: false,
              collectAddress: true,
              collectPhone: true,
            }
          })}
        >
          Select Recommended
        </button>
        <button
          className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-300 hover:bg-gray-50"
          onClick={() => onDataChange({
            household: {
              collectSSN: true,
              collectDOB: true,
              collectGender: true,
              collectAddress: true,
              collectPhone: true,
            }
          })}
        >
          Select All
        </button>
        <button
          className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-300 hover:bg-gray-50"
          onClick={() => onDataChange({
            household: {
              collectSSN: false,
              collectDOB: false,
              collectGender: false,
              collectAddress: false,
              collectPhone: false,
            }
          })}
        >
          Clear All
        </button>
      </div>
    </div>
  );
};

export default HouseholdDataStep;