import { Download, Edit, FileText, Plus, Replace, Search, Settings, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import MultiSelectTenants from '../../components/common/MultiSelectTenants';
import ProposalEditor from '../../components/proposal-editor/ProposalEditor';
import { useAuth } from '../../hooks/useAuth';
import { useTenants } from '../../hooks/useTenants';
import { apiService } from '../../services/api.service';
import ProposalService, { ProposalDocument } from '../../services/proposal.service';

const ProposalsPage: React.FC = () => {
  const { user } = useAuth();
  /** Active tenant (switched) — same as Members /api/me/tenant-admin which uses x-current-tenant-id from storage */
  const activeTenantId = user?.currentTenantId || user?.tenantId || undefined;
  // Fallback to localStorage if user.currentRole is not available
  const currentRole = user?.currentRole || localStorage.getItem('currentRole');
  const isSysAdmin = currentRole === 'SysAdmin';
  
  const { data: tenants = [], isLoading: tenantsLoading } = useTenants(isSysAdmin);
  
  // Proposal Templates state
  const [proposalDocuments, setProposalDocuments] = useState<ProposalDocument[]>([]);
  const [filteredProposals, setFilteredProposals] = useState<ProposalDocument[]>([]);
  const [proposalSearchTerm, setProposalSearchTerm] = useState('');
  const [proposalCategoryFilter, setProposalCategoryFilter] = useState<string>('');
  const [proposalLoading, setProposalLoading] = useState(false);
  const [showProposalEditor, setShowProposalEditor] = useState(false);
  const [editingProposal, setEditingProposal] = useState<ProposalDocument | null>(null);
  const [showProposalCreateForm, setShowProposalCreateForm] = useState(false);
  const [showProposalEditForm, setShowProposalEditForm] = useState(false);
  const [editingProposalMetadata, setEditingProposalMetadata] = useState<ProposalDocument | null>(null);
  const [proposalUploading, setProposalUploading] = useState(false);
  const [proposalUpdating, setProposalUpdating] = useState(false);
  const [proposalDownloadingId, setProposalDownloadingId] = useState<string | null>(null);
  const [selectedTenantIds, setSelectedTenantIds] = useState<string[]>([]);
  
  // Proposal create form state
  const [newProposalName, setNewProposalName] = useState('');
  const [newProposalDescription, setNewProposalDescription] = useState('');
  const [newProposalCategory, setNewProposalCategory] = useState('');
  const [newProposalFile, setNewProposalFile] = useState<File | null>(null);
  const [copyFromTemplateId, setCopyFromTemplateId] = useState<string>('');
  const [fieldsToCopy, setFieldsToCopy] = useState<any[]>([]);
  
  // Proposal edit form state
  const [editProposalName, setEditProposalName] = useState('');
  const [editProposalDescription, setEditProposalDescription] = useState('');
  const [editProposalCategory, setEditProposalCategory] = useState<'General' | 'Business' | 'Employee'>('General');
  const [editProposalTenantIds, setEditProposalTenantIds] = useState<string[]>([]);
  const [editProposalMarkInactive, setEditProposalMarkInactive] = useState(false);
  const [editProposalReplacementFile, setEditProposalReplacementFile] = useState<File | null>(null);

  useEffect(() => {
    if (activeTenantId) {
      setSelectedTenantIds([activeTenantId]);
    }
  }, [isSysAdmin, activeTenantId]);

  // Load proposal documents
  const loadProposalDocuments = useCallback(async () => {
    if (!activeTenantId && !isSysAdmin) {
      return;
    }
    
    setProposalLoading(true);
    try {
      let tenantIds: string[] | undefined;
      if (isSysAdmin) {
        tenantIds = selectedTenantIds.length > 0 ? selectedTenantIds : activeTenantId ? [activeTenantId] : undefined;
      } else {
        tenantIds = activeTenantId ? [activeTenantId] : undefined;
      }
      
      const response = await ProposalService.getProposalDocuments({
        tenantIds: tenantIds,
        category: proposalCategoryFilter || undefined,
        search: proposalSearchTerm || undefined,
        includeInactive: true // Admin list: show active and inactive so they can edit/toggle
      });
      
      if (response.success && response.data) {
        setProposalDocuments(response.data);
        setFilteredProposals(response.data);
      } else {
        setProposalDocuments([]);
        setFilteredProposals([]);
      }
    } catch (err) {
      console.error('Failed to load proposal documents:', err);
      setProposalDocuments([]);
      setFilteredProposals([]);
    } finally {
      setProposalLoading(false);
    }
  }, [selectedTenantIds, proposalCategoryFilter, proposalSearchTerm, isSysAdmin, activeTenantId]);
  
  useEffect(() => {
    if (activeTenantId || isSysAdmin) {
      loadProposalDocuments();
    }
  }, [loadProposalDocuments, activeTenantId, isSysAdmin]);
  
  // Filter proposals by search term
  useEffect(() => {
    let filtered = proposalDocuments;
    
    if (proposalSearchTerm) {
      filtered = filtered.filter(doc =>
        (doc.name || '').toLowerCase().includes(proposalSearchTerm.toLowerCase()) ||
        (doc.description || '').toLowerCase().includes(proposalSearchTerm.toLowerCase()) ||
        (doc.category || '').toLowerCase().includes(proposalSearchTerm.toLowerCase())
      );
    }
    
    if (proposalCategoryFilter) {
      filtered = filtered.filter(doc => doc.category === proposalCategoryFilter);
    }
    
    setFilteredProposals(filtered);
  }, [proposalDocuments, proposalSearchTerm, proposalCategoryFilter]);

  // Proposal document handlers
  const handleCreateProposal = async () => {
    if (!newProposalName.trim() || !newProposalFile) {
      alert('Name and document file are required');
      return;
    }

    try {
      setProposalUploading(true);

      // Upload document file
      const formData = new FormData();
      formData.append('file', newProposalFile);
      formData.append('type', 'documents');
      formData.append('category', 'proposal');
      
      const uploadResponse: any = await apiService.post('/api/uploads', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      if (!uploadResponse.success) {
        throw new Error('Failed to upload document');
      }

      const fileId = uploadResponse.fileId || uploadResponse.data?.[0]?.fileId || uploadResponse.data?.fileId;
      const documentUrl = uploadResponse.url || uploadResponse.data?.[0]?.url || uploadResponse.data?.url;
      const fileName = uploadResponse.filename || uploadResponse.data?.[0]?.filename || uploadResponse.data?.[0]?.fileName || newProposalFile.name;
      const fileSize = uploadResponse.data?.[0]?.fileSize || newProposalFile.size;
      
      if (!fileId) {
        throw new Error('Document ID not returned from upload');
      }
      
      if (!documentUrl) {
        throw new Error('Document URL not returned from upload');
      }

      // Create proposal document
      const tenantIds = isSysAdmin && selectedTenantIds.length > 0 ? selectedTenantIds : (activeTenantId ? [activeTenantId] : []);
      
      // If copying from a template, generate new IDs for all fields
      let fieldsToCreate = undefined;
      if (fieldsToCopy.length > 0) {
        fieldsToCreate = fieldsToCopy.map(field => ({
          ...field,
          fieldId: uuidv4().toUpperCase(), // Generate new unique ID
          // Remove any database-specific fields that shouldn't be copied
          proposalDocumentId: undefined,
          ProposalDocumentId: undefined,
          createdDate: undefined,
          modifiedDate: undefined
        }));
      }
      
      const createData = {
        name: newProposalName,
        description: newProposalDescription || undefined,
        category: newProposalCategory || 'General',
        documentId: fileId,
        documentUrl: documentUrl,
        fileName: fileName,
        fileSize: fileSize,
        tenantIds: tenantIds.length > 0 ? tenantIds : undefined,
        isActive: true,
        fields: fieldsToCreate
      };

      const response = await ProposalService.createProposalDocument(createData);

      if (response.success && response.data) {
        await loadProposalDocuments();
        setShowProposalCreateForm(false);
        setNewProposalName('');
        setNewProposalDescription('');
        setNewProposalCategory('');
        setNewProposalFile(null);
        setCopyFromTemplateId('');
        setFieldsToCopy([]);
      } else {
        throw new Error('Failed to create proposal document');
      }
    } catch (err: any) {
      console.error('Error creating proposal document:', err);
      alert(err.message || 'Failed to create proposal document');
    } finally {
      setProposalUploading(false);
    }
  };

  const handleEditProposal = (doc: ProposalDocument) => {
    setEditingProposal(doc);
    setShowProposalEditor(true);
  };

  const handleEditProposalMetadata = (doc: ProposalDocument) => {
    setEditingProposalMetadata(doc);
    setEditProposalName(doc.name || '');
    setEditProposalDescription(doc.description || '');
    setEditProposalCategory((doc.category === 'Business' || doc.category === 'Employee') ? doc.category : 'General');
    setEditProposalTenantIds(doc.tenantIds || []);
    setEditProposalMarkInactive(doc.isActive === false);
    setEditProposalReplacementFile(null);
    setShowProposalEditForm(true);
  };

  const handleUpdateProposalMetadata = async () => {
    if (!editingProposalMetadata || !editProposalName.trim()) {
      alert('Name is required');
      return;
    }

    try {
      setProposalUpdating(true);

      let documentId = editingProposalMetadata.documentId;
      let documentUrl: string | undefined = editingProposalMetadata.documentUrl;
      let fileName: string | undefined = editingProposalMetadata.fileName;
      let fileSize: number | undefined = editingProposalMetadata.fileSize;

      if (editProposalReplacementFile) {
        const formData = new FormData();
        formData.append('file', editProposalReplacementFile);
        formData.append('type', 'documents');
        formData.append('category', 'proposal');
        const uploadResponse: any = await apiService.post('/api/uploads', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        if (!uploadResponse.success) {
          throw new Error('Failed to upload replacement document');
        }
        documentId = uploadResponse.fileId || uploadResponse.data?.[0]?.fileId || uploadResponse.data?.fileId;
        documentUrl = uploadResponse.url || uploadResponse.data?.[0]?.url || uploadResponse.data?.url;
        fileName = (uploadResponse.filename || uploadResponse.data?.[0]?.filename) ?? editProposalReplacementFile.name;
        fileSize = uploadResponse.data?.[0]?.fileSize ?? editProposalReplacementFile.size;
        if (!documentId || !documentUrl) {
          throw new Error('Document ID or URL not returned from upload');
        }
      }

      const updateData: any = {
        proposalDocumentId: editingProposalMetadata.proposalDocumentId,
        name: editProposalName.trim(),
        description: editProposalDescription.trim() || null,
        category: editProposalCategory,
        tenantIds: isSysAdmin && editProposalTenantIds.length > 0 ? editProposalTenantIds : (activeTenantId ? [activeTenantId] : null),
        documentId,
        isActive: !editProposalMarkInactive,
        createdDate: editingProposalMetadata.createdDate,
        modifiedDate: new Date().toISOString(),
      };
      if (editProposalReplacementFile && documentUrl && fileName !== undefined) {
        updateData.documentUrl = documentUrl;
        updateData.fileName = fileName;
        updateData.fileSize = fileSize ?? 0;
      }

      const response = await ProposalService.updateProposalDocument(updateData);

      if (response.success) {
        await loadProposalDocuments();
        setShowProposalEditForm(false);
        setEditingProposalMetadata(null);
        setEditProposalName('');
        setEditProposalDescription('');
        setEditProposalCategory('General');
        setEditProposalTenantIds([]);
        setEditProposalMarkInactive(false);
        setEditProposalReplacementFile(null);
      } else {
        throw new Error('Failed to update proposal document');
      }
    } catch (err: any) {
      console.error('Error updating proposal document:', err);
      alert(err.message || 'Failed to update proposal document');
    } finally {
      setProposalUpdating(false);
    }
  };

  const handleDownloadProposal = async (doc: ProposalDocument) => {
    if (!doc.documentId) {
      alert('This proposal has no document file to download.');
      return;
    }

    const downloadName = (() => {
      if (doc.fileName?.trim()) return doc.fileName.trim();
      const base = (doc.name || 'proposal').replace(/[^\w\s.-]/g, '').trim() || 'proposal';
      return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
    })();

    setProposalDownloadingId(doc.proposalDocumentId);
    try {
      const blob = await apiService.get<Blob>(
        `/api/proposal-documents/documents/${doc.documentId}/proxy`,
        { responseType: 'blob' }
      );
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = downloadName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch (err: any) {
      console.error('Failed to download proposal document:', err);
      alert(err?.message || 'Failed to download proposal document');
    } finally {
      setProposalDownloadingId(null);
    }
  };

  const handleDeleteProposal = async (proposalDocumentId: string) => {
    if (!window.confirm('Are you sure you want to delete this proposal template?')) return;

    setProposalLoading(true);
    try {
      const response = await ProposalService.deleteProposalDocument(proposalDocumentId);
      if (response.success) {
        await loadProposalDocuments();
      } else {
        alert('Failed to delete proposal template');
      }
    } catch (err) {
      console.error('Failed to delete proposal template:', err);
      alert('Failed to delete proposal template');
    } finally {
      setProposalLoading(false);
    }
  };

  const handleProposalEditorClose = () => {
    setShowProposalEditor(false);
    setEditingProposal(null);
  };

  const handleProposalEditorSave = async () => {
    await loadProposalDocuments();
    setShowProposalEditor(false);
    setEditingProposal(null);
  };

  // Get unique categories from proposals
  const proposalCategories = Array.from(new Set(proposalDocuments.map(doc => doc.category).filter(Boolean)));

  // Safety check: don't render if user is not loaded
  if (!user) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#1f8dbf]"></div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Proposals</h1>
            <p className="text-sm text-gray-500 mt-1">Create and manage proposal templates</p>
          </div>
        </div>
      </div>

      <div className="mb-6 flex justify-between items-center">
        <div></div>
        <button
          onClick={() => {
            setNewProposalName('');
            setNewProposalDescription('');
            setNewProposalCategory('');
            setNewProposalFile(null);
            setCopyFromTemplateId('');
            setFieldsToCopy([]);
            setShowProposalCreateForm(true);
          }}
          className="flex items-center space-x-2 px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#175a7a]"
        >
          <Plus className="h-5 w-5" />
          <span>Create Proposal Template</span>
        </button>
      </div>

      {!showProposalCreateForm ? (
        <>
          <div className="mb-6 bg-white p-4 rounded-lg shadow-sm border border-gray-200">
            <div className="flex flex-wrap gap-4">
              <div className="flex-1 min-w-[200px]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <input
                    type="text"
                    value={proposalSearchTerm}
                    onChange={(e) => setProposalSearchTerm(e.target.value)}
                    placeholder="Search proposals..."
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                  />
                </div>
              </div>
              
              {isSysAdmin && (
                <div className="min-w-[240px]">
                  <MultiSelectTenants
                    tenants={tenants}
                    selectedTenantIds={selectedTenantIds}
                    onChange={(ids) => setSelectedTenantIds(ids)}
                    placeholder="Filter by tenant(s)..."
                    className="w-full"
                  />
                </div>
              )}
              
              <select
                value={proposalCategoryFilter}
                onChange={(e) => setProposalCategoryFilter(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf]"
              >
                <option value="">All Categories</option>
                {proposalCategories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>

              <button
                onClick={loadProposalDocuments}
                disabled={proposalLoading}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
          </div>

          {proposalLoading && filteredProposals.length === 0 ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#1f8dbf]"></div>
            </div>
          ) : filteredProposals.length === 0 ? (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
              <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No proposal templates found</h3>
              <p className="text-gray-500 mb-4">
                {proposalSearchTerm || proposalCategoryFilter
                  ? 'Try adjusting your filters'
                  : 'Get started by creating your first proposal template'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredProposals.map((doc) => (
                <div key={doc.proposalDocumentId} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow">
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex items-center space-x-2">
                      <FileText className="h-4 w-4 text-[#1f8dbf]" />
                      {doc.category && (
                        <span className="text-xs px-2 py-1 bg-gray-100 text-gray-700 rounded-full">
                          {doc.category}
                        </span>
                      )}
                    </div>
                    <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                      doc.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                    }`}>
                      {doc.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  
                  <h3 className="font-medium text-gray-900 mb-2">{doc.name || 'Untitled Document'}</h3>
                  
                  {doc.description && (
                    <p className="text-sm text-gray-600 line-clamp-2 mb-4">
                      {doc.description}
                    </p>
                  )}
                  
                  <div className="flex items-center text-xs text-gray-500 mb-4">
                    {doc.createdDate && !isNaN(new Date(doc.createdDate).getTime()) && (
                      <span>Created: {new Date(doc.createdDate).toLocaleDateString()}</span>
                    )}
                  </div>
                  
                  <div className="flex space-x-2">
                    <button
                      onClick={() => handleDownloadProposal(doc)}
                      disabled={!doc.documentId || proposalDownloadingId === doc.proposalDocumentId}
                      className="flex-1 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Download document"
                    >
                      <Download className="h-4 w-4 mx-auto" />
                    </button>
                    <button
                      onClick={() => handleEditProposalMetadata(doc)}
                      className="flex-1 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
                      title="Edit Details"
                    >
                      <Settings className="h-4 w-4 mx-auto" />
                    </button>
                    <button
                      onClick={() => handleEditProposal(doc)}
                      className="flex-1 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
                      title="Edit PDF"
                    >
                      <Edit className="h-4 w-4 mx-auto" />
                    </button>
                    <button
                      onClick={() => handleDeleteProposal(doc.proposalDocumentId)}
                      className="flex-1 px-3 py-1.5 text-sm text-red-600 hover:text-red-900 hover:bg-red-100 rounded transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4 mx-auto" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-medium text-gray-900">Create New Proposal Template</h3>
            <button
              onClick={() => {
                setShowProposalCreateForm(false);
                setNewProposalName('');
                setNewProposalDescription('');
                setNewProposalCategory('');
                setNewProposalFile(null);
                setCopyFromTemplateId('');
                setFieldsToCopy([]);
                if (isSysAdmin) {
                  setSelectedTenantIds([]);
                }
              }}
              className="text-gray-600 hover:text-gray-800"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="space-y-4">
            {isSysAdmin && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Tenant(s)
                </label>
                <MultiSelectTenants
                  tenants={tenants}
                  selectedTenantIds={selectedTenantIds}
                  onChange={(ids) => setSelectedTenantIds(ids)}
                  placeholder="Select tenant(s)..."
                  className="w-full"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Copy Fields From (Optional)
              </label>
              <select
                value={copyFromTemplateId}
                onChange={async (e) => {
                  const templateId = e.target.value;
                  setCopyFromTemplateId(templateId);
                  
                  if (templateId) {
                    // Load fields from the selected template
                    try {
                      const response = await ProposalService.getProposalDocument(templateId);
                      if (response.success && response.data && response.data.fields) {
                        setFieldsToCopy(response.data.fields);
                      } else {
                        setFieldsToCopy([]);
                      }
                    } catch (err) {
                      console.error('Error loading template fields:', err);
                      setFieldsToCopy([]);
                    }
                  } else {
                    setFieldsToCopy([]);
                  }
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf]"
              >
                <option value="">None - Start from scratch</option>
                {proposalDocuments
                  .filter(doc => doc.proposalDocumentId !== copyFromTemplateId) // Don't show the current template if editing
                  .map(doc => (
                    <option key={doc.proposalDocumentId} value={doc.proposalDocumentId}>
                      {doc.name}
                    </option>
                  ))}
              </select>
              {copyFromTemplateId && fieldsToCopy.length > 0 && (
                <p className="mt-1 text-xs text-gray-500">
                  Will copy {fieldsToCopy.length} field{fieldsToCopy.length !== 1 ? 's' : ''} from the selected template
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Template Name *
              </label>
              <input
                type="text"
                value={newProposalName}
                onChange={(e) => setNewProposalName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf]"
                placeholder="Enter template name"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description (Optional)
              </label>
              <textarea
                value={newProposalDescription}
                onChange={(e) => setNewProposalDescription(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf]"
                placeholder="Enter description"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category
              </label>
              <select
                value={newProposalCategory || 'General'}
                onChange={(e) => setNewProposalCategory(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf]"
              >
                <option value="General">General</option>
                <option value="Business">Business</option>
                <option value="Employee">Employee</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                <strong>General</strong> shows in the Send Proposal flow for individuals.
                <strong> Business</strong> shows in the Business Proposal modal.
                <strong> Employee</strong> is distributed to employees and auto-populates from group data.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                PDF Document *
              </label>
              <div className="mt-1 flex items-center gap-4">
                <label className="cursor-pointer inline-flex items-center px-4 py-2 bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200">
                  <Plus className="h-4 w-4 mr-2" />
                  Choose File
                  <input
                    type="file"
                    accept=".pdf"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setNewProposalFile(file);
                      }
                    }}
                    className="hidden"
                  />
                </label>
                {newProposalFile && (
                  <span className="text-sm text-gray-600">{newProposalFile.name}</span>
                )}
              </div>
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <button
                onClick={() => {
                  setShowProposalCreateForm(false);
                  setNewProposalName('');
                  setNewProposalDescription('');
                  setNewProposalCategory('');
                  setNewProposalFile(null);
                  if (isSysAdmin) {
                    setSelectedTenantIds([]);
                  }
                }}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                disabled={proposalUploading}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProposal}
                className="px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#175a7a] disabled:opacity-50"
                disabled={proposalUploading || !newProposalName.trim() || !newProposalFile}
              >
                {proposalUploading ? 'Creating...' : 'Create Template'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Proposal Metadata Modal */}
      {showProposalEditForm && editingProposalMetadata && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h3 className="text-lg font-medium text-gray-900">Edit Proposal Details</h3>
              <button
                onClick={() => {
                  setShowProposalEditForm(false);
                  setEditingProposalMetadata(null);
                  setEditProposalName('');
                  setEditProposalDescription('');
                  setEditProposalCategory('General');
                  setEditProposalTenantIds([]);
                  setEditProposalMarkInactive(false);
                  setEditProposalReplacementFile(null);
                }}
                className="text-gray-600 hover:text-gray-800"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {isSysAdmin && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Tenant(s)
                  </label>
                  <MultiSelectTenants
                    tenants={tenants}
                    selectedTenantIds={editProposalTenantIds}
                    onChange={(ids) => setEditProposalTenantIds(ids)}
                    placeholder="Select tenant(s)..."
                    className="w-full"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Template Name *
                </label>
                <input
                  type="text"
                  value={editProposalName}
                  onChange={(e) => setEditProposalName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf]"
                  placeholder="Enter template name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description (Optional)
                </label>
                <textarea
                  value={editProposalDescription}
                  onChange={(e) => setEditProposalDescription(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf]"
                  placeholder="Enter description"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category
                </label>
                <select
                  value={editProposalCategory}
                  onChange={(e) => setEditProposalCategory(e.target.value as 'General' | 'Business' | 'Employee')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf]"
                >
                  <option value="General">General</option>
                  <option value="Business">Business</option>
                  <option value="Employee">Employee</option>
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  <strong>General</strong> shows in the Send Proposal flow.
                  <strong> Business</strong> shows in the Business Proposal modal.
                  <strong> Employee</strong> shows on the group Members tab for one-click employee-facing PDF generation.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  PDF Document
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm text-gray-600">
                    Current: {editingProposalMetadata.fileName || 'PDF attached'}
                  </span>
                  <label className="cursor-pointer inline-flex items-center px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700">
                    <Replace className="h-4 w-4 mr-2" />
                    Replace document
                    <input
                      type="file"
                      accept=".pdf"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        setEditProposalReplacementFile(file || null);
                      }}
                      className="hidden"
                    />
                  </label>
                  {editProposalReplacementFile && (
                    <span className="text-sm text-green-600">
                      New: {editProposalReplacementFile.name}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="edit-proposal-mark-inactive"
                  checked={editProposalMarkInactive}
                  onChange={(e) => setEditProposalMarkInactive(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-[#1f8dbf] focus:ring-[#1f8dbf]"
                />
                <label htmlFor="edit-proposal-mark-inactive" className="ml-2 block text-sm text-gray-700">
                  Mark as inactive (not available for public use)
                </label>
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  onClick={() => {
                    setShowProposalEditForm(false);
                    setEditingProposalMetadata(null);
                    setEditProposalName('');
                    setEditProposalDescription('');
                    setEditProposalTenantIds([]);
                    setEditProposalMarkInactive(false);
                    setEditProposalReplacementFile(null);
                  }}
                  className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                  disabled={proposalUpdating}
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpdateProposalMetadata}
                  className="px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#175a7a] disabled:opacity-50"
                  disabled={proposalUpdating || !editProposalName.trim()}
                >
                  {proposalUpdating ? 'Updating...' : 'Update Details'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showProposalEditor && editingProposal && editingProposal.documentId && (
        <ProposalEditor
          proposalDocumentId={editingProposal.proposalDocumentId}
          documentId={editingProposal.documentId}
          documentUrl={editingProposal.documentUrl || ''}
          category={editingProposal.category}
          onClose={handleProposalEditorClose}
          onSave={handleProposalEditorSave}
        />
      )}
    </div>
  );
};

export default ProposalsPage;

