// frontend/src/pages/tenant-admin/TenantAdminEnrollmentLinkTemplates.tsx
import { Edit3, Eye, Link, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import {
  useCreateTenantAdminEnrollmentLinkTemplate,
  useDeleteTenantAdminEnrollmentLinkTemplate,
  useTenantAdminEnrollmentLinkTemplates,
  useUpdateTenantAdminEnrollmentLinkTemplate
} from '../../hooks/tenant-admin/useTenantAdminEnrollmentLinkTemplates';
import {
  CreateTemplateRequest,
  EnrollmentLinkTemplate,
  EnrollmentLinkTemplateFilters,
  UpdateTemplateRequest
} from '../../services/tenant-admin/tenant-admin-enrollment-link-templates.service';

const TenantAdminEnrollmentLinkTemplates: React.FC = () => {
  // State for filters and UI
  const [filters, setFilters] = useState<EnrollmentLinkTemplateFilters>({
    page: 1,
    limit: 10,
    search: '',
    templateType: 'Individual',
    isActive: ''
  });
  
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EnrollmentLinkTemplate | null>(null);
  const [viewingTemplate, setViewingTemplate] = useState<EnrollmentLinkTemplate | null>(null);
  
  // Queries and mutations
  const { data: templatesData, isLoading, error, refetch } = useTenantAdminEnrollmentLinkTemplates(filters);
  const createMutation = useCreateTenantAdminEnrollmentLinkTemplate();
  const updateMutation = useUpdateTenantAdminEnrollmentLinkTemplate();
  const deleteMutation = useDeleteTenantAdminEnrollmentLinkTemplate();

  // Extract data from the response
  const templates = templatesData?.data?.data || [];
  const pagination = templatesData?.data?.pagination;

  // Statistics
  const stats = useMemo(() => {
    if (!templates.length) return { total: 0, active: 0, inactive: 0, individual: 0, group: 0 };
    
    return {
      total: pagination?.totalItems || templates.length,
      active: templates.filter(t => t.IsActive).length,
      inactive: templates.filter(t => !t.IsActive).length,
      individual: templates.filter(t => t.TemplateType === 'Individual').length,
      group: templates.filter(t => t.TemplateType === 'Group').length,
    };
  }, [templates, pagination]);

  // Handlers
  const handleSearch = (searchTerm: string) => {
    setFilters(prev => ({ ...prev, search: searchTerm, page: 1 }));
  };

  const handleFilterChange = (key: keyof EnrollmentLinkTemplateFilters, value: any) => {
    setFilters(prev => ({ ...prev, [key]: value, page: 1 }));
  };

  const handlePageChange = (page: number) => {
    setFilters(prev => ({ ...prev, page }));
  };

  const handleCreate = async (data: CreateTemplateRequest) => {
    try {
      await createMutation.mutateAsync(data);
      setIsCreateModalOpen(false);
    } catch (error) {
      console.error('Error creating template:', error);
    }
  };

  const handleUpdate = async (data: UpdateTemplateRequest) => {
    if (!editingTemplate) return;
    
    try {
      await updateMutation.mutateAsync({
        templateId: editingTemplate.TemplateId,
        templateData: data
      });
      setEditingTemplate(null);
    } catch (error) {
      console.error('Error updating template:', error);
    }
  };

  const handleDelete = async (templateId: string) => {
    if (!confirm('Are you sure you want to delete this template? This action cannot be undone.')) {
      return;
    }
    
    try {
      await deleteMutation.mutateAsync(templateId);
    } catch (error) {
      console.error('Error deleting template:', error);
    }
  };

  const resetFilters = () => {
    setFilters({
      page: 1,
      limit: 10,
      search: '',
      templateType: '',
      isActive: ''
    });
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-6"></div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-200 rounded"></div>
            ))}
          </div>
          <div className="h-64 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center">
            <div className="text-red-800">
              <h3 className="font-medium">Error loading templates</h3>
              <p className="text-sm mt-1">
                {error instanceof Error ? error.message : 'An unexpected error occurred'}
              </p>
            </div>
          </div>
          <button
            onClick={() => refetch()}
            className="mt-3 text-sm text-red-600 hover:text-red-500"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Link className="h-5 w-5 text-oe-primary" />
            </div>
            <div className="ml-3">
              <p className="text-sm font-medium text-gray-600">Total Templates</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.total}</p>
            </div>
          </div>
        </div>
        
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center">
            <div className="p-2 bg-green-100 rounded-lg">
              <div className="h-5 w-5 bg-green-600 rounded-full"></div>
            </div>
            <div className="ml-3">
              <p className="text-sm font-medium text-gray-600">Active</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.active}</p>
            </div>
          </div>
        </div>
        
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center">
            <div className="p-2 bg-gray-100 rounded-lg">
              <div className="h-5 w-5 bg-gray-400 rounded-full"></div>
            </div>
            <div className="ml-3">
              <p className="text-sm font-medium text-gray-600">Inactive</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.inactive}</p>
            </div>
          </div>
        </div>
        
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center">
            <div className="p-2 bg-purple-100 rounded-lg">
              <div className="h-5 w-5 bg-purple-600 rounded"></div>
            </div>
            <div className="ml-3">
              <p className="text-sm font-medium text-gray-600">Individual</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.individual}</p>
            </div>
          </div>
        </div>
        
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center">
            <div className="p-2 bg-orange-100 rounded-lg">
              <div className="h-5 w-5 bg-orange-600 rounded"></div>
            </div>
            <div className="ml-3">
              <p className="text-sm font-medium text-gray-600">Group</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.group}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Card */}
      <div className="bg-white rounded-lg border border-gray-200">
        {/* Header with Search and Filters */}
        <div className="p-6 border-b border-gray-200">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div className="flex-1 max-w-lg">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                <input
                  type="text"
                  placeholder="Search templates..."
                  value={filters.search || ''}
                  onChange={(e) => handleSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              {/* Filters */}
              {/* Group enrollment links are managed via GroupProductsTab */}
              
              <select
                value={filters.isActive === '' ? '' : filters.isActive?.toString()}
                onChange={(e) => handleFilterChange('isActive', e.target.value === '' ? '' : e.target.value === 'true')}
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="">All Status</option>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
              
              <button
                onClick={resetFilters}
                className="px-3 py-2 text-gray-600 hover:text-gray-800 border border-gray-300 rounded-lg hover:bg-gray-50"
                title="Reset Filters"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              
              <button
                onClick={() => setIsCreateModalOpen(true)}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark flex items-center gap-2 transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2"
              >
                <Plus className="h-4 w-4" />
                Create Template
              </button>
            </div>
          </div>
        </div>

        {/* Templates Table */}
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Template
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Agent
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Type
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Created
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {templates.map((template) => (
                <tr key={template.TemplateId} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div>
                      <div className="text-sm font-medium text-gray-900">{template.TemplateName}</div>
                      {template.Description && (
                        <div className="text-sm text-gray-500">{template.Description}</div>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900">{template.AgentName}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                      template.TemplateType === 'Individual' 
                        ? 'bg-purple-100 text-purple-800'
                        : 'bg-orange-100 text-orange-800'
                    }`}>
                      {template.TemplateType}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                      template.IsActive 
                        ? 'bg-green-100 text-green-800'
                        : 'bg-gray-100 text-gray-800'
                    }`}>
                      {template.IsActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {new Date(template.CreatedDate).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setViewingTemplate(template)}
                        className="text-gray-600 hover:text-gray-900"
                        title="View Template"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setEditingTemplate(template)}
                        className="text-oe-primary hover:text-blue-900"
                        title="Edit Template"
                      >
                        <Edit3 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(template.TemplateId)}
                        className="text-red-600 hover:text-red-900"
                        title="Delete Template"
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Empty State */}
        {templates.length === 0 && (
          <div className="text-center py-12">
            <Link className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">No templates found</h3>
            <p className="mt-1 text-sm text-gray-500">
              Get started by creating a new enrollment link template.
            </p>
            <div className="mt-6">
              <button
                onClick={() => setIsCreateModalOpen(true)}
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-oe-primary hover:bg-oe-dark transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2"
              >
                <Plus className="h-4 w-4 mr-2" />
                Create Template
              </button>
            </div>
          </div>
        )}

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="px-6 py-4 border-t border-gray-200">
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-700">
                Showing {((pagination.currentPage - 1) * pagination.itemsPerPage) + 1} to{' '}
                {Math.min(pagination.currentPage * pagination.itemsPerPage, pagination.totalItems)} of{' '}
                {pagination.totalItems} results
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handlePageChange(pagination.currentPage - 1)}
                  disabled={!pagination.hasPrevPage}
                  className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="px-3 py-2 text-sm">
                  Page {pagination.currentPage} of {pagination.totalPages}
                </span>
                <button
                  onClick={() => handlePageChange(pagination.currentPage + 1)}
                  disabled={!pagination.hasNextPage}
                  className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Modals - Will need TenantAdminEnrollmentLinkTemplateForm component */}
      {isCreateModalOpen && (
        <div className="text-center p-6">
          <p>TenantAdminEnrollmentLinkTemplateForm component needed</p>
          <button
            onClick={() => setIsCreateModalOpen(false)}
            className="mt-2 px-4 py-2 bg-gray-200 rounded"
          >
            Close
          </button>
        </div>
      )}

      {editingTemplate && (
        <div className="text-center p-6">
          <p>TenantAdminEnrollmentLinkTemplateForm component needed for editing</p>
          <button
            onClick={() => setEditingTemplate(null)}
            className="mt-2 px-4 py-2 bg-gray-200 rounded"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
};

export default TenantAdminEnrollmentLinkTemplates;