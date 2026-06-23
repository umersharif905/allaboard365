// frontend/src/components/forms/EnrollmentLinkTemplateForm.tsx
import { Loader2 } from 'lucide-react';
import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  useAgentsForDropdown,
  useEnrollmentLinkTemplateRoleConfig,
  useTenantsForDropdown
} from '../../hooks/useEnrollmentLinkTemplates';
import {
  CreateTemplateRequest,
  EnrollmentLinkTemplate,
  UpdateTemplateRequest
} from '../../services/enrollment-link-templates.service';

interface EnrollmentLinkTemplateFormProps {
  template?: EnrollmentLinkTemplate;
  onSave: (formData: CreateTemplateRequest | UpdateTemplateRequest) => void;
  onCancel: () => void;
  isEditing?: boolean;
}

const EnrollmentLinkTemplateForm: React.FC<EnrollmentLinkTemplateFormProps> = ({
  template,
  onSave,
  onCancel,
  isEditing = false
}) => {
  const { user } = useAuth();
  const roleConfig = useEnrollmentLinkTemplateRoleConfig();
  
  // Form state
  const [formData, setFormData] = useState({
    templateName: template?.TemplateName || '',
    templateType: template?.TemplateType || 'Individual' as 'Individual' | 'Group',
    tenantId: template?.TenantId || '',
    agentId: template?.AgentId || '',
    description: template?.Description || '',
    linkMetaData: template ? JSON.stringify(JSON.parse(template.LinkMetaData), null, 2) : JSON.stringify({
      household: {
        collectSSN: false,
        collectDOB: true,
        collectGender: false,
        collectAddress: true,
        collectPhone: true
      },
      products: [
        {
          page: "Medical Plans",
          productType: "Medical",
          description: "Select from available medical insurance options"
        }
      ]
    }, null, 2),
    isActive: template?.IsActive !== false
  });
  

  // Dropdown data with loading states
  const { data: tenants = [], isLoading: isLoadingTenants, isError: isTenantsError } = useTenantsForDropdown();
  const { data: agents = [], isLoading: isLoadingAgents, isError: isAgentsError } = useAgentsForDropdown(formData.tenantId);
  
  // For Agent role, find current agent info to display
  const currentAgent = user?.currentRole === 'Agent' ? agents.find(a => a.Email === user?.email) : null;

  // Handle form changes
  const handleInputChange = (field: string, value: any) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  // Handle tenant selection (for SysAdmin)
  const handleTenantChange = (tenantId: string) => {
    setFormData(prev => ({
      ...prev,
      tenantId,
      agentId: '' // Reset agent selection when tenant changes
    }));
  };

  // Handle form submission
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate JSON
    try {
      JSON.parse(formData.linkMetaData);
    } catch (error) {
      alert('Invalid JSON in Link Metadata. Please check the format.');
      return;
    }

    // Prepare data based on role
    let submitData: any = {
      templateName: formData.templateName,
      templateType: formData.templateType,
      linkMetaData: formData.linkMetaData,
      description: formData.description || undefined
    };

    if (isEditing) {
      submitData.isActive = formData.isActive;
    } else {
      // For creation, add tenant/agent IDs based on role
      if (user?.currentRole === 'SysAdmin') {
        submitData.tenantId = formData.tenantId;
        submitData.agentId = formData.agentId;
      } else if (user?.currentRole === 'TenantAdmin') {
        submitData.agentId = formData.agentId;
        // TenantAdmin's tenantId will be auto-filled by backend
        submitData.tenantId = undefined;
      } else if (user?.currentRole === 'Agent') {
        // For Agent role, backend will auto-fill both tenantId and agentId
        submitData.tenantId = undefined;
        submitData.agentId = undefined;
      }
    }

    onSave(submitData);
  };

  // Validation
  const isValid = () => {
    if (!formData.templateName.trim()) return false;
    if (roleConfig.requireTenantSelection && !formData.tenantId) return false;
    if (roleConfig.requireAgentSelection && !formData.agentId) return false;
    
    try {
      JSON.parse(formData.linkMetaData);
    } catch {
      return false;
    }
    
    return true;
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Template Name */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Template Name *
        </label>
        <input
          type="text"
          value={formData.templateName}
          onChange={(e) => handleInputChange('templateName', e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
          placeholder="Enter template name"
          required
        />
      </div>

      {/* Template Type */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Template Type *
        </label>
        <select
          value={formData.templateType}
          onChange={(e) => handleInputChange('templateType', e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
          required
        >
          <option value="Individual">Individual</option>
          <option value="Group">Group</option>
        </select>
      </div>

      {/* Tenant Selection (SysAdmin only) */}
      {roleConfig.requireTenantSelection && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center">
            Tenant *
            {isLoadingTenants && <Loader2 className="ml-2 h-4 w-4 animate-spin text-oe-primary" />}
          </label>
          <select
            value={formData.tenantId}
            onChange={(e) => handleTenantChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            required
            disabled={isLoadingTenants}
          >
            <option value="">
              {isLoadingTenants ? "Loading tenants..." : 
               isTenantsError ? "Error loading tenants" : 
               "Select a tenant"}
            </option>
            {!isLoadingTenants && !isTenantsError && tenants.map((tenant) => (
              <option key={tenant.TenantId} value={tenant.TenantId}>
                {tenant.TenantName}
              </option>
            ))}
          </select>
          {isTenantsError && (
            <p className="text-red-500 text-sm mt-1">Failed to load tenants. Please try again.</p>
          )}
        </div>
      )}

      {/* Agent Selection (SysAdmin and TenantAdmin) */}
      {roleConfig.requireAgentSelection && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center">
            Agent *
            {isLoadingAgents && <Loader2 className="ml-2 h-4 w-4 animate-spin text-oe-primary" />}
          </label>
          <select
            value={formData.agentId}
            onChange={(e) => handleInputChange('agentId', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            required
            disabled={
              (roleConfig.requireTenantSelection && !formData.tenantId) || 
              isLoadingAgents
            }
          >
            <option value="">
              {roleConfig.requireTenantSelection && !formData.tenantId 
                ? "Select a tenant first" 
                : isLoadingAgents 
                  ? "Loading agents..."
                  : isAgentsError
                    ? "Error loading agents"
                    : agents.length === 0 && formData.tenantId
                      ? "No agents found for this tenant"
                      : "Select an agent"
              }
            </option>
            {!isLoadingAgents && !isAgentsError && agents.map((agent) => (
              <option key={agent.AgentId} value={agent.AgentId}>
                {agent.AgentName} {agent.Email && `(${agent.Email})`}
              </option>
            ))}
          </select>
          {isAgentsError && (
            <p className="text-red-500 text-sm mt-1">Failed to load agents. Please try again.</p>
          )}
          {formData.tenantId && !isLoadingAgents && !isAgentsError && agents.length === 0 && (
            <p className="text-yellow-600 text-sm mt-1">No agents found for the selected tenant.</p>
          )}
        </div>
      )}

      {/* Agent Info Display (Agent role only) */}
      {user?.currentRole === 'Agent' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Agent
          </label>
          <div className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-gray-50">
            <div className="flex items-center">
              <div className="h-8 w-8 bg-blue-100 rounded-full flex items-center justify-center mr-3">
                <span className="text-sm font-medium text-oe-primary">
                  {user?.firstName?.[0]}{user?.lastName?.[0]}
                </span>
              </div>
              <div>
                <div className="text-sm font-medium text-gray-900">
                  {user?.firstName} {user?.lastName} (You)
                </div>
                <div className="text-xs text-gray-500">
                  {user?.email}
                </div>
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            This template will be automatically assigned to your agent account
          </p>
        </div>
      )}

      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Description
        </label>
        <textarea
          value={formData.description}
          onChange={(e) => handleInputChange('description', e.target.value)}
          rows={3}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
          placeholder="Enter template description (optional)"
        />
      </div>

      {/* Link Metadata */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Link Metadata (JSON) *
        </label>
        <p className="text-xs text-gray-500 mb-1">Products with &quot;Must be sold with (at least one of)&quot; are configured in Product Configuration.</p>
        <textarea
          value={formData.linkMetaData}
          onChange={(e) => handleInputChange('linkMetaData', e.target.value)}
          rows={12}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary font-mono text-sm"
          placeholder="Enter JSON configuration"
          required
        />
        <p className="text-xs text-gray-500 mt-1">
          Define the enrollment workflow structure in JSON format
        </p>
      </div>

      {/* Active Status (Edit only) */}
      {isEditing && (
        <div className="flex items-center">
          <input
            type="checkbox"
            id="isActive"
            checked={formData.isActive}
            onChange={(e) => handleInputChange('isActive', e.target.checked)}
            className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
          />
          <label htmlFor="isActive" className="ml-2 block text-sm text-gray-700">
            Template is active
          </label>
        </div>
      )}

      {/* Form Actions */}
      <div className="flex justify-end space-x-3 pt-4 border-t border-gray-200">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!isValid()}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-oe-primary hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isEditing ? 'Update Enrollment Link' : 'Create Enrollment Link'}
        </button>
      </div>
    </form>
  );
};

export default EnrollmentLinkTemplateForm;