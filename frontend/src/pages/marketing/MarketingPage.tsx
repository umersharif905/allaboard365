// frontend/src/pages/marketing/MarketingPage.tsx
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Filter,
  Search,
  Send,
  Sparkles,
  User,
  Users,
  X
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import QuickQuoteWizardModal from '../../components/agents/QuickQuoteWizardModal';
import EnrollmentLinkWizard from '../../components/enrollment-wizard/EnrollmentLinkWizard';
import BusinessProposalModal from '../../components/proposals/BusinessProposalModal';
import SendProposalModal from '../../components/proposals/SendProposalModal';
import { useAuth } from '../../contexts/AuthContext';
import { useDownlineAgentsForFilter } from '../../hooks/useDownlineAgentsForFilter';
import {
  useAgentsForDropdown,
  useCreateEnrollmentLinkTemplate,
  useDeleteEnrollmentLinkTemplate,
  useEnrollmentLinkTemplateRoleConfig,
  useEnrollmentLinkTemplates,
  useUpdateEnrollmentLinkTemplate
} from '../../hooks/useEnrollmentLinkTemplates';
import { usePaymentProcessorStatus } from '../../hooks/usePaymentProcessorStatus';
import { apiService } from '../../services/api.service';
import {
  CreateTemplateRequest,
  EnrollmentLinkTemplate,
  EnrollmentLinkTemplateFilters,
  EnrollmentLinkTemplatesService,
  UpdateTemplateRequest
} from '../../services/enrollment-link-templates.service';

interface SimpleModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  size?: 'small' | 'medium' | 'large';
  children: React.ReactNode;
}

interface QuickQuoteProduct {
  productId: string;
  productName: string;
  productType: string;
  isBundle?: boolean;
  subscriptionStatus?: string;
  salesType?: string;
  productDocumentUrl?: string;
  ProductDocumentUrl?: string;
  productDocuments?: Array<{ productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }>;
  bundleProducts?: Array<{
    name?: string;
    productName?: string;
    productId?: string;
    productDocumentUrl?: string;
    ProductDocumentUrl?: string;
    productDocuments?: Array<{ productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }>;
  }>;
}

