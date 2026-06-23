import { Building2, CheckCircle, ChevronDown, Copy, Edit, Eye, Mail, MessageSquare, Plus, Search, Send, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import RichTextEditor, { type RichTextEditorRef } from '../../components/common/RichTextEditor';
import EmailEditor from '../../components/common/EmailEditor';
import ScopePill from '../../components/messaging/ScopePill';
import ScopeFilterDropdown, { type ScopeFilter } from '../../components/messaging/ScopeFilterDropdown';
import CreateForField, { type CreateForValue } from '../../components/messaging/CreateForField';
import { apiService } from '../../services/api.service';
import { toast } from '../../components/common/Toast';
import { useAuth } from '../../hooks/useAuth';
import { useTenants } from '../../hooks/useTenants';
import { messageTemplateService, campaignService, type MessageTemplate } from '../../services/messageCenter.service';
import { withMarketingFooterPreview } from '../../utils/marketingFooterPreview';

interface MessageTemplateWithTenant extends MessageTemplate {
  tenantName?: string;
}

interface Tenant {
  TenantId: string;
  Name: string;
  Status: string;
}

const MessageTemplatesPage: React.FC = () => {
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  // Fallback to localStorage if user.currentRole is not available
  const currentRole = user?.currentRole || localStorage.getItem('currentRole');
  const isSysAdmin = currentRole === 'SysAdmin';
  
  const { data: tenants = [], isLoading: tenantsLoading } = useTenants(isSysAdmin);
  
  // Message Templates state
  const [templates, setTemplates] = useState<MessageTemplateWithTenant[]>([]);
  const [filteredTemplates, setFilteredTemplates] = useState<MessageTemplateWithTenant[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<MessageTemplateWithTenant | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<'All' | 'Email' | 'SMS'>('All');
  const [campaignFilter, setCampaignFilter] = useState<string>('');
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  const [showTenantDropdown, setShowTenantDropdown] = useState(false);
  const [tenantSearchQuery, setTenantSearchQuery] = useState('');
  const [selectedTenantFilter, setSelectedTenantFilter] = useState<string>('');
  // SysAdmin-only scope filter (All / Tenant / Vendor) -> backend ?scope= param.
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  // SysAdmin-only "Create for" picker state.
  const [createFor, setCreateFor] = useState<CreateForValue>({ mode: 'tenant', tenantId: '', vendorId: null });
  const tenantDropdownRef = useRef<HTMLDivElement>(null);
  const [showTenantFilterDropdown, setShowTenantFilterDropdown] = useState(false);
  const [tenantFilterQuery, setTenantFilterQuery] = useState('');
  const tenantFilterDropdownRef = useRef<HTMLDivElement>(null);
  const bodyEditorRef = useRef<RichTextEditorRef>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);
  const replyToInputRef = useRef<HTMLInputElement>(null);
  const focusedFieldRef = useRef<'subject' | 'replyTo' | 'body'>('body');

  const [welcomeEmailTemplateId, setWelcomeEmailTemplateId] = useState<string | null>(null);
  const [defaultWelcomeTemplateId, setDefaultWelcomeTemplateId] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    tenantId: '',
    tenantName: '',
    templateName: '',
    messageType: 'Email' as 'Email' | 'SMS',
    messageCategory: 'Marketing' as 'Marketing' | 'System',
    category: '',
    subject: '',
    replyTo: '',
    body: '',
    designJson: '',
    isActive: true,
    useAsWelcomeEmail: false
  });

  const availableVariables = [
    { group: 'Member Information', variables: [
      'member.FirstName', 'member.LastName', 'member.Email', 'member.Phone', 'member.TerminationDate'
    ]},
    { group: 'Plan Information', variables: [
      'plan.Name'
    ]},
    { group: 'Agent Information', variables: [
      'agent.Name', 'agent.Email', 'agent.Phone', 'agent.FirstName', 'agent.LastName'
    ]},
    { group: 'Tenant Information', variables: [
      'tenant.Name', 'tenant.Phone', 'tenant.Email'
    ]},
    { group: 'System', variables: ['system.CurrentDate', 'system.LoginUrl']}
  ];

  useEffect(() => {
    if (!isSysAdmin && activeTenantId) {
      setFormData(prev => ({ ...prev, tenantId: activeTenantId }));
    }
  }, [isSysAdmin, activeTenantId]);

  const loadWelcomeEmailTemplate = useCallback(async () => {
    const canManageWelcome = currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';
    if (!user || !canManageWelcome) return;
    try {
      // SysAdmin with a tenant filter: get welcome template for that tenant; otherwise use current context
      const contextTenantId = isSysAdmin && selectedTenantFilter && selectedTenantFilter !== '__ALL__'
        ? selectedTenantFilter
        : undefined;
      const res = await messageTemplateService.getWelcomeEmailTemplate(contextTenantId);
      if (res.success && res.data) {
        setWelcomeEmailTemplateId(res.data.welcomeEmailTemplateId ?? null);
        setDefaultWelcomeTemplateId(res.data.defaultWelcomeTemplateId ?? null);
      }
    } catch (err) {
      console.error('Failed to load welcome email template:', err);
    }
  }, [user, currentRole, isSysAdmin, selectedTenantFilter]);

  const loadTemplates = useCallback(async () => {
    // Don't load if user is not ready
    if (!user) {
      return;
    }
    
    setIsLoading(true);
    
    try {
      const params: any = {
        page: 1,
        limit: 100
      };

      if (isSysAdmin) {
        if (selectedTenantFilter && selectedTenantFilter !== '__ALL__') {
          params.tenantId = selectedTenantFilter;
        }
        // Scope filter: All / Tenant / Vendor. Omit when 'all'.
        if (scopeFilter !== 'all') {
          params.scope = scopeFilter;
        }
      }
      
      const response = await messageTemplateService.getTemplates(params);
      
      if (response.success && response.data) {
        const templatesData = response.data.data || [];
        
        if (isSysAdmin && templatesData.length > 0) {
          const toId = (id: string | null | undefined) => (id ?? '').toString().trim().toLowerCase();
          const enrichedTemplates: MessageTemplateWithTenant[] = templatesData.map((template) => {
            const templateTid = template.tenantId ?? '';
            const tenant = tenants.find(
              (t) => toId((t as { TenantId?: string }).TenantId ?? (t as { tenantId?: string }).tenantId) === toId(templateTid)
            );
            const tenantName =
              tenant
                ? (tenant as { Name?: string }).Name ?? (tenant as { name?: string }).name ?? 'Unknown'
                : !templateTid
                  ? 'All Tenants'
                  : 'Unknown';
            return {
              ...template,
              tenantName
            };
          });
          // When filtering for All Tenants, apply it to the enriched list as well
          const finalTemplates = selectedTenantFilter === '__ALL__'
            ? enrichedTemplates.filter((t) => !t.tenantId)
            : enrichedTemplates;
          setTemplates(finalTemplates);
          setFilteredTemplates(finalTemplates);
        } else {
          setTemplates(templatesData);
          setFilteredTemplates(templatesData);
        }
      } else {
        setTemplates([]);
        setFilteredTemplates([]);
      }
    } catch (err) {
      console.error('Failed to load templates:', err);
      setTemplates([]);
      setFilteredTemplates([]);
    } finally {
      setIsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTenantFilter, isSysAdmin, tenants, user, scopeFilter]);

  useEffect(() => {
    if (!tenantsLoading && user) {
      loadTemplates();
      loadWelcomeEmailTemplate();
      // Load campaigns for filter dropdown
      campaignService.getCampaigns().then(resp => {
        if (resp.success && resp.data) setCampaigns(Array.isArray(resp.data) ? resp.data : []);
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantsLoading, user, selectedTenantFilter, scopeFilter]);

  useEffect(() => {
    let filtered = templates;
    
    if (searchTerm) {
      filtered = filtered.filter(template =>
        template.templateName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        template.body?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        template.subject?.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
    
    if (filterType !== 'All') {
      filtered = filtered.filter(template => template.messageType === filterType);
    }
    
    setFilteredTemplates(filtered);
  }, [templates, searchTerm, filterType]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (tenantDropdownRef.current && !tenantDropdownRef.current.contains(event.target as Node)) {
        setShowTenantDropdown(false);
      }
      if (tenantFilterDropdownRef.current && !tenantFilterDropdownRef.current.contains(event.target as Node)) {
        setShowTenantFilterDropdown(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCreate = async () => {
    if (!formData.templateName || !formData.body || !formData.messageType) {
      toast.error('Please fill in all required fields');
      return;
    }

    let tenantId: string | null = null;
    let createForTenantId: string | undefined;
    let createForVendorId: string | null | undefined;

    if (isSysAdmin) {
      // SysAdmin "Create for":
      //   - Tenant mode: must pick a tenant; send createForTenantId only.
      //   - Vendor mode: must pick a vendor; send createForVendorId only
      //     (backend infers the TenantId from the vendor's portal users).
      if (createFor.mode === 'tenant') {
        if (!createFor.tenantId) {
          toast.error('Please pick a tenant to create this template for');
          return;
        }
        createForTenantId = createFor.tenantId;
        createForVendorId = undefined;
        tenantId = createFor.tenantId;
      } else {
        if (!createFor.vendorId) {
          toast.error('Please pick a vendor to create this template for');
          return;
        }
        createForVendorId = createFor.vendorId;
        createForTenantId = undefined;
        tenantId = null;
      }
    } else {
      tenantId = activeTenantId || null;
    }

    setIsLoading(true);
    try {
      const templateData: any = {
        tenantId,
        templateName: formData.templateName,
        messageType: formData.messageType,
        messageCategory: formData.messageCategory,
        category: formData.category || 'General',
        subject: formData.subject,
        body: formData.body,
        replyTo: formData.replyTo || undefined,
        isActive: formData.isActive,
        variables: [],
        createdBy: user?.userId || ''
      };
      if (isSysAdmin) {
        // Send only the field that matches the picked mode. Vendor flow omits
        // createForTenantId so the backend infers it from oe.Users.
        if (createForTenantId !== undefined) {
          templateData.createForTenantId = createForTenantId;
        }
        if (createForVendorId !== undefined) {
          templateData.createForVendorId = createForVendorId;
        }
      }

      const response = await messageTemplateService.createTemplate(templateData);

      if (response.success) {
        const createdTemplateId = (response.data as { templateId?: string })?.templateId;
        if (formData.useAsWelcomeEmail && formData.messageType === 'Email' && createdTemplateId) {
          try {
            const welcomeTenantId = (formData.tenantName === 'All Tenants' || !formData.tenantId) ? null : formData.tenantId;
            await messageTemplateService.setWelcomeEmailTemplate(createdTemplateId, welcomeTenantId);
          } catch (welcomeErr) {
            console.error('Template created but failed to set as welcome email:', welcomeErr);
          }
        }
        await loadTemplates();
        setIsCreateModalOpen(false);
        resetForm();
      }
    } catch (err) {
      console.error('Failed to create template:', err);
      toast.error('Failed to create template');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!selectedTemplate || !formData.templateName || !formData.body) return;

    // Resolve tenantId like create: null for global ("All Tenants") when SysAdmin
    let tenantId: string | null = null;
    if (isSysAdmin) {
      if (formData.tenantName === 'All Tenants' || !formData.tenantId || formData.tenantId === '') {
        tenantId = null;
      } else {
        tenantId = formData.tenantId;
      }
    } else {
      tenantId = activeTenantId || null;
    }
    if (!tenantId && (isSysAdmin ? formData.tenantName !== 'All Tenants' : true)) {
      toast.error('Please select a tenant');
      return;
    }

    setIsLoading(true);
    try {
      // Check if template is used in any campaigns
      try {
        const usageResponse = await campaignService.getTemplateUsage(selectedTemplate.templateId);
        if (usageResponse.success && usageResponse.data && usageResponse.data.length > 0) {
          const campaignNames = usageResponse.data.map((c: any) => c.campaignName || c.CampaignName).join(', ');
          const confirmed = window.confirm(
            `This template is used in the following campaigns:\n\n${campaignNames}\n\nChanges will affect all of them. Continue?`
          );
          if (!confirmed) {
            setIsLoading(false);
            return;
          }
        }
      } catch (usageErr) {
        console.error('Failed to check template usage:', usageErr);
        // Continue with save — non-blocking check
      }

      const updateData: any = {
        tenantId,
        templateName: formData.templateName,
        messageType: formData.messageType,
        messageCategory: formData.messageCategory,
        category: formData.category || 'General',
        subject: formData.subject,
        body: formData.body,
        replyTo: formData.replyTo || undefined,
        isActive: formData.isActive,
        variables: selectedTemplate.variables || [],
        modifiedBy: user?.userId || ''
      };

      // SysAdmin owner reassignment: send the chosen scope from the CreateForField picker.
      // XOR enforced backend-side (and by CK_MessageTemplates_TenantOrVendor).
      if (isSysAdmin) {
        if (createFor.mode === 'tenant') {
          if (!createFor.tenantId) {
            toast.error('Please pick a tenant in the "Owned by" picker');
            setIsLoading(false);
            return;
          }
          updateData.tenantId = createFor.tenantId;
          updateData.vendorId = null;
        } else {
          if (!createFor.vendorId) {
            toast.error('Please pick a vendor in the "Owned by" picker');
            setIsLoading(false);
            return;
          }
          updateData.tenantId = null;
          updateData.vendorId = createFor.vendorId;
        }
      }

      const response = await messageTemplateService.updateTemplate(
        selectedTemplate.templateId,
        updateData as any
      );

      if (response.success) {
        if (formData.messageType === 'Email') {
          try {
            const welcomeTenantId = (formData.tenantName === 'All Tenants' || !formData.tenantId) ? null : formData.tenantId;
            if (formData.useAsWelcomeEmail) {
              await messageTemplateService.setWelcomeEmailTemplate(selectedTemplate.templateId, welcomeTenantId);
            } else if (welcomeEmailTemplateId === selectedTemplate.templateId || defaultWelcomeTemplateId === selectedTemplate.templateId) {
              await messageTemplateService.setWelcomeEmailTemplate(null, welcomeTenantId);
            }
          } catch (welcomeErr) {
            console.error('Template updated but welcome email setting failed:', welcomeErr);
          }
        }
        await loadTemplates();
        setIsEditModalOpen(false);
        setSelectedTemplate(null);
        resetForm();
      }
    } catch (err) {
      console.error('Failed to update template:', err);
      toast.error('Failed to update template');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (templateId: string) => {
    if (!window.confirm('Are you sure you want to delete this template?')) return;

    setIsLoading(true);
    try {
      const response = await messageTemplateService.deleteTemplate(templateId);
      if (response.success) {
        await loadTemplates();
      }
    } catch (err) {
      console.error('Failed to delete template:', err);
      toast.error('Failed to delete template');
    } finally {
      setIsLoading(false);
    }
  };

  const canManageWelcomeEmail = currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';

  const handleEdit = (template: MessageTemplateWithTenant) => {
    setSelectedTemplate(template);
    setFormData({
      tenantId: template.tenantId ?? '',
      tenantName: template.tenantName || '',
      templateName: template.templateName,
      messageType: template.messageType,
      messageCategory: template.messageCategory === 'System' ? 'System' : 'Marketing',
      category: template.category || '',
      subject: template.subject || '',
      replyTo: template.replyTo ?? '',
      body: template.body,
      designJson: (template as any).designJson || '',
      isActive: template.isActive,
      useAsWelcomeEmail: canManageWelcomeEmail && template.messageType === 'Email' && (welcomeEmailTemplateId === template.templateId || (defaultWelcomeTemplateId === template.templateId && !template.tenantId))
    });
    setTenantSearchQuery(template.tenantName || '');
    // Initialize the "Create for" picker from the template's current scope so SysAdmin can reassign.
    if (template.vendorId) {
      setCreateFor({ mode: 'vendor', tenantId: '', vendorId: template.vendorId });
    } else {
      setCreateFor({ mode: 'tenant', tenantId: template.tenantId ?? '', vendorId: null });
    }
    setIsEditModalOpen(true);
  };

  const handlePreview = (template: MessageTemplateWithTenant) => {
    setSelectedTemplate(template);
    setIsPreviewModalOpen(true);
  };

  const handleDuplicate = async (template: MessageTemplateWithTenant) => {
    try {
      setIsLoading(true);
      const templateData = {
        tenantId: template.tenantId || (isSysAdmin ? null : activeTenantId || null),
        templateName: `${template.templateName} (Copy)`,
        messageType: template.messageType,
        messageCategory: template.messageCategory === 'System' ? 'System' : 'Marketing',
        category: template.category || 'General',
        subject: template.subject || '',
        body: template.body || '',
        replyTo: template.replyTo || undefined,
        isActive: template.isActive,
        variables: [],
        createdBy: user?.userId || ''
      };
      const response = await messageTemplateService.createTemplate(templateData as any);
      if (response.success) {
        await loadTemplates();
      }
    } catch (err) {
      console.error('Failed to duplicate template:', err);
      toast.error('Failed to duplicate template');
    } finally {
      setIsLoading(false);
    }
  };

  // Quick Send state
  const [quickSendTemplate, setQuickSendTemplate] = useState<MessageTemplateWithTenant | null>(null);
  const [quickSendEmail, setQuickSendEmail] = useState('');
  const [quickSendSending, setQuickSendSending] = useState(false);

  const handleQuickSend = async () => {
    if (!quickSendTemplate || !quickSendEmail.trim()) return;
    const emails = quickSendEmail.split(/[,;\n]+/).map(e => e.trim().toLowerCase()).filter(e => e.includes('@'));
    if (emails.length === 0) { toast.error('Please enter at least one valid email address'); return; }
    setQuickSendSending(true);
    try {
      const cleanBody = quickSendTemplate.body.replace(/\n?<!-- DESIGN_JSON:.*? -->/s, '');
      const res = await apiService.post('/api/message-center/quick-send', {
        templateId: quickSendTemplate.templateId,
        recipientEmails: emails,
        subject: quickSendTemplate.subject || quickSendTemplate.templateName,
        body: cleanBody
      });
      if ((res as any).success) {
        const sent = (res as any).count ?? emails.length;
        const skipped = (res as any).skipped ?? 0;
        toast.success(
          skipped > 0
            ? `Email sent to ${sent} recipient${sent !== 1 ? 's' : ''}; ${skipped} skipped (unsubscribed from marketing).`
            : `Email sent to ${sent} recipient${sent !== 1 ? 's' : ''}!`
        );
        setQuickSendTemplate(null);
        setQuickSendEmail('');
      } else {
        toast.error('Failed to send: ' + ((res as any).message || 'Unknown error'));
      }
    } catch (err: any) {
      toast.error('Failed to send: ' + (err.message || 'Unknown error'));
    } finally {
      setQuickSendSending(false);
    }
  };

  const insertVariable = (variable: string) => {
    const variableTag = `{[${variable}]}`;
    const target = focusedFieldRef.current;
    if (target === 'subject' && subjectInputRef.current) {
      const input = subjectInputRef.current;
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? 0;
      const value = formData.subject;
      const newValue = value.slice(0, start) + variableTag + value.slice(end);
      setFormData((prev) => ({ ...prev, subject: newValue }));
      setTimeout(() => {
        input.focus();
        const pos = start + variableTag.length;
        input.setSelectionRange(pos, pos);
      }, 0);
      return;
    }
    if (target === 'replyTo' && replyToInputRef.current) {
      const input = replyToInputRef.current;
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? 0;
      const value = formData.replyTo;
      const newValue = value.slice(0, start) + variableTag + value.slice(end);
      setFormData((prev) => ({ ...prev, replyTo: newValue }));
      setTimeout(() => {
        input.focus();
        const pos = start + variableTag.length;
        input.setSelectionRange(pos, pos);
      }, 0);
      return;
    }
    bodyEditorRef.current?.insertText(variableTag);
  };

  const resetForm = () => {
    setFormData({
      tenantId: isSysAdmin ? '' : activeTenantId,
      tenantName: '',
      templateName: '',
      messageType: 'Email',
      messageCategory: 'Marketing',
      category: '',
      subject: '',
      replyTo: '',
      body: '',
      designJson: '',
      isActive: true,
      useAsWelcomeEmail: false
    });
    setTenantSearchQuery('');
    setCreateFor({ mode: 'tenant', tenantId: '', vendorId: null });
  };

  const selectTenant = (tenant: Tenant) => {
    setFormData(prev => ({ 
      ...prev, 
      tenantId: tenant.TenantId,
      tenantName: tenant.Name
    }));
    setTenantSearchQuery(tenant.Name);
    setShowTenantDropdown(false);
  };

  const filteredTenants = tenants.filter(tenant =>
    tenant.Name.toLowerCase().includes(tenantSearchQuery.toLowerCase())
  );
  const filteredFilterTenants = tenants.filter(tenant =>
    tenant.Name.toLowerCase().includes(tenantFilterQuery.toLowerCase())
  );

  // Safety check: don't render if user is not loaded
  if (!user) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#1f8dbf]"></div>
      </div>
    );
  }

  if (isLoading && templates.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#1f8dbf]"></div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto min-w-0 overflow-x-hidden">
      <div className="mb-6">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Email Templates</h1>
            <p className="text-sm text-gray-500 mt-1">Create and manage email and SMS templates</p>
          </div>
        </div>
      </div>

      <>
          <div className="mb-6 flex justify-between items-center">
            <div></div>
        <button
          onClick={() => {
            resetForm();
            setIsCreateModalOpen(true);
          }}
          className="flex items-center space-x-2 px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#175a7a]"
        >
          <Plus className="h-5 w-5" />
          <span>Create Template</span>
        </button>
      </div>

      <div className="mb-6 bg-white p-4 rounded-lg shadow-sm border border-gray-200">
        <div className="flex flex-wrap gap-4">
          <div className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search templates..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
              />
            </div>
          </div>
          
          {isSysAdmin && (
            <div className="relative min-w-[240px]" ref={tenantFilterDropdownRef}>
              <div className="relative">
                <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  value={tenantFilterQuery}
                  onChange={(e) => {
                    setTenantFilterQuery(e.target.value);
                    setShowTenantFilterDropdown(true);
                  }}
                  onFocus={() => setShowTenantFilterDropdown(true)}
                  placeholder="Filter by tenant or choose All Tenants (global)"
                  className="w-full pl-9 pr-20 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                />
                {(selectedTenantFilter || tenantFilterQuery) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedTenantFilter('');
                      setTenantFilterQuery('');
                    }}
                    className="absolute right-8 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                    aria-label="Clear tenant filter"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setShowTenantFilterDropdown(!showTenantFilterDropdown);
                    if (!showTenantFilterDropdown) {
                      setTenantFilterQuery('');
                    }
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                >
                  <ChevronDown className={`h-4 w-4 transition-transform ${showTenantFilterDropdown ? 'rotate-180' : ''}`} />
                </button>
              </div>
              {showTenantFilterDropdown && (
                <div className="absolute z-20 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedTenantFilter('__ALL__');
                      setTenantFilterQuery('All Tenants');
                      setShowTenantFilterDropdown(false);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center justify-between border-b border-gray-200"
                  >
                    <div>
                      <div className="font-medium text-blue-800">All Tenants</div>
                      <div className="text-xs text-oe-primary">Show global templates (no tenant)</div>
                    </div>
                    {selectedTenantFilter === '__ALL__' && (
                      <span className="text-[#1f8dbf] font-medium">✓</span>
                    )}
                  </button>
                  {filteredFilterTenants.length === 0 ? (
                    <div className="p-3 text-sm text-gray-500">{tenantFilterQuery ? 'No tenants found' : 'No tenants available'}</div>
                  ) : (
                    filteredFilterTenants.map(tenant => (
                      <button
                        key={tenant.TenantId}
                        type="button"
                        onClick={() => {
                          setSelectedTenantFilter(tenant.TenantId);
                          setTenantFilterQuery(tenant.Name);
                          setShowTenantFilterDropdown(false);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-gray-100 flex items-center justify-between border-b border-gray-100 last:border-b-0"
                      >
                        <div>
                          <div className="font-medium text-gray-900">{tenant.Name}</div>
                          <div className="text-xs text-gray-500">ID: {tenant.TenantId.slice(-8)}</div>
                        </div>
                        {tenant.TenantId === selectedTenantFilter && (
                          <span className="text-[#1f8dbf] font-medium">✓</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as 'All' | 'Email' | 'SMS')}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf]"
          >
            <option value="All">All Types</option>
            <option value="Email">Email</option>
            <option value="SMS">SMS</option>
          </select>

          {isSysAdmin && (
            <ScopeFilterDropdown value={scopeFilter} onChange={setScopeFilter} />
          )}

          <select
            value={campaignFilter}
            onChange={(e) => setCampaignFilter(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf]"
          >
            <option value="">All Campaigns</option>
            {campaigns.map((c: any) => (
              <option key={c.campaignId || c.CampaignId} value={c.campaignId || c.CampaignId}>
                {c.campaignName || c.CampaignName}
              </option>
            ))}
          </select>

          <button
            onClick={loadTemplates}
            disabled={isLoading}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {filteredTemplates.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <Mail className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No templates found</h3>
          <p className="text-gray-500 mb-4">
            {searchTerm || filterType !== 'All' 
              ? 'Try adjusting your filters'
              : 'Get started by creating your first template'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 min-w-0">
          {filteredTemplates.map((template) => (
            <div key={template.templateId} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow min-w-0 overflow-hidden flex flex-col">
              <div className="flex justify-between items-start gap-2 mb-3 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  {template.messageType === 'Email' ? (
                    <Mail className="h-4 w-4 text-[#1f8dbf] shrink-0" />
                  ) : (
                    <MessageSquare className="h-4 w-4 text-green-600 shrink-0" />
                  )}
                  <span className="text-sm font-medium text-gray-700 truncate">{template.messageType}</span>
                  {template.messageCategory === 'System' && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 shrink-0">System</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {template.messageType === 'Email' && canManageWelcomeEmail && (welcomeEmailTemplateId === template.templateId || (defaultWelcomeTemplateId === template.templateId && !template.tenantId)) && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 text-blue-800 whitespace-nowrap">
                      <CheckCircle className="h-3 w-3" />
                      Welcome
                    </span>
                  )}
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap ${
                    template.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                  }`}>
                    {template.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 mb-2 min-w-0">
                <h3 className="font-medium text-gray-900 truncate flex-1 min-w-0">{template.templateName}</h3>
                <ScopePill vendorId={template.vendorId} />
              </div>

              {isSysAdmin && (template.vendorId ? (template as any).vendorName : template.tenantName) && (
                <div className="flex items-center text-sm text-gray-600 mb-2 min-w-0">
                  <Building2 className="h-3 w-3 mr-1 shrink-0" />
                  <span className="truncate">
                    {template.vendorId ? (template as any).vendorName : template.tenantName}
                  </span>
                </div>
              )}

              {template.subject && (
                <p className="text-sm text-gray-600 mb-4 truncate min-w-0">
                  <span className="font-medium">Subject:</span> {template.subject}
                </p>
              )}

              <div className="flex items-center gap-1 pt-3 border-t border-gray-100 shrink-0 mt-auto">
                <button onClick={() => handlePreview(template)} title="Preview"
                  className="flex-1 min-w-0 px-2 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors flex items-center justify-center">
                  <Eye className="h-4 w-4 shrink-0" />
                </button>
                <button onClick={() => handleEdit(template)} title="Edit"
                  className="flex-1 min-w-0 px-2 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors flex items-center justify-center">
                  <Edit className="h-4 w-4 shrink-0" />
                </button>
                <button onClick={() => handleDuplicate(template)} title="Duplicate"
                  className="flex-1 min-w-0 px-2 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors flex items-center justify-center">
                  <Copy className="h-4 w-4 shrink-0" />
                </button>
                <button onClick={() => { setQuickSendTemplate(template); setQuickSendEmail(''); }} title="Quick Send"
                  className="flex-1 min-w-0 px-2 py-1.5 text-oe-primary hover:text-blue-900 hover:bg-blue-50 rounded transition-colors flex items-center justify-center">
                  <Send className="h-4 w-4 shrink-0" />
                </button>
                <button onClick={() => handleDelete(template.templateId)} title="Delete"
                  className="flex-1 min-w-0 px-2 py-1.5 text-red-600 hover:text-red-900 hover:bg-red-100 rounded transition-colors flex items-center justify-center">
                  <Trash2 className="h-4 w-4 shrink-0" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(isCreateModalOpen || isEditModalOpen) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className={`bg-white rounded-lg w-full overflow-hidden flex flex-col ${formData.messageType === 'Email' ? 'max-w-5xl h-[90vh]' : 'max-w-4xl max-h-[90vh]'}`}>
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
              <h2 className="text-lg font-semibold">
                {isCreateModalOpen ? 'Create Template' : 'Edit Template'}
              </h2>
              <button
                onClick={() => {
                  setIsCreateModalOpen(false);
                  setIsEditModalOpen(false);
                  resetForm();
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            
            <div className="flex flex-col flex-1 min-h-0">
              {/* SysAdmin-only: "Create for" / "Owned by" picker. Visible in both create and edit modes. */}
              {isSysAdmin && (isCreateModalOpen || isEditModalOpen) && (
                <div className="px-6 pt-4 flex-shrink-0">
                  <CreateForField tenants={tenants} value={createFor} onChange={setCreateFor} />
                </div>
              )}

              {/* Compact form fields at top */}
              <div className="px-6 py-4 border-b border-gray-200 bg-gray-50 flex-shrink-0">
                <div className="flex flex-wrap gap-3 items-end">
                  {/* Legacy Tenant picker — hidden; the new "Owned by" CreateForField at the top handles tenant/vendor reassignment. */}
                  {false && isSysAdmin && isEditModalOpen && (
                    <div className="w-48 relative" ref={tenantDropdownRef}>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Tenant</label>
                      <div className="relative">
                        <Building2 className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                        <input type="text" value={tenantSearchQuery}
                          onChange={e => { setTenantSearchQuery(e.target.value); setShowTenantDropdown(true); }}
                          onFocus={() => setShowTenantDropdown(true)}
                          placeholder="All tenants..."
                          className="w-full pl-7 pr-7 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-[#1f8dbf]" />
                        <button type="button" onClick={() => setShowTenantDropdown(!showTenantDropdown)}
                          className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-gray-400 hover:text-gray-600">
                          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showTenantDropdown ? 'rotate-180' : ''}`} />
                        </button>

                        {showTenantDropdown && (
                          <div className="absolute z-20 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
                            <button
                              type="button"
                              onClick={() => {
                                setFormData(prev => ({ 
                                  ...prev, 
                                  tenantId: '',
                                  tenantName: 'All Tenants'
                                }));
                                setTenantSearchQuery('All Tenants');
                                setShowTenantDropdown(false);
                              }}
                              className="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center justify-between border-b border-gray-200"
                            >
                              <div>
                                <div className="font-medium text-blue-800">All Tenants</div>
                                <div className="text-xs text-oe-primary">Create template for all tenants</div>
                              </div>
                              {formData.tenantId === '' && formData.tenantName === 'All Tenants' && (
                                <span className="text-[#1f8dbf] font-medium">✓</span>
                              )}
                            </button>

                            {filteredTenants.length === 0 ? (
                              <div className="p-3 text-sm text-gray-500">
                                {tenantSearchQuery && tenantSearchQuery !== 'All Tenants' ? 'No tenants found matching your search' : 'No tenants available'}
                              </div>
                            ) : (
                              filteredTenants.map(tenant => (
                                <button
                                  key={tenant.TenantId}
                                  type="button"
                                  onClick={() => selectTenant(tenant)}
                                  className="w-full text-left px-3 py-2 hover:bg-gray-100 flex items-center justify-between border-b border-gray-100 last:border-b-0"
                                >
                                  <div>
                                    <div className="font-medium text-gray-900">{tenant.Name}</div>
                                    <div className="text-xs text-gray-500">ID: {tenant.TenantId.slice(-8)}</div>
                                  </div>
                                  {tenant.TenantId === formData.tenantId && (
                                    <span className="text-[#1f8dbf] font-medium">✓</span>
                                  )}
                                </button>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Row 1: Name, Type, Category */}
                  <div className="flex-1 min-w-[200px]">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Template Name *</label>
                    <input type="text" value={formData.templateName} onChange={e => setFormData({ ...formData, templateName: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-[#1f8dbf]" placeholder="e.g., Welcome Email" />
                  </div>
                  <div className="w-24">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Type *</label>
                    <select value={formData.messageType} onChange={e => { const t = e.target.value as 'Email' | 'SMS'; setFormData({ ...formData, messageType: t, useAsWelcomeEmail: t === 'SMS' ? false : formData.useAsWelcomeEmail }); }}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-[#1f8dbf]">
                      <option value="Email">Email</option><option value="SMS">SMS</option>
                    </select>
                  </div>
                  <div className="w-36">
                    <label className="block text-xs font-medium text-gray-600 mb-1" title="Marketing templates respect member opt-out and include unsubscribe footer">
                      Class
                    </label>
                    <select
                      value={formData.messageCategory}
                      onChange={e => setFormData({ ...formData, messageCategory: e.target.value as 'Marketing' | 'System' })}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-[#1f8dbf]"
                    >
                      <option value="Marketing">Marketing</option>
                      <option value="System">System</option>
                    </select>
                  </div>
                  <div className="flex-1 min-w-[150px]">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                    <input type="text" value={formData.category} onChange={e => setFormData({ ...formData, category: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-[#1f8dbf]" placeholder="e.g., Welcome, Reminder" />
                  </div>
                  <div className="flex items-end gap-3 pb-0.5">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={formData.isActive} onChange={e => setFormData({ ...formData, isActive: e.target.checked })} className="w-3.5 h-3.5 text-[#1f8dbf] rounded" />
                      <span className="text-xs text-gray-600">Active</span>
                    </label>
                    {formData.messageType === 'Email' && canManageWelcomeEmail && (
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={formData.useAsWelcomeEmail} onChange={e => setFormData({ ...formData, useAsWelcomeEmail: e.target.checked })} className="w-3.5 h-3.5 text-[#1f8dbf] rounded" />
                        <span className="text-xs text-gray-600">Welcome email</span>
                      </label>
                    )}
                  </div>
                </div>

                {/* Row 2: Subject, Reply-To (Email only) */}
                {formData.messageType === 'Email' && (
                  <div className="flex gap-3 mt-2">
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-gray-600 mb-1">Subject</label>
                      <input ref={subjectInputRef} type="text" value={formData.subject} onChange={e => setFormData({ ...formData, subject: e.target.value })}
                        onFocus={() => { focusedFieldRef.current = 'subject'; }}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-[#1f8dbf]" placeholder="e.g., Welcome to {[tenant.Name]}" />
                    </div>
                    <div className="w-64">
                      <label className="block text-xs font-medium text-gray-600 mb-1">Reply-To</label>
                      <input ref={replyToInputRef} type="text" value={formData.replyTo} onChange={e => setFormData({ ...formData, replyTo: e.target.value })}
                        onFocus={() => { focusedFieldRef.current = 'replyTo'; }}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-[#1f8dbf]" placeholder="{[agent.Email]}" />
                    </div>
                  </div>
                )}

                {/* Variables — grouped by section */}
                <div className="mt-2 flex flex-wrap items-start gap-3">
                  {availableVariables.map(group => (
                    <div key={group.group} className="flex items-center gap-1 flex-wrap">
                      <span className="text-xs font-medium text-gray-500">{group.group}:</span>
                      {group.variables.map(v => (
                        <button key={v} type="button" onClick={() => insertVariable(v)}
                          className="text-xs px-1.5 py-0.5 bg-gray-100 hover:bg-blue-50 hover:text-oe-primary rounded border border-gray-200 transition-colors">
                          {v.split('.')[1] || v}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              {/* Email: Inline editor canvas */}
              {formData.messageType === 'Email' ? (
                <div className="flex-1 min-h-0 overflow-hidden">
                  <EmailEditor
                    initialHtml={formData.body}
                    initialDesign={formData.designJson}
                    onSave={(html, designJson) => {
                      setFormData(prev => ({ ...prev, body: html, designJson }));
                    }}
                    onCancel={() => {
                      setIsCreateModalOpen(false);
                      setIsEditModalOpen(false);
                      resetForm();
                    }}
                    variables={availableVariables.map(g => ({
                      group: g.group,
                      variables: g.variables.map(v => ({ name: v, label: v.split('.')[1] || v }))
                    }))}
                    inline
                  />
                </div>
              ) : (
                /* SMS: Keep existing layout */
                <div className="flex flex-1 min-h-0">
                  <div className="flex-1 p-6 overflow-y-auto">
                    <RichTextEditor
                      ref={bodyEditorRef}
                      value={formData.body}
                      onChange={(value) => setFormData((prev) => ({ ...prev, body: value }))}
                      placeholder="Enter your SMS content."
                      minHeight={280}
                    />
                  </div>
                  <div className="w-64 bg-gray-50 p-4 border-l border-gray-200 overflow-y-auto">
                    <h3 className="font-medium text-gray-900 mb-3 text-sm">Variables</h3>
                    <div className="space-y-3">
                      {availableVariables.map(group => (
                        <div key={group.group}>
                          <h4 className="text-xs font-medium text-gray-600 mb-1">{group.group}</h4>
                          <div className="space-y-0.5">
                            {group.variables.map(variable => (
                              <button key={variable} onClick={() => insertVariable(variable)}
                                className="w-full text-left px-2 py-1 text-xs text-gray-600 hover:bg-white hover:text-gray-900 rounded transition-colors">
                                {`{[${variable}]}`}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end space-x-3">
              <button
                onClick={() => {
                  setIsCreateModalOpen(false);
                  setIsEditModalOpen(false);
                  resetForm();
                }}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                disabled={isLoading}
              >
                Cancel
              </button>
              <button
                onClick={isCreateModalOpen ? handleCreate : handleUpdate}
                className="px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#175a7a] disabled:opacity-50"
                disabled={isLoading}
              >
                {isLoading ? 'Saving...' : (isCreateModalOpen ? 'Create Template' : 'Save Changes')}
              </button>
            </div>
          </div>
        </div>
      )}

      {isPreviewModalOpen && selectedTemplate && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center shrink-0">
              <h2 className="text-xl font-semibold text-gray-900">Template Preview</h2>
              <button
                onClick={() => setIsPreviewModalOpen(false)}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              <div className="p-6 space-y-6">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-sm font-medium rounded-full ${
                    selectedTemplate.messageType === 'Email' ? 'bg-blue-50 text-blue-700' : 'bg-green-50 text-green-700'
                  }`}>
                    {selectedTemplate.messageType === 'Email' ? (
                      <Mail className="h-4 w-4" />
                    ) : (
                      <MessageSquare className="h-4 w-4" />
                    )}
                    {selectedTemplate.messageType}
                  </span>
                  <span className={`inline-flex px-2.5 py-1 text-sm font-medium rounded-full ${
                    selectedTemplate.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'
                  }`}>
                    {selectedTemplate.isActive ? 'Active' : 'Inactive'}
                  </span>
                  {isSysAdmin && selectedTemplate.tenantName && (
                    <span className="inline-flex items-center gap-1 text-sm text-gray-600">
                      <Building2 className="h-4 w-4 text-gray-400" />
                      {selectedTemplate.tenantName}
                    </span>
                  )}
                </div>

                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">{selectedTemplate.templateName}</h3>
                  {selectedTemplate.category && (
                    <p className="text-sm text-gray-500">{selectedTemplate.category}</p>
                  )}
                </div>

                {selectedTemplate.subject && (
                  <div className="bg-gray-50 rounded-lg px-4 py-3 border border-gray-200">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Subject</p>
                    <p className="text-gray-900 font-medium">{selectedTemplate.subject}</p>
                  </div>
                )}
                {selectedTemplate.messageType === 'Email' && selectedTemplate.replyTo && (
                  <div className="bg-gray-50 rounded-lg px-4 py-3 border border-gray-200">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Reply-To</p>
                    <p className="text-gray-900 font-medium">{selectedTemplate.replyTo}</p>
                  </div>
                )}

                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="bg-gray-100 px-4 py-2 border-b border-gray-200">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Message body</p>
                  </div>
                  <div
                    className="bg-white p-6 min-h-[200px] max-h-[50vh] overflow-y-auto text-gray-700 prose prose-sm max-w-none prose-headings:text-gray-900 prose-a:text-[#1f8dbf] prose-a:no-underline hover:prose-a:underline prose-ul:pl-5 prose-ol:pl-5 prose-li:my-0.5 [&_img]:max-w-full [&_img]:h-auto"
                    dangerouslySetInnerHTML={{ __html: withMarketingFooterPreview(selectedTemplate.body || '<p class="text-gray-400 italic">No content</p>', selectedTemplate.messageCategory) }}
                  />
                </div>
                {selectedTemplate.messageCategory === 'Marketing' && (
                  <p className="text-xs text-gray-500 -mt-2">
                    This is a Marketing template — recipients automatically get an unsubscribe footer, and members who opted out are skipped.
                  </p>
                )}

                <div className="pt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
                  <span>Created {new Date(selectedTemplate.createdDate).toLocaleString()}</span>
                  {selectedTemplate.modifiedDate && (
                    <span>Modified {new Date(selectedTemplate.modifiedDate).toLocaleString()}</span>
                  )}
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end shrink-0">
              <button
                onClick={() => setIsPreviewModalOpen(false)}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Quick Send Modal */}
      {quickSendTemplate && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={() => setQuickSendTemplate(null)}>
          <div className="bg-white rounded-lg max-w-2xl w-full h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center flex-shrink-0">
              <div>
                <h2 className="text-lg font-semibold">Quick Send</h2>
                <p className="text-sm text-gray-500">{quickSendTemplate.templateName}{quickSendTemplate.subject ? ` — ${quickSendTemplate.subject}` : ''}</p>
              </div>
              <button onClick={() => setQuickSendTemplate(null)} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="p-6 space-y-4">
                <div className="border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
                  <iframe
                    srcDoc={withMarketingFooterPreview(quickSendTemplate.body.replace(/\n?<!-- DESIGN_JSON:.*? -->/s, ''), quickSendTemplate.messageCategory)}
                    className="w-full border-0"
                    style={{ height: 400 }}
                    title="Template preview"
                  />
                </div>
                {quickSendTemplate.messageCategory === 'Marketing' && (
                  <p className="text-xs text-gray-500 flex items-start gap-1">
                    <span className="text-oe-primary">●</span>
                    Marketing template: an unsubscribe footer is added automatically, and any recipient who has unsubscribed from marketing email will be skipped.
                  </p>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Send to email address(es)</label>
                  <textarea
                    value={quickSendEmail}
                    onChange={e => setQuickSendEmail(e.target.value)}
                    placeholder="recipient@example.com, another@example.com"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary text-sm"
                    rows={2}
                    autoFocus
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Separate multiple emails with commas. Variables like {'{[tenant.Name]}'} will be substituted per recipient.
                    {quickSendEmail.includes(',') && (
                      <span className="text-oe-primary ml-1">
                        ({quickSendEmail.split(/[,;\n]+/).filter(e => e.trim().includes('@')).length} recipients)
                      </span>
                    )}
                  </p>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 flex-shrink-0">
              <button onClick={() => setQuickSendTemplate(null)} className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button
                onClick={handleQuickSend}
                disabled={!quickSendEmail.trim() || !quickSendEmail.includes('@') || quickSendSending}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary/90 disabled:opacity-50 inline-flex items-center gap-2"
              >
                <Send className="h-4 w-4" />
                {quickSendSending ? 'Sending...' : 'Send Email'}
              </button>
            </div>
          </div>
        </div>
      )}
      </>
    </div>
  );
};

export default MessageTemplatesPage;