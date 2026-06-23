// File: frontend/src/pages/tenant-admin/GroupDocumentsTab.tsx
// Updated GroupDocumentsTab.tsx - Production Ready
import { format } from 'date-fns';
import {
    AlertCircle,
    Briefcase,
    Building,
    Calendar,
    CheckCircle,
    ClipboardList,
    CloudUpload,
    Download,
    Eye,
    File,
    FileSpreadsheet,
    FileText,
    Folder,
    RefreshCw,
    Trash2,
    User,
    X
} from 'lucide-react';
import React, { useRef, useState } from 'react';
import {
    useDeleteDocument,
    useDownloadDocument,
    useGroupDocuments,
    useSaveDocumentMetadata,
    useUploadDocuments
} from '../../hooks/useDocuments';
import { Document, DocumentMetadata } from '../../services/groups.service';

interface GroupDocumentsTabProps {
  groupId: string;
  groupName: string;
}

// Upload Dialog Component
interface UploadDialogProps {
  open: boolean;
  onClose: () => void;
  onUpload: (files: File[], documentType: string, description: string) => void;
  uploading: boolean;
}

const UploadDialog: React.FC<UploadDialogProps> = ({ open, onClose, onUpload, uploading }) => {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [documentType, setDocumentType] = useState<string>('Other');
  const [description, setDescription] = useState<string>('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setSelectedFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFiles(Array.from(e.target.files));
    }
  };

  const handleUpload = () => {
    if (selectedFiles.length > 0) {
      onUpload(selectedFiles, documentType, description);
      handleClose();
    }
  };

  const handleClose = () => {
    setSelectedFiles([]);
    setDocumentType('Other');
    setDescription('');
    onClose();
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={handleClose}></div>

        <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
          <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">
                Upload Documents
              </h3>
              <button onClick={handleClose} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Document Type Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Document Type
                </label>
                <select
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="W-9">W-9 Form</option>
                  <option value="ParticipationAgreement">Participation Agreement</option>
                  <option value="PayrollFile">Payroll File</option>
                  <option value="OnboardingDocs">Onboarding Documents</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description (Optional)
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
              </div>

              {/* File Upload Area */}
              <div
                className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                  dragActive 
                    ? 'border-blue-400 bg-blue-50' 
                    : 'border-gray-300 hover:border-gray-400'
                }`}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png"
                />
                
                <CloudUpload className="h-12 w-12 text-oe-primary mx-auto mb-2" />
                <p className="text-sm text-gray-600 mb-1">
                  {selectedFiles.length > 0
                    ? `${selectedFiles.length} file(s) selected`
                    : 'Drag and drop files here or click to browse'}
                </p>
                <p className="text-xs text-gray-500">
                  Supported formats: PDF, DOC, DOCX, XLS, XLSX, CSV, JPG, PNG
                </p>
              </div>

              {/* Selected Files List */}
              {selectedFiles.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">Selected Files:</p>
                  {selectedFiles.map((file, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-2 bg-blue-50 rounded-md mb-1"
                    >
                      <div className="flex items-center space-x-2">
                        <File className="h-4 w-4 text-oe-primary" />
                        <span className="text-sm">{file.name}</span>
                      </div>
                      <span className="text-xs text-gray-500">
                        {formatFileSize(file.size)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
            <button
              type="button"
              onClick={handleUpload}
              disabled={selectedFiles.length === 0 || uploading}
              className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-oe-primary text-base font-medium text-white hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {uploading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Uploading...
                </>
              ) : (
                <>
                  <CloudUpload className="h-4 w-4 mr-2" />
                  Upload
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const GroupDocumentsTab: React.FC<GroupDocumentsTabProps> = ({ groupId, groupName }) => {
  // State
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success' as 'success' | 'error' | 'warning' | 'info',
  });

  // Hooks
  const { 
    data: documents = [], 
    isLoading, 
    isError, 
    error, 
    refetch 
  } = useGroupDocuments(groupId);

  const uploadDocumentsMutation = useUploadDocuments();
  const saveDocumentMetadataMutation = useSaveDocumentMetadata();
  const downloadDocumentMutation = useDownloadDocument();
  const deleteDocumentMutation = useDeleteDocument();

  // Utility functions
  const showSnackbar = (message: string, severity: 'success' | 'error' | 'warning' | 'info') => {
    setSnackbar({ open: true, message, severity });
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getDocumentIcon = (fileType: string, documentType: string) => {
    if (fileType.includes('pdf')) return <FileText className="h-5 w-5 text-red-600" />;
    
    switch (documentType) {
      case 'W-9':
        return <Building className="h-5 w-5 text-oe-primary" />;
      case 'ParticipationAgreement':
        return <ClipboardList className="h-5 w-5 text-purple-600" />;
      case 'PayrollFile':
        return <Briefcase className="h-5 w-5 text-green-600" />;
      case 'OnboardingDocs':
        return <FileSpreadsheet className="h-5 w-5 text-orange-600" />;
      default:
        return <FileText className="h-5 w-5 text-gray-600" />;
    }
  };

  const getDocumentTypeLabel = (type: string) => {
    switch (type) {
      case 'W-9':
        return 'W-9 Form';
      case 'ParticipationAgreement':
        return 'Participation Agreement';
      case 'PayrollFile':
        return 'Payroll File';
      case 'OnboardingDocs':
        return 'Onboarding Documents';
      default:
        return 'Other';
    }
  };

  const getDocumentTypeColor = (type: string) => {
    switch (type) {
      case 'W-9':
        return 'bg-blue-100 text-blue-800';
      case 'ParticipationAgreement':
        return 'bg-purple-100 text-purple-800';
      case 'PayrollFile':
        return 'bg-green-100 text-green-800';
      case 'OnboardingDocs':
        return 'bg-orange-100 text-orange-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  // Upload handler
  const handleUpload = async (files: File[], documentType: string, description: string) => {
    try {
      const uploadResponse = await uploadDocumentsMutation.mutateAsync({
        groupId,
        files,
        documentType,
        description
      });

      if (uploadResponse.success) {
        // Create standardized file structure from the response
        const standardizedFiles = files.map((file, index) => ({
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          url: uploadResponse.data?.data?.[index]?.url || uploadResponse.data?.url || '#',
          storedFileName: uploadResponse.data?.data?.[index]?.storedFileName || uploadResponse.data?.filename || file.name,
          containerName: uploadResponse.data?.data?.[index]?.containerName || 'documents',
        }));

        // Save document metadata for each file
        for (const file of standardizedFiles) {
          const metadata: DocumentMetadata = {
            fileName: file.fileName,
            fileType: file.fileType,
            fileSize: file.fileSize,
            documentType: documentType,
            description: description,
            url: file.url,
            storedFileName: file.storedFileName,
            containerName: file.containerName,
          };

          await saveDocumentMetadataMutation.mutateAsync({
            groupId,
            metadata
          });
        }

        showSnackbar(`Successfully uploaded ${files.length} document(s)`, 'success');
      } else {
        throw new Error(uploadResponse.message || 'Upload failed');
      }
    } catch (error) {
      console.error('Error uploading documents:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to upload documents', 'error');
    }
  };

  // Download handler
  const handleDownload = async (document: Document) => {
    try {
      const response = await downloadDocumentMutation.mutateAsync({
        groupId,
        documentId: document.DocumentId
      });

      if (response.success && response.data?.downloadUrl) {
        window.open(response.data.downloadUrl, '_blank');
        showSnackbar('Download started', 'success');
      } else {
        throw new Error('Download URL not available');
      }
    } catch (error) {
      console.error('Error downloading document:', error);
      showSnackbar('Failed to download document', 'error');
    }
  };

  // View handler
  const handleView = async (documentItem: Document) => {
    try {
      const response = await downloadDocumentMutation.mutateAsync({
        groupId,
        documentId: documentItem.DocumentId
      });

      if (response.success && response.data?.downloadUrl) {
        // Check file type to determine if it can be viewed in browser
        const { mimeType, fileName, downloadUrl } = response.data;
        
        // These types can be viewed directly in most browsers
        const viewableTypes = [
          'application/pdf',
          'image/',
          'text/',
          'video/',
          'audio/'
        ];
        
        const isViewable = viewableTypes.some(type => 
          mimeType?.toLowerCase().includes(type.toLowerCase())
        );
        
        if (isViewable) {
          // Open directly in the browser
          window.open(downloadUrl, '_blank');
          showSnackbar('Document opened for viewing', 'success');
        } else {
          // For non-viewable types, trigger a download instead
          const link = document.createElement('a');
          link.href = downloadUrl;
          link.download = fileName || 'document';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          showSnackbar('Document downloaded (not viewable in browser)', 'info');
        }
      } else {
        throw new Error('View URL not available');
      }
    } catch (error) {
      console.error('Error viewing document:', error);
      showSnackbar('Failed to view document', 'error');
    }
  };

  // Delete handler
  const handleDelete = async (documentId: string) => {
    try {
      const response = await deleteDocumentMutation.mutateAsync({
        groupId,
        documentId
      });

      if (response.success) {
        showSnackbar('Document deleted successfully', 'success');
        // Force refetch documents to refresh the list
        refetch();
      } else {
        throw new Error(response.message || 'Failed to delete document');
      }
    } catch (error) {
      console.error('Error deleting document:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to delete document', 'error');
    }
  };

  // Group documents by type for summary
  const documentSummary = documents.reduce((acc, doc) => {
    acc[doc.DocumentType] = (acc[doc.DocumentType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg text-gray-600">Loading documents...</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
        <div className="flex items-center">
          <AlertCircle className="h-5 w-5 mr-2" />
          <span>Error loading documents: {error?.message}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900 mb-1">Document Management</h2>
          <p className="text-gray-600">Upload and manage important documents for {groupName}</p>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => refetch()}
            disabled={isLoading}
            className="p-2 text-gray-600 hover:text-gray-800 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`h-5 w-5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setUploadDialogOpen(true)}
            disabled={uploadDocumentsMutation.isPending}
            className="bg-oe-primary text-white px-4 py-2 rounded-lg hover:bg-oe-primary-dark disabled:opacity-50 flex items-center"
          >
            <CloudUpload className="h-4 w-4 mr-2" />
            {uploadDocumentsMutation.isPending ? 'Uploading...' : 'Upload Documents'}
          </button>
        </div>
      </div>

      {/* Document Type Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {['W-9', 'ParticipationAgreement', 'PayrollFile', 'OnboardingDocs'].map((type) => {
          const count = documentSummary[type] || 0;
          const hasDocument = count > 0;
          
          return (
            <div
              key={type}
              className={`bg-white rounded-lg border p-4 ${
                hasDocument ? 'border-green-200 bg-green-50' : 'border-gray-200'
              }`}
            >
              <div className="flex items-center space-x-3">
                <div className={`p-2 rounded-lg ${
                  hasDocument ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'
                }`}>
                  {getDocumentIcon('', type)}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">
                    {getDocumentTypeLabel(type)}
                  </p>
                  <div className="flex items-center space-x-1">
                    {hasDocument ? (
                      <>
                        <CheckCircle className="h-4 w-4 text-green-600" />
                        <span className="text-xs text-green-600">
                          {count} file{count > 1 ? 's' : ''}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-gray-500">Not uploaded</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Documents Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Documents</h3>
        </div>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Document
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Type
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Uploaded By
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Upload Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Size
                </th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {documents.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center">
                      <Folder className="h-12 w-12 text-gray-400 mb-3" />
                      <h3 className="text-lg font-medium text-gray-900 mb-1">No documents uploaded yet</h3>
                      <p className="text-gray-600">Click "Upload Documents" to add your first document</p>
                    </div>
                  </td>
                </tr>
              ) : (
                documents.map((document) => (
                  <tr key={document.DocumentId} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div className="flex items-center space-x-3">
                        {getDocumentIcon(document.FileType, document.DocumentType)}
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {document.FileName}
                          </p>
                          {document.Description && (
                            <p className="text-xs text-gray-500">
                              {document.Description}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getDocumentTypeColor(document.DocumentType)}`}>
                        {getDocumentTypeLabel(document.DocumentType)}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center space-x-1">
                        <User className="h-4 w-4 text-gray-400" />
                        <span className="text-sm text-gray-900">
                          {document.UploadedByName}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center space-x-1">
                        <Calendar className="h-4 w-4 text-gray-400" />
                        <span className="text-sm text-gray-900">
                          {format(new Date(document.UploadedDate), 'MMM dd, yyyy')}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm text-gray-900">
                        {formatFileSize(document.FileSize)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <div className="flex items-center justify-center space-x-1">
                        <button
                          onClick={() => handleView(document)}
                          className="text-gray-600 hover:text-oe-primary p-1"
                          title="View in Browser"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDownload(document)}
                          className="text-gray-600 hover:text-green-600 p-1"
                          title="Download File"
                        >
                          <Download className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => {
                            setSelectedDocument(document);
                            setDeleteConfirmOpen(true);
                          }}
                          className="text-gray-600 hover:text-red-600 p-1"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Upload Dialog */}
      <UploadDialog
        open={uploadDialogOpen}
        onClose={() => setUploadDialogOpen(false)}
        onUpload={handleUpload}
        uploading={uploadDocumentsMutation.isPending}
      />

      {/* Delete Confirmation Dialog */}
      {deleteConfirmOpen && selectedDocument && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => setDeleteConfirmOpen(false)}></div>

            <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-sm sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  Delete Document
                </h3>
                <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded mb-4">
                  Are you sure you want to delete "{selectedDocument.FileName}"? This action cannot be undone.
                </div>
              </div>
              <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                <button
                  onClick={() => {
                    handleDelete(selectedDocument.DocumentId);
                    setDeleteConfirmOpen(false);
                    setSelectedDocument(null);
                  }}
                  className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-red-600 text-base font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 sm:ml-3 sm:w-auto sm:text-sm"
                >
                  Delete
                </button>
                <button
                  onClick={() => setDeleteConfirmOpen(false)}
                  className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Snackbar */}
      {snackbar.open && (
        <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 z-50">
          <div className={`flex items-center px-4 py-3 rounded-lg border shadow-lg ${
            snackbar.severity === 'success' ? 'bg-green-50 text-green-800 border-green-200' :
            snackbar.severity === 'error' ? 'bg-red-50 text-red-800 border-red-200' :
            snackbar.severity === 'warning' ? 'bg-yellow-50 text-yellow-800 border-yellow-200' :
            'bg-blue-50 text-blue-800 border-blue-200'
          }`}>
            <span className="mr-2">{snackbar.message}</span>
            <button
              onClick={() => setSnackbar({ ...snackbar, open: false })}
              className="ml-4"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GroupDocumentsTab;