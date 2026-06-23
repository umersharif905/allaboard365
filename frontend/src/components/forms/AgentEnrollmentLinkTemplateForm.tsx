// frontend/src/components/forms/AgentEnrollmentLinkTemplateForm.tsx
import { X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { AgentEnrollmentLinkTemplatesService, CreateTemplateRequest, UpdateTemplateRequest } from '../../services/agent/agent-enrollment-link-templates.service';

interface AgentEnrollmentLinkTemplateFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: CreateTemplateRequest | UpdateTemplateRequest) => Promise<void>;
  isLoading: boolean;
  initialData?: Partial<CreateTemplateRequest>;
  isEdit?: boolean;
}

const AgentEnrollmentLinkTemplateForm: React.FC<AgentEnrollmentLinkTemplateFormProps> = ({
  isOpen,
  onClose,
  onSubmit,
  isLoading,
  initialData,
  isEdit = false
}) => {
  const [formData, setFormData] = useState({
    templateName: '',
    templateType: 'Individual' as 'Individual' | 'Group',
    linkMetaData: '',
    description: '',
    isActive: true
  });
  const [jsonError, setJsonError] = useState('');

  useEffect(() => {
    if (initialData) {
      setFormData({
        templateName: initialData.templateName || '',
        templateType: initialData.templateType || 'Individual',
        linkMetaData: initialData.linkMetaData || JSON.stringify(AgentEnrollmentLinkTemplatesService.getDefaultLinkMetaData(), null, 2),
        description: initialData.description || '',
        isActive: initialData.isActive ?? true
      });
    } else {
      // Set default values for create
      setFormData({
        templateName: '',
        templateType: 'Individual',
        linkMetaData: JSON.stringify(AgentEnrollmentLinkTemplatesService.getDefaultLinkMetaData(), null, 2),
        description: '',
        isActive: true
      });
    }
  }, [initialData, isOpen]);

  const validateJson = (jsonString: string): boolean => {
    try {
      JSON.parse(jsonString);
      setJsonError('');
      return true;
    } catch (error) {
      setJsonError('Invalid JSON format');
      return false;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateJson(formData.linkMetaData)) {
      return;
    }

    await onSubmit(formData);
  };

  const handleInputChange = (field: keyof typeof formData, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    
    if (field === 'linkMetaData') {
      validateJson(value);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={onClose}></div>

        <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-2xl sm:w-full">
          <form onSubmit={handleSubmit}>
            <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  {isEdit ? 'Edit Template' : 'Create New Template'}
                </h3>
                <button
                  type="button"
                  onClick={onClose}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="h-6 w-6" />
                </button>
              </div>

              <div className="space-y-4">
                {/* Template Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Template Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.templateName}
                    onChange={(e) => handleInputChange('templateName', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="Enter template name"
                  />
                </div>

                {/* Template Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Template Type *
                  </label>
                  <select
                    required
                    value={formData.templateType}
                    onChange={(e) => handleInputChange('templateType', e.target.value as 'Individual' | 'Group')}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="Individual">Individual</option>
                    <option value="Group">Group</option>
                  </select>
                </div>

                {/* Description */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    value={formData.description}
                    onChange={(e) => handleInputChange('description', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    rows={3}
                    placeholder="Enter template description"
                  />
                </div>

                {/* Is Active */}
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="isActive"
                    checked={formData.isActive}
                    onChange={(e) => handleInputChange('isActive', e.target.checked)}
                    className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                  />
                  <label htmlFor="isActive" className="ml-2 block text-sm text-gray-900">
                    Active template
                  </label>
                </div>

                {/* Link Metadata */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Link Configuration (JSON) *
                  </label>
                  <textarea
                    required
                    value={formData.linkMetaData}
                    onChange={(e) => handleInputChange('linkMetaData', e.target.value)}
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary font-mono text-sm ${
                      jsonError ? 'border-red-300' : 'border-gray-300'
                    }`}
                    rows={12}
                    placeholder="Enter JSON configuration"
                  />
                  {jsonError && (
                    <p className="mt-1 text-sm text-red-600">{jsonError}</p>
                  )}
                  <p className="mt-1 text-xs text-gray-500">
                    Configure the enrollment link behavior and data collection settings
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
              <button
                type="submit"
                disabled={isLoading || !!jsonError}
                className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-oe-primary text-base font-medium text-white hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Saving...' : (isEdit ? 'Update Enrollment Link' : 'Create Enrollment Link')}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default AgentEnrollmentLinkTemplateForm;