const SimpleModal: React.FC<SimpleModalProps> = ({ isOpen, onClose, title, size = 'medium', children }) => {
  if (!isOpen) return null;
  const sizeClasses = { small: 'max-w-md', medium: 'max-w-2xl', large: 'max-w-4xl' };
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-lg ${sizeClasses[size]} w-full max-h-[90vh] overflow-y-auto`}>
        <div className="p-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-6 w-6" /></button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
};

// Pagination component for marketing links table (used when Marketing Links tab is restored)
interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

const MarketingPagination: React.FC<PaginationProps> = ({
  currentPage,
  totalPages,
  onPageChange,
  hasNextPage,
  hasPreviousPage
}) => (
  <div className="flex items-center justify-between px-4 py-3 bg-white border-t border-gray-200 sm:px-6">
    <div className="flex justify-between flex-1 sm:hidden">
      <button
        onClick={() => onPageChange(currentPage - 1)}
        disabled={!hasPreviousPage}
        className="relative inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Previous
      </button>
      <button
        onClick={() => onPageChange(currentPage + 1)}
        disabled={!hasNextPage}
        className="relative ml-3 inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Next
      </button>
    </div>
    <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
      <div>
        <p className="text-sm text-gray-700">
          Page <span className="font-medium">{currentPage}</span> of{' '}
          <span className="font-medium">{totalPages}</span>
        </p>
      </div>
      <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={!hasPreviousPage}
          className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={!hasNextPage}
          className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </nav>
    </div>
  </div>
);

const MarketingPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const roleConfig = useEnrollmentLinkTemplateRoleConfig();
  const isAgent = user?.currentRole === 'Agent';
  const isTenantAdmin = user?.currentRole === 'TenantAdmin';
  const canUseQuickQuote = isAgent || isTenantAdmin;
  const isAgencyOwner = isAgent && (user?.roles as string[] | undefined)?.includes('AgencyOwner');

  // Filters for marketing links (same pattern as Enrollment Links: agent, type, search, status)
  const [filters, setFilters] = useState<EnrollmentLinkTemplateFilters>({
    page: 1,
    limit: 20,
    searchTerm: '',
    templateType: '',
    isActive: true,
    tenantName: '',
    agentId: '',
    viewDownline: false,
    hasMarketingLink: true // Only templates that have a marketing link
  });

  // Link scope for AgencyOwner: "My links" vs "My agent downlines"
  const [linkScope, setLinkScope] = useState<'mine' | 'downline'>('mine');
  const [downlineAgentSearchQuery, setDownlineAgentSearchQuery] = useState('');
  const [selectedDownlineAgentId, setSelectedDownlineAgentId] = useState('');
  const [agentSearchQuery, setAgentSearchQuery] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [selectedAgentIdForFilter, setSelectedAgentIdForFilter] = useState('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  const { data: downlineAgentOptions = [], isLoading: isLoadingDownlineAgents } = useDownlineAgentsForFilter();
  const tenantIdForAgentFilter = isTenantAdmin ? user?.currentTenantId : undefined;
  const downlineAgentDropdownEnabled = isAgencyOwner && linkScope === 'downline';
  const { data: agentOptions = [], isLoading: isLoadingAgents } = useAgentsForDropdown(
    tenantIdForAgentFilter ?? (downlineAgentDropdownEnabled ? '' : undefined),
    downlineAgentDropdownEnabled ? downlineAgentSearchQuery : agentSearchQuery
  );

  // When navigated with agentIdForEnrollmentLinks, set scope/filter for marketing links
  const agentIdFromState = (location.state as { agentIdForEnrollmentLinks?: string } | null)?.agentIdForEnrollmentLinks;
  useEffect(() => {
    if (!agentIdFromState) return;
    if (isAgencyOwner) {
      setLinkScope('downline');
      setSelectedDownlineAgentId(agentIdFromState);
    } else if (isTenantAdmin || user?.currentRole === 'SysAdmin') {
      setSelectedAgentId(agentIdFromState);
      setFilters((prev) => ({ ...prev, agentId: agentIdFromState, page: 1 }));
    }
    navigate(location.pathname, { replace: true, state: {} });
  }, [agentIdFromState, isAgencyOwner, isTenantAdmin, user?.currentRole, navigate, location.pathname]);

  useEffect(() => {
    if (!isAgencyOwner) return;
    setFilters((prev) => ({
      ...prev,
      page: 1,
      viewDownline: linkScope === 'downline' && !selectedDownlineAgentId,
      agentId: linkScope === 'downline' && selectedDownlineAgentId ? selectedDownlineAgentId : ''
    }));
  }, [isAgencyOwner, linkScope, selectedDownlineAgentId]);

  useEffect(() => {
    if (!isAgent || isAgencyOwner || isTenantAdmin || user?.currentRole === 'SysAdmin') return;
    setFilters((prev) => ({
      ...prev,
      page: 1,
      agentId: selectedAgentIdForFilter || ''
    }));
  }, [isAgent, isAgencyOwner, isTenantAdmin, user?.currentRole, selectedAgentIdForFilter]);

  const agentDropdownOptions = agentOptions.map((agent) => ({
    id: agent.AgentId,
    label: agent.Type === 'Agency' ? `${agent.AgentName} (Agency)` : agent.AgentName || agent.Email || 'Unknown',
    value: agent.AgentId,
    email: agent.Email,
    code: user?.currentRole === 'SysAdmin' ? agent.TenantName : undefined
  }));

  const templatesQuery = useEnrollmentLinkTemplates(filters);
  const { data: paginatedData, isLoading: loading, refetch: loadTemplates } = templatesQuery;
  const pagination = paginatedData?.pagination;
  // Only show templates that have a marketing link (client-side filter in case backend returns mixed)
  const marketingTemplates = (paginatedData?.data || []).filter(
    (t) => Number(t.HasMarketingLink) === 1 || t.HasMarketingLink === true
  );

  const createMutation = useCreateEnrollmentLinkTemplate();
  const updateMutation = useUpdateEnrollmentLinkTemplate();
  const deleteMutation = useDeleteEnrollmentLinkTemplate();
  const { data: paymentProcessorStatus } = usePaymentProcessorStatus();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [marketingLinkCopyModal, setMarketingLinkCopyModal] = useState<{ template: EnrollmentLinkTemplate; linkUrl: string } | null>(null);
  const [loadingMarketingLinkUrl, setLoadingMarketingLinkUrl] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [showSendProposalModal, setShowSendProposalModal] = useState(false);
  const [showBusinessProposalModal, setShowBusinessProposalModal] = useState(false);
  const [showQuickQuoteModal, setShowQuickQuoteModal] = useState(false);
  const [quickQuoteProducts, setQuickQuoteProducts] = useState<QuickQuoteProduct[]>([]);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<EnrollmentLinkTemplate | null>(null);
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  const [actionMenuPosition, setActionMenuPosition] = useState<{ x: number; y: number; maxHeight?: number } | null>(null);
  const actionMenuRefs = useRef<{ [key: string]: HTMLButtonElement | null }>({});

  const openQuickQuote = useCallback(async () => {
    if (!canUseQuickQuote) return;
    try {
      const response = await apiService.get<{ success: boolean; data?: any[]; message?: string }>(
        '/api/me/agent/products?includeHidden=false'
      );
      const mapped = (response?.data || []).map((product: Record<string, unknown>) => ({
        productId: product.ProductId as string,
        productName: product.Name as string,
        productType: (product.ProductType as string) || 'Other',
        isBundle: Boolean(product.IsBundle),
        subscriptionStatus: (product.SubscriptionStatus as string) || (product.subscriptionStatus as string) || 'Active',
        salesType: (product.SalesType as string) || (product.salesType as string),
        productDocumentUrl: product.ProductDocumentUrl as string | undefined,
        ProductDocumentUrl: product.ProductDocumentUrl as string | undefined,
        productDocuments: (product.productDocuments || product.ProductDocuments || []) as QuickQuoteProduct['productDocuments'],
        bundleProducts: ((product.BundleProducts as QuickQuoteProduct['bundleProducts']) || []).map((bp) => ({
          ...bp,
          productId: bp?.productId || (bp as { ProductId?: string }).ProductId,
          name: bp?.name || (bp as { Name?: string }).Name,
          productName: bp?.productName || (bp as { Name?: string }).Name,
          productDocumentUrl: bp?.productDocumentUrl || (bp as { ProductDocumentUrl?: string }).ProductDocumentUrl,
          productDocuments: bp?.productDocuments || (bp as { ProductDocuments?: unknown }).ProductDocuments
        }))
      })) as QuickQuoteProduct[];
      setQuickQuoteProducts(mapped);
      setShowQuickQuoteModal(true);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to load products for Quick Quote');
    }
  }, [canUseQuickQuote]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (openActionMenuId && actionMenuPosition) {
        const target = event.target as HTMLElement;
        if (!target.closest('[data-action-menu]') && !target.closest('[data-action-button]')) {
          setOpenActionMenuId(null);
          setActionMenuPosition(null);
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openActionMenuId, actionMenuPosition]);

  const getTypeIcon = (templateType: string) =>
    templateType === 'Individual' ? <User className="h-4 w-4" /> : <Users className="h-4 w-4" />;

  const handleFilterChange = (field: keyof EnrollmentLinkTemplateFilters, value: unknown) => {
    setFilters((prev) => ({ ...prev, [field]: value, page: 1 }));
    setOpenActionMenuId(null);
    setActionMenuPosition(null);
  };

  const handleAgentFilterChange = (agentId: string) => {
    setSelectedAgentId(agentId);
    handleFilterChange('agentId', agentId || '');
  };

  const handleAgentSearch = useCallback((query: string) => {
    setAgentSearchQuery(query);
  }, []);

  const handlePageChange = (page: number) => {
    setFilters((prev) => ({ ...prev, page }));
  };

  const handleClearFilters = () => {
    setFilters({
      page: 1,
      limit: 20,
      searchTerm: '',
      templateType: '',
      isActive: true,
      tenantName: '',
      agentId: '',
      viewDownline: false,
      hasMarketingLink: true
    });
    setSelectedAgentId('');
    setAgentSearchQuery('');
    setSelectedAgentIdForFilter('');
    setSelectedDownlineAgentId('');
    setDownlineAgentSearchQuery('');
  };

  const renderFilters = () => (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center">
          <Filter className="h-5 w-5 mr-2 text-gray-700" />
          <h3 className="text-lg font-medium text-gray-900">Filters</h3>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowAdvancedFilters((v) => !v)}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Advanced filters
            <ChevronDown className={`h-4 w-4 transition-transform ${showAdvancedFilters ? 'rotate-180' : ''}`} />
          </button>
          <button type="button" onClick={handleClearFilters} className="text-sm text-oe-primary hover:text-oe-primary-dark">
            Clear All
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        {isAgent && !isAgencyOwner && !isTenantAdmin && user?.currentRole !== 'SysAdmin' && (
          <div className="min-w-0 flex-1 max-w-md">
            <label className="block text-sm font-medium text-gray-700 mb-1">Agent</label>
            <SearchableDropdown
              options={downlineAgentOptions.map((opt) => ({
                id: opt.id,
                label: opt.label,
                value: opt.value,
                email: opt.email
              }))}
              value={selectedAgentIdForFilter}
              onChange={(value) => setSelectedAgentIdForFilter(value)}
              placeholder="My links"
              searchPlaceholder="Search agents..."
              loading={isLoadingDownlineAgents}
              useBackendSearch={false}
              showEmail={true}
              className="w-full"
            />
          </div>
        )}
        {isAgencyOwner && (
          <div className="min-w-0 flex-1 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <label className="block text-sm font-medium text-gray-700 mb-2">Link scope</label>
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  id="scope-mine-mkt"
                  name="linkScopeMkt"
                  checked={linkScope === 'mine'}
                  onChange={() => {
                    setLinkScope('mine');
                    setSelectedDownlineAgentId('');
                  }}
                  className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                />
                <label htmlFor="scope-mine-mkt" className="text-sm text-gray-700">My links</label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  id="scope-downline-mkt"
                  name="linkScopeMkt"
                  checked={linkScope === 'downline'}
                  onChange={() => setLinkScope('downline')}
                  className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                />
                <label htmlFor="scope-downline-mkt" className="text-sm text-gray-700">My agent downlines</label>
              </div>
              {linkScope === 'downline' && (
                <div className="flex-1 min-w-[200px] max-w-md">
                  <SearchableDropdown
                    options={agentDropdownOptions}
                    value={selectedDownlineAgentId}
                    onChange={(value) => setSelectedDownlineAgentId(value)}
                    placeholder="All downline agents"
                    searchPlaceholder="Search agents..."
                    loading={isLoadingAgents}
                    onSearch={(q) => setDownlineAgentSearchQuery(q)}
                    useBackendSearch={false}
                    showEmail={true}
                    className="w-full"
                  />
                </div>
              )}
            </div>
          </div>
        )}
        {(isTenantAdmin || user?.currentRole === 'SysAdmin') && (
          <div className="min-w-0 flex-1 max-w-md">
            <label className="block text-sm font-medium text-gray-700 mb-1">Agent / Agency</label>
            <SearchableDropdown
              options={agentDropdownOptions}
              value={selectedAgentId}
              onChange={(value) => handleAgentFilterChange(value)}
              placeholder="All Agents / Agencies"
              searchPlaceholder="Search agents or agencies..."
              loading={isLoadingAgents}
              onSearch={handleAgentSearch}
              useBackendSearch={true}
              showEmail={true}
              showCode={user?.currentRole === 'SysAdmin'}
              className="w-full"
            />
          </div>
        )}
        <div className="w-full sm:w-auto min-w-[180px] sm:max-w-[220px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">Individual/Group</label>
          <select
            value={filters.templateType || ''}
            onChange={(e) => handleFilterChange('templateType', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="">Group & Individual</option>
            <option value="Individual">Individual</option>
            <option value="Group">Group</option>
          </select>
        </div>
      </div>
      {showAdvancedFilters && (
        <div className="mt-4 pt-4 border-t border-gray-200 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Search Links</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by template name or description..."
                value={filters.searchTerm}
                onChange={(e) => handleFilterChange('searchTerm', e.target.value)}
                className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              value={filters.isActive?.toString() ?? ''}
              onChange={(e) => handleFilterChange('isActive', e.target.value === '' ? '' : e.target.value === 'true')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="">All Statuses</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );

  const fetchMarketingLinkUrl = useCallback(
    async (template: EnrollmentLinkTemplate): Promise<string> => {
      const agentOrAgencyId = template.AgencyId || template.AgentId;
      let marketingLinkUrl = '';

      if (user?.currentRole === 'Agent') {
        const agentResponse = await apiService.get<{ success: boolean; data?: any[] | any }>('/api/me/agent/enrollment-links/static');
        if (agentResponse.success && agentResponse.data) {
          const links = Array.isArray(agentResponse.data) ? agentResponse.data : [agentResponse.data];
          const matchingLink = links.find(
            (link: any) =>
              ((link.templateId && link.templateId === template.TemplateId) ||
                (link.TemplateId && link.TemplateId === template.TemplateId) ||
                (link.EnrollmentLinkTemplateId && link.EnrollmentLinkTemplateId === template.TemplateId)) &&
              (link.linkType === 'Marketing' || link.LinkType === 'Marketing')
          );
          if (matchingLink) marketingLinkUrl = matchingLink.enrollmentUrl || matchingLink.linkUrl || matchingLink.LinkUrl || '';
        }
        if (!marketingLinkUrl && template.AgentId) {
          try {
            const r = await apiService.get<{ success: boolean; data?: any }>(
              `/api/me/tenant-admin/enrollment-link-templates/static-by-agent?agentId=${template.AgentId}&templateId=${template.TemplateId}`
            );
            if (r.success && r.data && (r.data.linkType === 'Marketing' || r.data.LinkType === 'Marketing'))
              marketingLinkUrl = r.data.enrollmentUrl || '';
          } catch (_) {}
        }
      } else if (user?.currentRole === 'TenantAdmin') {
        const agentOrAgencyId = template.AgentId || template.AgencyId;
        if (agentOrAgencyId) {
          const response = await apiService.get<{ success: boolean; data?: any }>(
            `/api/me/tenant-admin/enrollment-link-templates/static-by-agent?agentId=${agentOrAgencyId}&templateId=${template.TemplateId}`
          );
          if (response.success && response.data && (response.data.linkType === 'Marketing' || response.data.LinkType === 'Marketing'))
            marketingLinkUrl = response.data.enrollmentUrl || '';
        } else {
          const response = await apiService.get<{ success: boolean; data?: any[]; pagination?: any }>('/api/me/tenant-admin/enrollment-link-templates/static?page=1&limit=100');
          if (response.success && response.data) {
            const links = Array.isArray(response.data) ? response.data : [response.data];
            const matchingLink = links.find(
              (link: any) =>
                ((link.templateId && link.templateId === template.TemplateId) ||
                  (link.TemplateId && link.TemplateId === template.TemplateId) ||
                  (link.EnrollmentLinkTemplateId && link.EnrollmentLinkTemplateId === template.TemplateId)) &&
                (link.linkType === 'Marketing' || link.LinkType === 'Marketing')
            );
            if (matchingLink) marketingLinkUrl = matchingLink.enrollmentUrl || matchingLink.linkUrl || matchingLink.LinkUrl || '';
          }
        }
      } else if (user?.currentRole === 'SysAdmin') {
        const agentOrAgencyId = template.AgentId || template.AgencyId;
        if (agentOrAgencyId) {
          const response = await apiService.get<{ success: boolean; data?: any }>(
            `/api/me/sysadmin/enrollment-link-templates/static-by-agent?agentId=${agentOrAgencyId}&templateId=${template.TemplateId}`
          );
          if (response.success && response.data && (response.data.linkType === 'Marketing' || response.data.LinkType === 'Marketing'))
            marketingLinkUrl = response.data.enrollmentUrl || '';
        }
      }

      if (!marketingLinkUrl && agentOrAgencyId && (user?.currentRole === 'TenantAdmin' || user?.currentRole === 'Agent')) {
        try {
          if (user?.currentRole === 'Agent') {
            const res = await apiService.post<{ success: boolean; data?: { enrollmentUrl: string } }>('/api/me/agent/enrollment-links/create-marketing', { templateId: template.TemplateId });
            if (res.success && res.data?.enrollmentUrl) marketingLinkUrl = res.data.enrollmentUrl;
          } else {
            const res = await apiService.post<{ success: boolean; data?: { enrollmentUrl: string } }>('/api/me/tenant-admin/enrollment-link-templates/create-marketing', {
              templateId: template.TemplateId,
              agentId: agentOrAgencyId,
              currentTenantId: user?.currentTenantId
            });
            if (res.success && res.data?.enrollmentUrl) marketingLinkUrl = res.data.enrollmentUrl;
          }
        } catch (_) {}
      }
      return marketingLinkUrl;
    },
    [user?.currentRole, user?.currentTenantId]
  );

  const ACTION_MENU_WIDTH = 192;
  const ACTION_MENU_GAP = 4;

  const handleActionMenuClick = (templateId: string, event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const newOpenId = openActionMenuId === templateId ? null : templateId;
    setOpenActionMenuId(newOpenId);
    if (newOpenId) {
      const button = actionMenuRefs.current[newOpenId];
      if (button) {
        const rect = button.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom - ACTION_MENU_GAP;
        const y = rect.bottom + ACTION_MENU_GAP;
        let x = rect.right - ACTION_MENU_WIDTH;
        if (x < ACTION_MENU_GAP) x = ACTION_MENU_GAP;
        if (x + ACTION_MENU_WIDTH > window.innerWidth - ACTION_MENU_GAP) x = window.innerWidth - ACTION_MENU_WIDTH - ACTION_MENU_GAP;
        setActionMenuPosition({ x, y, maxHeight: Math.max(120, spaceBelow) });
      }
    } else {
      setActionMenuPosition(null);
    }
  };

  const handleCopyMarketingLink = async (template: EnrollmentLinkTemplate) => {
    setOpenActionMenuId(null);
    setActionMenuPosition(null);
    if (!paymentProcessorStatus?.hasApiToken) {
      const proceed = window.confirm(
        '⚠️ Warning: Payment processor API token is not configured for this tenant.\n\nThis marketing enrollment link may not work properly without payment processing setup.\n\nDo you want to continue anyway?'
      );
      if (!proceed) return;
    }
    setMutationError(null);
    setLoadingMarketingLinkUrl(true);
    try {
      const url = await fetchMarketingLinkUrl(template);
      if (url) {
        setMarketingLinkCopyModal({ template, linkUrl: url });
        loadTemplates();
      } else {
        setMutationError('Marketing link URL not found. Please try refreshing the page.');
      }
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to load marketing link URL.');
    } finally {
      setLoadingMarketingLinkUrl(false);
    }
  };

  const handleEdit = async (formData: any) => {
    if (!selectedTemplate) return;
    try {
      setMutationError(null);
      const updateRequest: UpdateTemplateRequest = {
        templateName: formData.templateName,
        templateType: formData.templateType,
        linkMetaData: typeof formData.linkMetaData === 'string' ? formData.linkMetaData : JSON.stringify(formData.linkMetaData),
        description: formData.description,
        isActive: formData.isActive,
        ...(formData.agentId !== undefined && { agentId: formData.agentId }),
        ...(formData.groupId !== undefined && { groupId: formData.groupId }),
        ...(formData.tenantId !== undefined && { tenantId: formData.tenantId })
      };
      await updateMutation.mutateAsync({ templateId: selectedTemplate.TemplateId, templateData: updateRequest });
      setSuccess('Template updated successfully');
      setEditDialogOpen(false);
      setSelectedTemplate(null);
      loadTemplates();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to update template');
    }
  };

  const handleDelete = async () => {
    if (!selectedTemplate) return;
    try {
      setMutationError(null);
      const result = await deleteMutation.mutateAsync(selectedTemplate.TemplateId);
      setSuccess(result?.message || 'Template deleted successfully');
      setDeleteDialogOpen(false);
      setSelectedTemplate(null);
      loadTemplates();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to delete template');
    }
  };

  const handleDuplicate = async (template: EnrollmentLinkTemplate) => {
    try {
      setMutationError(null);
      if (!user?.currentRole) {
        setMutationError('User role is required');
        return;
      }
      const result = await EnrollmentLinkTemplatesService.duplicateTemplate(template.TemplateId, user.currentRole);
      if (result.success) {
        setSuccess(`Template duplicated successfully: ${result.data?.templateName || 'New template'}`);
        loadTemplates();
      } else {
        setMutationError(result.message || 'Failed to duplicate template');
      }
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to duplicate template');
    }
  };

  const handleCopyToClipboard = async () => {
    if (!marketingLinkCopyModal?.linkUrl) return;
    if (!paymentProcessorStatus?.hasApiToken) {
      const proceed = window.confirm(
        '⚠️ Warning: Payment processor API token is not configured for this tenant.\n\nDo you want to copy the link anyway?'
      );
      if (!proceed) return;
    }
    try {
      await navigator.clipboard.writeText(marketingLinkCopyModal.linkUrl);
      setSuccess('Marketing link copied to clipboard!');
      setMarketingLinkCopyModal(null);
    } catch (error) {
      setMutationError('Failed to copy link to clipboard');
    }
  };

  const handleCreate = async (formData: any) => {
    try {
      setMutationError(null);
      const createRequest: CreateTemplateRequest & { currentRole?: string } = {
        templateName: formData.templateName,
        templateType: formData.templateType,
        tenantId: formData.tenantId,
        agentId: formData.agentId,
        linkMetaData: typeof formData.linkMetaData === 'string' ? formData.linkMetaData : JSON.stringify(formData.linkMetaData),
        description: formData.description,
        ...(formData.templateType === 'Group' && { groupId: formData.groupId }),
        currentRole: user?.currentRole
      };
      const templateResult = await createMutation.mutateAsync(createRequest);

      if ((user?.currentRole === 'Agent' || user?.currentRole === 'TenantAdmin') && templateResult?.templateId && (formData.templateType === 'Individual' || formData.templateType === 'Group')) {
        try {
          if (user?.currentRole === 'Agent') {
            const marketingLinkData = await apiService.post<{ success: boolean; data: { enrollmentUrl: string }; message?: string }>('/api/me/agent/enrollment-links/create-marketing', {
              templateId: templateResult.templateId
            });
            if (marketingLinkData.success) setSuccess(`Marketing enrollment link created! URL: ${marketingLinkData.data?.enrollmentUrl ?? ''}`);
            else setSuccess('Template created successfully, but failed to create marketing link');
          } else if (user?.currentRole === 'TenantAdmin' && (formData.agentId || formData.agencyId)) {
            const agentOrAgencyId = formData.agentId || formData.agencyId;
            const marketingLinkData = await apiService.post<{ success: boolean; data: { enrollmentUrl: string }; message?: string }>('/api/me/tenant-admin/enrollment-link-templates/create-marketing', {
              templateId: templateResult.templateId,
              agentId: agentOrAgencyId,
              currentTenantId: user?.currentTenantId
            });
            if (marketingLinkData.success) setSuccess(`Marketing enrollment link created! URL: ${marketingLinkData.data?.enrollmentUrl ?? ''}`);
            else setSuccess('Template created successfully, but failed to create marketing link');
          }
        } catch (marketingLinkError) {
          console.error('Error creating marketing link:', marketingLinkError);
          setSuccess('Template created successfully, but failed to create marketing link');
        }
      } else {
        setSuccess('Template created successfully');
      }
      setCreateDialogOpen(false);
      loadTemplates();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to create template');
    }
  };

  return (
    <div className="p-6">
      <>
          {success && (
            <div className="mb-4 alert alert-success flex justify-between items-center">
              <p className="text-sm font-medium">{success}</p>
              <button type="button" onClick={() => setSuccess(null)} className="text-[var(--oe-success)] hover:opacity-80">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {(templatesQuery.error || mutationError) && (
            <div className="mb-4 alert alert-error flex justify-between items-center">
              <p className="text-sm font-medium">
                {templatesQuery.error ? (templatesQuery.error as Error).message : mutationError}
              </p>
              <button
                type="button"
                onClick={() => {
                  loadTemplates();
                  setMutationError(null);
                }}
                className="text-[var(--oe-error)] hover:opacity-80"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <div className="bg-white rounded-lg border border-[var(--color-border)] p-6">
            <div className="flex flex-wrap items-center gap-3 mb-4">
              {canUseQuickQuote && (
                <button
                  type="button"
                  onClick={() => void openQuickQuote()}
                  className="btn-primary inline-flex items-center gap-2"
                >
                  <Sparkles className="h-4 w-4" />
                  Quick Quote
                </button>
              )}
              {(isAgent || isTenantAdmin) && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowSendProposalModal(true)}
                    className="btn-primary inline-flex items-center gap-2"
                  >
                    <Send className="h-4 w-4" />
                    Individual Proposal
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowBusinessProposalModal(true)}
                    className="btn-secondary inline-flex items-center gap-2"
                  >
                    <FileText className="h-4 w-4" />
                    Business Proposal
                  </button>
                </>
              )}
            </div>
            <p className="text-[var(--color-text-secondary)]">Sent proposals history coming soon.</p>
          </div>

      </>

      {/* Create Marketing Link Dialog */}
      <SimpleModal
        isOpen={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        title="Create Marketing Enrollment Link"
        size="large"
      >
        <EnrollmentLinkWizard
          onSave={handleCreate}
          onCancel={() => setCreateDialogOpen(false)}
          staticLinkMode={false}
          marketingLinkMode={true}
        />
      </SimpleModal>

      {/* View Details Modal */}
      <SimpleModal
        isOpen={viewDialogOpen}
        onClose={() => { setViewDialogOpen(false); setSelectedTemplate(null); }}
        title="Template Details"
        size="medium"
      >
        {selectedTemplate && (() => {
          let parsedMetadata: { household?: Record<string, unknown>; products?: any[] };
          try {
            parsedMetadata = JSON.parse(selectedTemplate.LinkMetaData);
          } catch {
            parsedMetadata = { household: {}, products: [] };
          }
          const products = parsedMetadata.products || [];
          const getProductTypeIcon = (productType: string) => {
            switch (productType?.toLowerCase()) {
              case 'medical':
              case 'healthcare': return '🏥';
              case 'dental': return '🦷';
              case 'vision': return '👁️';
              case 'life':
              case 'life insurance': return '❤️';
              case 'disability': return '♿';
              case 'accident': return '🚑';
              case 'critical illness': return '⚕️';
              case 'hospital indemnity': return '🏨';
              case 'telemedicine':
              case 'telemed': return '📱';
              default: return '📋';
            }
          };
          return (
            <div className="space-y-6">
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-gray-900 mb-3">Basic Information</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Link Name</label>
                    <p className="text-sm text-gray-900">{EnrollmentLinkTemplatesService.getDisplayTemplateName(selectedTemplate.TemplateName)}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${EnrollmentLinkTemplatesService.getTypeColor(selectedTemplate.TemplateType)}`}>
                      {getTypeIcon(selectedTemplate.TemplateType)}
                      <span className="ml-1">{selectedTemplate.TemplateType}</span>
                    </span>
                  </div>
                  {roleConfig.showTenantColumn && (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Tenant</label>
                      <p className="text-sm text-gray-900">{selectedTemplate.TenantName}</p>
                    </div>
                  )}
                  {roleConfig.showAgentColumn && selectedTemplate.AgentName && (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Agent / Agency</label>
                      <p className="text-sm text-gray-900">{selectedTemplate.AgentName}</p>
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${EnrollmentLinkTemplatesService.getStatusColor(selectedTemplate.IsActive)}`}>
                      {selectedTemplate.IsActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  {selectedTemplate.Description && (
                    <div className="md:col-span-2">
                      <label className="block text-xs font-medium text-gray-500 mb-1">Description</label>
                      <p className="text-sm text-gray-900">{selectedTemplate.Description}</p>
                    </div>
                  )}
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-gray-900">Product Sections</h4>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                    {products.length} {products.length === 1 ? 'section' : 'sections'}
                  </span>
                </div>
                {products.length > 0 ? (
                  <div className="space-y-2">
                    {products.map((product: any, index: number) => (
                      <div key={index} className="bg-white rounded-lg p-3 border border-gray-200">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center space-x-2 mb-1">
                              <span className="text-base">{getProductTypeIcon(product.productType)}</span>
                              <h5 className="text-sm font-medium text-gray-900">{product.page}</h5>
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">{product.productType}</span>
                            </div>
                            {product.description && <p className="text-xs text-gray-500 ml-6">{product.description}</p>}
                          </div>
                          <span className="text-xs text-gray-400 ml-4">#{index + 1}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">No product sections configured</p>
                )}
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-gray-900 mb-3">Metadata</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block font-medium text-gray-500 mb-1">Created</label>
                    <p className="text-gray-900">{EnrollmentLinkTemplatesService.formatDate(selectedTemplate.CreatedDate)}</p>
                    <p className="text-gray-500">by {selectedTemplate.CreatedByName}</p>
                  </div>
                  <div>
                    <label className="block font-medium text-gray-500 mb-1">Last Modified</label>
                    <p className="text-gray-900">{EnrollmentLinkTemplatesService.formatDate(selectedTemplate.ModifiedDate)}</p>
                    <p className="text-gray-500">by {selectedTemplate.ModifiedByName}</p>
                  </div>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => { setViewDialogOpen(false); setSelectedTemplate(null); }}
                  className="btn-secondary"
                >
                  Close
                </button>
              </div>
            </div>
          );
        })()}
      </SimpleModal>

      {/* Edit Dialog */}
      <SimpleModal
        isOpen={editDialogOpen}
        onClose={() => { setEditDialogOpen(false); setSelectedTemplate(null); }}
        title="Edit Marketing Enrollment Link"
        size="large"
      >
        {selectedTemplate && (
          <EnrollmentLinkWizard
            template={selectedTemplate}
            onSave={handleEdit}
            onCancel={() => { setEditDialogOpen(false); setSelectedTemplate(null); }}
            isEditing={true}
            staticLinkMode={false}
            marketingLinkMode={true}
          />
        )}
      </SimpleModal>

      {/* Delete Confirmation Dialog */}
      <SimpleModal
        isOpen={deleteDialogOpen}
        onClose={() => { setDeleteDialogOpen(false); setSelectedTemplate(null); }}
        title="Confirm Delete"
        size="small"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-900">
            Are you sure you want to delete the template "{selectedTemplate ? EnrollmentLinkTemplatesService.getDisplayTemplateName(selectedTemplate.TemplateName) : ''}"?
          </p>
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <p className="text-sm text-yellow-700 font-semibold">All enrollment links using this template will be permanently deleted and become invalid immediately.</p>
          </div>
          <div className="flex justify-end space-x-3">
            <button
              type="button"
              onClick={() => { setDeleteDialogOpen(false); setSelectedTemplate(null); }}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="btn-danger"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Link'}
            </button>
          </div>
        </div>
      </SimpleModal>

      {/* Marketing Link Copy Modal */}
      {marketingLinkCopyModal && (
        <SimpleModal
          isOpen={!!marketingLinkCopyModal}
          onClose={() => setMarketingLinkCopyModal(null)}
          title="Marketing Enrollment Link"
          size="small"
        >
          <div className="p-6">
            <div className="mb-4">
              <p className="text-sm text-gray-600 mb-2">Copy this marketing enrollment link to share on your website:</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm break-all">
                  {marketingLinkCopyModal.linkUrl}
                </code>
                <button
                  type="button"
                  onClick={handleCopyToClipboard}
                  className="btn-primary flex items-center gap-2 whitespace-nowrap"
                >
                  <Copy className="h-4 w-4" />
                  Copy Link
                </button>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setMarketingLinkCopyModal(null)}
                className="btn-secondary"
              >
                Close
              </button>
            </div>
          </div>
        </SimpleModal>
      )}

      {showSendProposalModal && (
        <SendProposalModal
          isOpen={showSendProposalModal}
          onClose={() => setShowSendProposalModal(false)}
        />
      )}

      {showBusinessProposalModal && (
        <BusinessProposalModal
          isOpen={showBusinessProposalModal}
          onClose={() => setShowBusinessProposalModal(false)}
        />
      )}
      {showQuickQuoteModal && (
        <QuickQuoteWizardModal
          isOpen={showQuickQuoteModal}
          onClose={() => setShowQuickQuoteModal(false)}
          products={quickQuoteProducts}
        />
      )}
    </div>
  );
};

export default MarketingPage;
