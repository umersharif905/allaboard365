// components/fap/FAPDocumentsSection.tsx
// FAP Documents Management Component

import { useEffect, useState, useRef } from 'react';
import { Upload, Download, FileText, X, Folder, Save } from 'lucide-react';
import { apiService } from '../../services/api.service';
import { FAPDocument, FAP_DOCUMENT_TYPES } from '../../types/fap.types';

interface FAPDocumentsSectionProps {
  providerId: string;
}

const FAPDocumentsSection: React.FC<FAPDocumentsSectionProps> = ({ providerId }) => {
  const [loading, setLoading] = useState(true);
  const [documents, setDocuments] = useState<FAPDocument[]>([]);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadForm, setUploadForm] = useState({
    documentName: '',
    documentType: '',
    description: ''
  });

  useEffect(() => {
    loadDocuments();
  }, [providerId]);

  const loadDocuments = async () => {
    try {
      setLoading(true);
      const response = await apiService.get<{ success: boolean; data: any[] }>(
        `/api/me/vendor/providers/${providerId}/fap/documents`
      );
      if (response.success) {
        // Normalize document IDs - handle both DocumentId (capital D) and documentId (lowercase d)
        const normalizedDocuments: FAPDocument[] = response.data.map((doc: any) => ({
          ...doc,
          documentId: doc.documentId || doc.DocumentId || doc.fileId || doc.FileId,
          documentName: doc.documentName || doc.DocumentName || doc.fileName || doc.FileName,
          fileName: doc.fileName || doc.FileName,
          fileSize: doc.fileSize || doc.FileSize,
          mimeType: doc.mimeType || doc.MimeType,
          blobUrl: doc.blobUrl || doc.BlobUrl,
          blobPath: doc.blobPath || doc.BlobPath,
          authenticatedUrl: doc.authenticatedUrl || doc.AuthenticatedUrl,
          documentType: doc.documentType || doc.DocumentType,
          description: doc.description || doc.Description,
          createdDate: doc.createdDate || doc.CreatedDate,
          createdByFirstName: doc.createdByFirstName || doc.CreatedByFirstName,
          createdByLastName: doc.createdByLastName || doc.CreatedByLastName,
        }));
        setDocuments(normalizedDocuments);
      }
    } catch (err: any) {
      console.error('Error loading FAP documents:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      // Auto-fill document name with filename if not already set
      if (!uploadForm.documentName) {
        setUploadForm(prev => ({ ...prev, documentName: file.name }));
      }
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      alert('Please select a file to upload');
      return;
    }

    if (!uploadForm.documentName.trim()) {
      alert('Please enter a document name');
      return;
    }

    if (!uploadForm.documentType) {
      alert('Please select a document type');
      return;
    }

    try {
      setUploading(true);
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('documentName', uploadForm.documentName.trim());
      formData.append('documentType', uploadForm.documentType);
      formData.append('description', uploadForm.description);

      const response = await apiService.post<{ success: boolean; data: FAPDocument }>(
        `/api/me/vendor/providers/${providerId}/fap/documents`,
        formData,
        {
          headers: { 'Content-Type': 'multipart/form-data' }
        }
      );

      if (response.success) {
        await loadDocuments();
        setShowUploadModal(false);
        resetUploadForm();
      }
    } catch (err: any) {
      console.error('Error uploading document:', err);
      alert(err.message || 'Failed to upload document');
    } finally {
      setUploading(false);
    }
  };

  const resetUploadForm = () => {
    setSelectedFile(null);
    setUploadForm({ documentName: '', documentType: '', description: '' });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleCloseModal = () => {
    resetUploadForm();
    setShowUploadModal(false);
  };

  const handleDownload = (document: FAPDocument) => {
    if (document.authenticatedUrl) {
      window.open(document.authenticatedUrl, '_blank');
    } else if (document.blobUrl) {
      window.open(document.blobUrl, '_blank');
    }
  };

  const handleDelete = async (documentId: string) => {
    if (!confirm('Are you sure you want to delete this document?')) return;

    try {
      const response = await apiService.delete<{ success: boolean }>(
        `/api/me/vendor/fap/documents/${documentId}`
      );
      if (response.success) {
        await loadDocuments();
      }
    } catch (err: any) {
      console.error('Error deleting document:', err);
      alert(err.message || 'Failed to delete document');
    }
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return 'Unknown size';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const groupedDocuments = documents.reduce((acc, doc) => {
    const type = doc.documentType || 'Other';
    if (!acc[type]) acc[type] = [];
    acc[type].push(doc);
    return acc;
  }, {} as Record<string, FAPDocument[]>);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-gray-900">FAP Documents</h4>
          <p className="text-xs text-gray-500 mt-1">
            Upload and manage documents related to this provider's FAP program
          </p>
        </div>
        <button
          onClick={() => setShowUploadModal(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-oe-primary hover:text-oe-dark hover:bg-oe-light rounded-lg transition-colors"
        >
          <Upload className="h-4 w-4" />
          Upload
        </button>
      </div>

      {/* Documents List */}
      {loading ? (
        <div className="animate-pulse space-y-4">
          <div className="h-24 bg-gray-200 rounded"></div>
          <div className="h-24 bg-gray-200 rounded"></div>
        </div>
      ) : documents.length === 0 ? (
        <div className="bg-gray-50 rounded-lg p-8 text-center border border-gray-200">
          <Folder className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm font-medium">No documents uploaded</p>
          <p className="text-gray-400 text-xs mt-1">Upload your first FAP document</p>
          <button
            onClick={() => setShowUploadModal(true)}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-oe-primary bg-oe-light hover:bg-oe-primary-light rounded-lg transition-colors"
          >
            <Upload className="h-4 w-4" />
            Upload Document
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedDocuments).map(([type, docs]) => (
            <div key={type}>
              <h4 className="text-sm font-semibold text-gray-700 mb-3">{type}</h4>
              <div className="space-y-2">
                {docs.map((doc, index) => (
                  <div
                    key={doc.documentId || `doc-${type}-${index}`}
                    className="bg-white rounded-lg border border-gray-200 p-4 flex items-center justify-between hover:border-oe-primary transition-all"
                  >
                    <div className="flex items-center gap-3 flex-1">
                      <FileText className="h-5 w-5 text-gray-400" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-900">{doc.documentName}</p>
                        <div className="flex items-center gap-4 mt-1">
                          <span className="text-xs text-gray-500">
                            {formatFileSize(doc.fileSize)}
                          </span>
                          <span className="text-xs text-gray-500">
                            {formatDate(doc.createdDate)}
                          </span>
                          {doc.createdByFirstName && (
                            <span className="text-xs text-gray-500">
                              by {doc.createdByFirstName} {doc.createdByLastName}
                            </span>
                          )}
                        </div>
                        {doc.description && (
                          <p className="text-xs text-gray-500 mt-1">{doc.description}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleDownload(doc)}
                        className="p-2 text-gray-400 hover:text-oe-primary"
                        title="Download"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => {
                          const docId = doc.documentId;
                          if (!docId) {
                            console.error('Document ID is missing:', doc);
                            alert('Cannot delete document: missing document ID');
                            return;
                          }
                          handleDelete(docId);
                        }}
                        className="p-2 text-gray-400 hover:text-red-600"
                        title="Delete"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-2xl">
            <div className="p-6 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-semibold text-gray-900">Upload Document</h3>
              <button
                onClick={handleCloseModal}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Document Name *
                </label>
                <input
                  type="text"
                  value={uploadForm.documentName}
                  onChange={(e) => setUploadForm(prev => ({ ...prev, documentName: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="Enter document name"
                  disabled={uploading}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Document Type *
                </label>
                <select
                  value={uploadForm.documentType}
                  onChange={(e) => setUploadForm(prev => ({ ...prev, documentType: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  disabled={uploading}
                >
                  <option value="">Select type</option>
                  {FAP_DOCUMENT_TYPES.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description (optional)
                </label>
                <textarea
                  value={uploadForm.description}
                  onChange={(e) => setUploadForm(prev => ({ ...prev, description: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  rows={3}
                  placeholder="Add a description for this document"
                  disabled={uploading}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  File *
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={handleFileChange}
                  className="hidden"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
                  disabled={uploading}
                />
                {selectedFile ? (
                  <div className="w-full px-4 py-3 border-2 border-solid border-oe-primary rounded-lg bg-oe-light flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FileText className="h-5 w-5 text-oe-primary" />
                      <div>
                        <p className="text-sm font-medium text-gray-900">{selectedFile.name}</p>
                        <p className="text-xs text-gray-500">
                          {(selectedFile.size / 1024).toFixed(1)} KB
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setSelectedFile(null);
                        if (fileInputRef.current) {
                          fileInputRef.current.value = '';
                        }
                      }}
                      className="p-1 text-gray-400 hover:text-red-600"
                      disabled={uploading}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleFileSelect}
                    className="w-full px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg hover:border-oe-primary text-gray-600 hover:text-oe-primary flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={uploading}
                  >
                    <Upload className="h-5 w-5" />
                    Select File to Upload
                  </button>
                )}
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={handleCloseModal}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={uploading}
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={uploading || !selectedFile || !uploadForm.documentName.trim() || !uploadForm.documentType}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <Save className="h-4 w-4" />
                {uploading ? 'Uploading...' : 'Upload Document'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FAPDocumentsSection;

