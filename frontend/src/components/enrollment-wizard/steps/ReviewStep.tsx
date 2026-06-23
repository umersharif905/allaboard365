// frontend/src/components/enrollment-wizard/steps/ReviewStep.tsx
import {
    Check,
    ChevronDown,
    ChevronUp,
    FileText,
    GripVertical,
    Package,
    Shield,
    User,
    Users
} from 'lucide-react';
import React from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { WizardStepProps } from '../types/wizard.types';

interface ReviewStepProps extends WizardStepProps {
  staticLinkMode?: boolean;
}

const ReviewStep: React.FC<ReviewStepProps> = ({
  data,
  onDataChange,
  staticLinkMode = false
}) => {
  const { user } = useAuth();
  const isAgent = user?.currentRole === 'Agent';

  const householdFields = [
    { key: 'collectSSN', label: 'Social Security Number', icon: Shield, sensitive: true },
    { key: 'collectDOB', label: 'Date of Birth', icon: User },
    { key: 'collectGender', label: 'Gender', icon: Users },
    { key: 'collectAddress', label: 'Address', icon: User },
    { key: 'collectPhone', label: 'Phone Number', icon: User }
  ];

  const selectedHouseholdFields = householdFields.filter(field => 
    data.household[field.key as keyof typeof data.household]
  );

  const getProductTypeIcon = (productType: string) => {
    switch (productType.toLowerCase()) {
      case 'medical':
      case 'healthcare':
        return '🏥';
      case 'dental':
        return '🦷';
      case 'vision':
        return '👁️';
      case 'life':
      case 'life insurance':
        return '❤️';
      case 'disability':
        return '♿';
      case 'accident':
        return '🚑';
      case 'critical illness':
        return '⚕️';
      case 'hospital indemnity':
        return '🏨';
      case 'telemedicine':
      case 'telemed':
        return '📱';
      default:
        return '📋';
    }
  };

  const moveSection = (index: number, direction: 'up' | 'down') => {
    const next = direction === 'up' ? index - 1 : index + 1;
    if (next < 0 || next >= data.products.length) return;
    const list = [...data.products];
    [list[index], list[next]] = [list[next], list[index]];
    onDataChange({ products: list });
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h3 className="text-lg font-medium text-gray-900 mb-2">Review Template</h3>
        <p className="text-sm text-gray-600">
          Review your enrollment link template configuration
        </p>
      </div>

      <div className="space-y-6">
        {/* Basic Information Summary */}
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-center mb-4">
            <FileText className="h-5 w-5 text-oe-primary mr-2" />
            <h4 className="text-lg font-medium text-gray-900">Basic Information</h4>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500">Link Name</dt>
              <dd className="text-sm text-gray-900 mt-1">{data.templateName}</dd>
            </div>
            
            <div>
              <dt className="text-sm font-medium text-gray-500">Template Type</dt>
              <dd className="text-sm text-gray-900 mt-1">{data.templateType}</dd>
            </div>
            
            {data.description && (
              <div className="md:col-span-2">
                <dt className="text-sm font-medium text-gray-500">Description</dt>
                <dd className="text-sm text-gray-900 mt-1">{data.description}</dd>
              </div>
            )}
            

          </div>
        </div>

        {/* Household Summary */}
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center">
              <Users className="h-5 w-5 text-green-600 mr-2" />
              <h4 className="text-lg font-medium text-gray-900">Household Collection</h4>
            </div>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
              {selectedHouseholdFields.length} fields selected
            </span>
          </div>

          {selectedHouseholdFields.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {selectedHouseholdFields.map((field) => {
                const FieldIcon = field.icon;
                return (
                  <div key={field.key} className="flex items-center space-x-2">
                    <Check className="h-4 w-4 text-green-600" />
                    <FieldIcon className="h-4 w-4 text-gray-400" />
                    <span className="text-sm text-gray-900">{field.label}</span>
                    {field.sensitive && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                        <Shield className="h-3 w-3 mr-1" />
                        Sensitive
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No household information will be collected</p>
          )}
        </div>

        {/* Product Sections Summary */}
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center">
              <Package className="h-5 w-5 text-purple-600 mr-2" />
              <h4 className="text-lg font-medium text-gray-900">Product Sections</h4>
            </div>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
              {data.products.length} sections
            </span>
          </div>

          {data.products.length > 0 ? (
            <div className="space-y-3">
              <p className="text-xs text-gray-500 mb-2">Section order determines the order in the enrollment wizard. Use arrows to reorder.</p>
              {data.products.map((product, index) => (
                <div key={product.id} className="bg-gray-50 rounded-lg p-4 flex items-start gap-2">
                  <div className="flex flex-col gap-0 flex-shrink-0 pt-0.5">
                    <button type="button" onClick={() => moveSection(index, 'up')} disabled={index === 0} className="p-0.5 text-gray-500 hover:text-oe-primary disabled:opacity-30 disabled:cursor-not-allowed" title="Move section up"><ChevronUp className="h-4 w-4" /></button>
                    <button type="button" onClick={() => moveSection(index, 'down')} disabled={index === data.products.length - 1} className="p-0.5 text-gray-500 hover:text-oe-primary disabled:opacity-30 disabled:cursor-not-allowed" title="Move section down"><ChevronDown className="h-4 w-4" /></button>
                  </div>
                  <GripVertical className="h-4 w-4 text-gray-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2 mb-2">
                      <span className="text-lg">{getProductTypeIcon(product.productType)}</span>
                      <h5 className="text-sm font-medium text-gray-900">{product.page}</h5>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        {product.productType}
                      </span>
                    </div>
                    {product.description && (
                      <p className="text-xs text-gray-500">{product.description}</p>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 flex-shrink-0">#{index + 1}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No product sections configured</p>
          )}
        </div>



      </div>
    </div>
  );
};

export default ReviewStep;