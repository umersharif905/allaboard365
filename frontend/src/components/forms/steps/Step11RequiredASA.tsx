import { CheckCircle, FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiService } from '../../../services/apiServices';
import { StepProps } from '../../../types/sysadmin/addproductswizard.types';

interface VendorDocument {
  fileId: string;
  fileName: string;
  storedFileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  containerName: string;
  documentType?: string;
  uploadedDate?: string;
  uploadedByName?: string;
}

export default function Step11RequiredASA({ formData, updateFormData }: StepProps) {
  const [vendorDocuments, setVendorDocuments] = useState<VendorDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDocument, setSelectedDocument] = useState<VendorDocument | null>(null);

  // Fetch vendor documents when component mounts
  useEffect(() => {
    if (formData.vendorId) {
      fetchVendorDocuments();
    }
  }, [formData.vendorId]);

  // Set selected document when formData changes
  useEffect(() => {
    if (formData.requiredASA && vendorDocuments.length > 0) {
      const doc = vendorDocuments.find(d => d.fileId === formData.requiredASA?.documentId);
      if (doc) {
        setSelectedDocument(doc);
      }
    }
  }, [formData.requiredASA, vendorDocuments]);

  const fetchVendorDocuments = async () => {
    if (!formData.vendorId) return;

    try {
      setLoading(true);
      console.log('🔍 Fetching vendor documents for vendorId:', formData.vendorId);
      
      const data = await apiService.get<{ success: boolean; data?: any[] }>(`/api/vendors/${formData.vendorId}/documents`);
      
      if (data.success) {
        console.log('📄 Vendor documents response:', data);
        
        if (data.success) {
          // Map the vendor documents to the expected format
          const mappedDocuments = (data.data || []).map((doc: any) => ({
            fileId: doc.DocumentId || doc.FileId,
            fileName: doc.FileName,
            storedFileName: doc.StoredFileName,
            fileSize: doc.FileSize,
            mimeType: doc.FileType,
            url: doc.Url,
            containerName: doc.ContainerName,
            documentType: doc.DocumentType,
            uploadedDate: doc.UploadedDate,
            uploadedByName: doc.UploadedByName
          }));
          
          console.log('📋 Mapped vendor documents:', mappedDocuments);
          setVendorDocuments(mappedDocuments);
        } else {
          console.error('❌ Failed to fetch vendor documents');
          setVendorDocuments([]);
        }
      } else {
        console.error('❌ Failed to fetch vendor documents');
        setVendorDocuments([]);
      }
    } catch (error) {
      console.error('❌ Error fetching vendor documents:', error);
      setVendorDocuments([]);
    } finally {
      setLoading(false);
    }
  };

  const handleDocumentSelect = (document: VendorDocument) => {
    setSelectedDocument(document);
    updateFormData({
      requiredASA: {
        documentId: document.fileId,
        documentName: document.fileName,
        documentUrl: document.url
      }
    });
  };

  const handleDocumentDeselect = () => {
    setSelectedDocument(null);
    updateFormData({
      requiredASA: undefined
    });
  };

  return (
    <div className="space-y-6">
      <div className="text-center mb-8">
        <FileText className="h-16 w-16 text-oe-primary mx-auto mb-4" />
        <h3 className="text-xl font-bold text-gray-900">Required ASA Agreement</h3>
        <p className="text-gray-600 mt-2">
          Select an ASA (Agent Service Agreement) document from the vendor's uploaded documents.
          This agreement will be required for group admins to sign during onboarding.
        </p>
      </div>

      {loading ? (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
          <p className="text-gray-600">Loading vendor documents...</p>
        </div>
      ) : vendorDocuments.length === 0 ? (
        <div className="text-center py-8">
          <div className="alert-warning text-center p-6">
            <FileText className="h-12 w-12 text-yellow-600 mx-auto mb-4" />
            <h4 className="text-lg font-semibold mb-2">No Documents Available</h4>
            <p className="mb-4">
              This vendor has no uploaded documents yet. Please upload ASA agreements in the vendor management section first.
            </p>
            <p className="text-sm">
              You can skip this step and add the ASA agreement later, or contact the vendor to upload their documents.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Document Selection */}
          <div className="card">
            <h4 className="font-semibold text-gray-900 mb-4">Available Documents</h4>
            
            {/* None Option */}
            <div className="mb-4 p-3 border border-gray-200 rounded-lg">
              <div className="flex items-start space-x-3">
                <div className="flex-shrink-0 pt-1">
                  <input
                    type="radio"
                    name="selectedDocument"
                    id="document-none"
                    checked={!selectedDocument}
                    onChange={handleDocumentDeselect}
                    className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                  />
                </div>
                <div className="flex-1">
                  <label 
                    htmlFor="document-none"
                    className="block font-medium text-gray-900 cursor-pointer"
                  >
                    No ASA Agreement Required
                  </label>
                  <p className="text-sm text-gray-600 mt-1">
                    Skip this step - no ASA agreement will be required for this product
                  </p>
                </div>
              </div>
            </div>
            
            <div className="space-y-3">
              {vendorDocuments.map((doc) => (
                <div
                  key={doc.fileId}
                  className={`p-4 border-2 rounded-lg transition-all ${
                    selectedDocument?.fileId === doc.fileId
                      ? 'border-green-500 bg-green-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-start space-x-3">
                    {/* Checkbox */}
                    <div className="flex-shrink-0 pt-1">
                      <input
                        type="radio"
                        name="selectedDocument"
                        id={`document-${doc.fileId}`}
                        checked={selectedDocument?.fileId === doc.fileId}
                        onChange={() => handleDocumentSelect(doc)}
                        className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                      />
                    </div>
                    
                    {/* Document Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-3">
                        <FileText className="h-6 w-6 text-oe-primary flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <label 
                            htmlFor={`document-${doc.fileId}`}
                            className="block font-medium text-gray-900 cursor-pointer"
                          >
                            {doc.fileName}
                          </label>
                          <p className="text-sm text-gray-600 mt-1">
                            {(doc.fileSize / 1024 / 1024).toFixed(2)} MB • {doc.mimeType?.split('/')[1]?.toUpperCase() || 'Unknown'}
                            {doc.uploadedByName && (
                              <span className="ml-2">• Uploaded by {doc.uploadedByName}</span>
                            )}
                          </p>
                          {doc.uploadedDate && (
                            <p className="text-xs text-gray-500 mt-1">
                              Uploaded on {new Date(doc.uploadedDate).toLocaleDateString()}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    {/* Actions */}
                    <div className="flex-shrink-0 flex items-center space-x-2">
                      <button
                        onClick={() => window.open(doc.url, '_blank')}
                        className="text-oe-primary hover:text-oe-primary-dark text-sm underline transition-colors"
                      >
                        Preview
                      </button>
                      {selectedDocument?.fileId === doc.fileId && (
                        <CheckCircle className="h-5 w-5 text-oe-success" />
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Instructions */}
          <div className="alert-info">
            <h4 className="font-semibold mb-2">About ASA Agreements</h4>
            <ul className="text-sm space-y-1">
              <li>• Use the radio buttons to select an ASA agreement document from the vendor's uploaded files</li>
              <li>• This agreement will be required for group admins to sign during onboarding</li>
              <li>• You can preview documents by clicking the "Preview" button</li>
              <li>• Select "No ASA Agreement Required" if you don't want to require an agreement for this product</li>
              <li>• If no suitable document is available, you can skip this step and add it later</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}



