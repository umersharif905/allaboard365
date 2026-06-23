// frontend/src/components/proposals/ProposalDocumentsManagementModal.tsx
// Modal for managing proposal documents for a product

import { Edit, FileText, Plus, Trash2, Upload, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';
import ProposalService, { ProposalDocument } from '../../services/proposal.service';
import ProposalEditor from '../proposal-editor/ProposalEditor';

interface ProposalDocumentsManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  // productId and bundleProductId removed - proposals are no longer product-specific
}

const ProposalDocumentsManagementModal: React.FC<ProposalDocumentsManagementModalProps> = ({
  isOpen,
  onClose
}) => {
  const [proposalDocuments, setProposalDocuments] = useState<ProposalDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [editingDocument, setEditingDocument] = useState<ProposalDocument | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [uploading, setUploading] = useState(false);
  
  // Create form state
  const [newDocumentName, setNewDocumentName] = useState('');
  const [newDocumentDescription, setNewDocumentDescription] = useState('');
  const [newDocumentCategory, setNewDocumentCategory] = useState<'General' | 'Business' | 'Employee'>('General');
  const [newDocumentFile, setNewDocumentFile] = useState<File | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadProposalDocuments();
    } else {
      // Reset state when modal closes
      setProposalDocuments([]);
      setError(null);
      setShowEditor(false);
      setEditingDocument(null);
      setShowCreateForm(false);
      setNewDocumentName('');
      setNewDocumentDescription('');
      setNewDocumentCategory('General');
      setNewDocumentFile(null);
    }
  }, [isOpen]);

  const loadProposalDocuments = async () => {
    try {
      setLoading(true);
      setError(null);
      
      console.log('📋 Loading proposal documents...');
      
      // Load all proposal documents for the tenant (not filtered by product)
      const response = await ProposalService.getProposalDocuments();
      
      console.log('📋 Proposal documents response:', response);
      
      if (response.success && response.data) {
        console.log(`✅ Loaded ${response.data.length} proposal documents`);
        setProposalDocuments(response.data);
      } else {
        console.warn('⚠️ Response was not successful or data is missing:', response);
        setProposalDocuments([]);
      }
    } catch (err: any) {
      console.error('❌ Error loading proposal documents:', err);
      setError(err.message || 'Failed to load proposal documents');
      setProposalDocuments([]);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDocument = async () => {
    if (!newDocumentName.trim() || !newDocumentFile) {
      setError('Name and document file are required');
      return;
    }

    try {
      setUploading(true);
      setError(null);

      // Upload document file
      const formData = new FormData();
      formData.append('file', newDocumentFile);
      formData.append('type', 'documents');
      formData.append('category', 'proposal');
      
      const uploadResponse: any = await apiService.post('/api/uploads', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      if (!uploadResponse.success) {
        throw new Error('Failed to upload document');
      }

      const documentUrl = uploadResponse.url || (Array.isArray(uploadResponse.data) ? uploadResponse.data[0]?.url : uploadResponse.data?.url);
      const documentId = uploadResponse.fileId || uploadResponse.data?.fileId || uploadResponse.data?.[0]?.fileId;
      const fileName = uploadResponse.filename || uploadResponse.data?.[0]?.filename || newDocumentFile.name;
      const fileSize = newDocumentFile.size;

      if (!documentId) {
        throw new Error('Document ID not returned from upload');
      }

      if (!documentUrl) {
        throw new Error('Document URL not returned from upload');
      }

      // Create proposal document
      const createResponse = await ProposalService.createProposalDocument({
        name: newDocumentName.trim(),
        description: newDocumentDescription.trim() || undefined,
        category: newDocumentCategory,
        documentId,
        documentUrl,
        fileName,
        fileSize
        // tenantIds will default to user's tenant in the backend
      });

      if (createResponse.success && createResponse.data) {
        await loadProposalDocuments();
        setShowCreateForm(false);
        setNewDocumentName('');
        setNewDocumentDescription('');
        setNewDocumentFile(null);
        
        // Open editor for the new document - ensure documentUrl is set
        const documentToEdit = {
          ...createResponse.data,
          documentUrl: createResponse.data.documentUrl || documentUrl
        };
        setEditingDocument(documentToEdit);
        setShowEditor(true);
      } else {
        throw new Error(createResponse.message || 'Failed to create proposal document');
      }
    } catch (err: any) {
      console.error('Error creating proposal document:', err);
      setError(err.message || 'Failed to create proposal document');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteDocument = async (documentId: string) => {
    if (!confirm('Are you sure you want to delete this proposal document? This action cannot be undone.')) {
      return;
    }

    try {
      setError(null);
      const response = await ProposalService.deleteProposalDocument(documentId);
      
      if (response.success) {
        await loadProposalDocuments();
        if (editingDocument?.proposalDocumentId === documentId) {
          setShowEditor(false);
          setEditingDocument(null);
        }
      } else {
        throw new Error(response.message || 'Failed to delete proposal document');
      }
    } catch (err: any) {
      console.error('Error deleting proposal document:', err);
      setError(err.message || 'Failed to delete proposal document');
    }
  };

  const handleEditDocument = (document: ProposalDocument) => {
    setEditingDocument(document);
    setShowEditor(true);
  };

  const handleEditorClose = () => {
    setShowEditor(false);
    setEditingDocument(null);
    loadProposalDocuments(); // Refresh list
  };

  if (!isOpen) return null;

  if (showEditor && editingDocument) {
    return (
      <ProposalEditor
        proposalDocumentId={editingDocument.proposalDocumentId}
        documentId={editingDocument.documentId}
        documentUrl={editingDocument.documentUrl || ''}
        category={editingDocument.category}
        onClose={handleEditorClose}
        onSave={handleEditorClose}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-2xl font-semibold text-gray-900">Manage Proposal Documents</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-800">{error}</p>
            </div>
          )}

          {!showCreateForm ? (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-medium text-gray-900">Proposal Documents</h3>
                <button
                  onClick={() => setShowCreateForm(true)}
                  className="btn-primary inline-flex items-center"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add New Document
                </button>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
                </div>
              ) : proposalDocuments.length === 0 ? (
                <div className="text-center py-12 bg-gray-50 rounded-lg">
                  <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-gray-600">No proposal documents yet</p>
                  <p className="text-sm text-gray-500 mt-1">Click "Add New Document" to create one</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {proposalDocuments.map((doc) => (
                    <div
                      key={doc.proposalDocumentId || Math.random()}
                      className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h4 className="text-lg font-medium text-gray-900">
                            {doc.name || 'Untitled Document'}
                          </h4>
                          {doc.description && (
                            <p className="text-sm text-gray-600 mt-1">
                              {doc.description}
                            </p>
                          )}
                          <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                            {doc.createdDate && 
                             !isNaN(new Date(doc.createdDate).getTime()) ? (
                              <span>Created: {new Date(doc.createdDate).toLocaleDateString()}</span>
                            ) : (
                              <span>Created: Unknown</span>
                            )}
                            {doc.modifiedDate && 
                             !isNaN(new Date(doc.modifiedDate).getTime()) && (
                              <span>Modified: {new Date(doc.modifiedDate).toLocaleDateString()}</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 ml-4">
                          <button
                            onClick={() => handleEditDocument(doc)}
                            className="p-2 text-oe-primary hover:bg-oe-primary-light rounded-lg"
                            title="Edit document"
                          >
                            <Edit className="h-5 w-5" />
                          </button>
                          <button
                            onClick={() => handleDeleteDocument(doc.proposalDocumentId)}
                            className="p-2 text-oe-error hover:bg-red-50 rounded-lg"
                            title="Delete document"
                          >
                            <Trash2 className="h-5 w-5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-medium text-gray-900">Create New Proposal Document</h3>
                <button
                  onClick={() => {
                    setShowCreateForm(false);
                    setNewDocumentName('');
                    setNewDocumentDescription('');
                    setNewDocumentCategory('General');
                    setNewDocumentFile(null);
                    setError(null);
                  }}
                  className="text-gray-600 hover:text-gray-800"
                >
                  Cancel
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Document Name *
                  </label>
                  <input
                    type="text"
                    value={newDocumentName}
                    onChange={(e) => setNewDocumentName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="Enter document name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description (Optional)
                  </label>
                  <textarea
                    value={newDocumentDescription}
                    onChange={(e) => setNewDocumentDescription(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="Enter document description"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <select
                    value={newDocumentCategory}
                    onChange={(e) => setNewDocumentCategory(e.target.value as 'General' | 'Business' | 'Employee')}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-oe-primary focus:ring-oe-primary"
                  >
                    <option value="General">General</option>
                    <option value="Business">Business</option>
                    <option value="Employee">Employee</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    PDF Document *
                  </label>
                  <div className="mt-1 flex items-center gap-4">
                    <label className="cursor-pointer inline-flex items-center px-4 py-2 bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200">
                      <Upload className="h-4 w-4 mr-2" />
                      Choose File
                      <input
                        type="file"
                        accept=".pdf"
                        onChange={(e) => setNewDocumentFile(e.target.files?.[0] || null)}
                        className="hidden"
                      />
                    </label>
                    {newDocumentFile && (
                      <span className="text-sm text-gray-600">{newDocumentFile.name}</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-gray-500">Upload a PDF document to use as the proposal template</p>
                </div>

                <div className="flex items-center justify-end gap-4 pt-4 border-t">
                  <button
                    onClick={() => {
                      setShowCreateForm(false);
                      setNewDocumentName('');
                      setNewDocumentDescription('');
                      setNewDocumentCategory('General');
                      setNewDocumentFile(null);
                      setError(null);
                    }}
                    className="btn-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateDocument}
                    disabled={uploading || !newDocumentName.trim() || !newDocumentFile}
                    className="btn-primary flex items-center gap-2"
                  >
                    {uploading ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                        Creating...
                      </>
                    ) : (
                      <>
                        <Plus className="h-4 w-4" />
                        Create Document
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ProposalDocumentsManagementModal;

