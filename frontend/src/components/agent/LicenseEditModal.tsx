// frontend/src/components/agent/LicenseEditModal.tsx
import { Briefcase, CheckCircle, FileText, Upload, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { LICENSE_STATUS_OPTIONS, LICENSE_TYPES, RESIDENCY_TYPE_OPTIONS, US_STATES_FORMATTED } from '../../constants/form-options';
import { MAX_DOCUMENT_UPLOAD_BYTES, MAX_DOCUMENT_UPLOAD_MB } from '../../constants/uploads';

interface LicenseInfo {
  licenseId?: string;
  licenseNumber: string;
  state: string;
  expirationDate: string;
  status: 'active' | 'pending' | 'expired';
  type: string;
  verificationStatus: 'verified' | 'pending' | 'rejected';
}

interface DocumentWithLicense {
  file: File;
  licenseType: string;
  state: string;
  licenseNumber: string;
  expirationDate: string;
  issueDate: string;
  status: string;
  residencyType: string;
  loaIssueDate: string;
  companyAppointmentDate: string;
  renewalDate: string;
}

interface LicenseEditModalProps {
  licenses: LicenseInfo[];
  onClose: () => void;
  onSave: (uploadedDocuments: DocumentWithLicense[]) => Promise<void>;
  onDeleteLicense?: (licenseId: string) => Promise<void>;
  loading: boolean;
}

const LicenseEditModal: React.FC<LicenseEditModalProps> = ({ licenses, onClose, onSave, onDeleteLicense, loading }) => {
  const [existingLicenses, setExistingLicenses] = useState<LicenseInfo[]>(licenses);
  const [uploadedDocuments, setUploadedDocuments] = useState<DocumentWithLicense[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showUploadArea, setShowUploadArea] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [licenseToConfirmDelete, setLicenseToConfirmDelete] = useState<LicenseInfo | null>(null);
  const [deletingLicense, setDeletingLicense] = useState(false);

  // Update existing licenses when prop changes (after save)
  useEffect(() => {
    setExistingLicenses(licenses);
  }, [licenses]);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    const validFiles = files.filter(file => {
      const isValidType = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'].includes(file.type);
      const isValidSize = file.size <= MAX_DOCUMENT_UPLOAD_BYTES;
      return isValidType && isValidSize;
    });
    
    if (validFiles.length !== files.length) {
      setUploadError(`Some files were skipped. Only PDF, JPG, PNG files up to ${MAX_DOCUMENT_UPLOAD_MB}MB are allowed.`);
      setTimeout(() => setUploadError(null), 5000);
    }
    
    // Add files with default license metadata
    const documentsWithLicense: DocumentWithLicense[] = validFiles.map(file => ({
      file,
      licenseType: '',
      state: '',
      licenseNumber: '',
      expirationDate: '',
      issueDate: '',
      status: 'Active',
      residencyType: 'Resident',
      loaIssueDate: '',
      companyAppointmentDate: '',
      renewalDate: ''
    }));
    
    setUploadedDocuments(prev => [...prev, ...documentsWithLicense]);
  };

  const removeDocument = (index: number) => {
    setUploadedDocuments(prev => prev.filter((_, i) => i !== index));
  };

  const confirmDeleteExistingLicense = async () => {
    if (!licenseToConfirmDelete) {
      return;
    }

    try {
      setDeletingLicense(true);
      setUploadError(null);

      if (!licenseToConfirmDelete.licenseId) {
        throw new Error('Unable to delete this license because the license ID is missing.');
      }

      if (!onDeleteLicense) {
        throw new Error('Delete handler is not configured.');
      }

      await onDeleteLicense(licenseToConfirmDelete.licenseId);
      setExistingLicenses(prev => prev.filter((lic) => lic.licenseId !== licenseToConfirmDelete.licenseId));
      setLicenseToConfirmDelete(null);
    } catch (error: any) {
      setUploadError(error.message || 'Failed to delete license');
    } finally {
      setDeletingLicense(false);
    }
  };

  const updateDocumentField = (index: number, field: keyof DocumentWithLicense, value: any) => {
    setUploadedDocuments(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate that all NEW documents have required fields
    const missingFields = uploadedDocuments.filter(doc => 
      !doc.licenseNumber || 
      !doc.licenseType || 
      !doc.state || 
      !doc.residencyType ||
      !doc.status ||
      !doc.issueDate ||
      !doc.expirationDate
    );
    
    if (missingFields.length > 0) {
      setUploadError('Please fill in all required fields for all uploaded licenses.');
      return;
    }
    
    setUploadError(null);
    setSuccessMessage(null);
    
    try {
      // Pass new documents to upload
      await onSave(uploadedDocuments);
      
      // Clear the upload state after successful save
      setUploadedDocuments([]);
      setShowUploadArea(false);
      
      // Show success message
      const addedCount = uploadedDocuments.length;
      setSuccessMessage(`Successfully added ${addedCount} license${addedCount !== 1 ? 's' : ''}!`);
      
      // Auto-hide success message after 3 seconds
      setTimeout(() => setSuccessMessage(null), 3000);
      
    } catch (error: any) {
      setUploadError(error.message || 'Failed to save licenses');
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-6 z-10">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-xl font-semibold text-gray-800 flex items-center">
                <Briefcase className="h-5 w-5 mr-2 text-oe-primary" />
                Manage License Documents
              </h2>
              <p className="text-sm text-gray-600 mt-1">Upload license documents with detailed information</p>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full">
              <X size={24} />
            </button>
          </div>
        </div>
        
        <form onSubmit={handleSubmit} className="p-6">
          <div className="space-y-6">
            {/* Success Message */}
            {successMessage && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                <p className="text-sm text-green-800">{successMessage}</p>
              </div>
            )}

            {/* Upload Error */}
            {uploadError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm text-red-800">{uploadError}</p>
              </div>
            )}

            {/* Existing Licenses */}
            {existingLicenses.length > 0 ? (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3">
                  Current Licenses ({existingLicenses.length})
                </h4>
                <div className="space-y-3">
                  {existingLicenses.map((license, index) => (
                    <div key={index} className="bg-white p-4 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <Briefcase className="h-4 w-4 text-oe-primary" />
                            <span className="font-medium text-gray-900">{license.state} - {license.type}</span>
                            <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                              license.status === 'active' ? 'bg-green-100 text-green-800' :
                              license.status === 'expired' ? 'bg-red-100 text-red-800' :
                              'bg-yellow-100 text-yellow-800'
                            }`}>
                              {license.status}
                            </span>
                          </div>
                          <div className="text-sm text-gray-600 space-y-1">
                            <p><span className="font-medium">License #:</span> {license.licenseNumber}</p>
                            <p><span className="font-medium">Expires:</span> {new Date(license.expirationDate).toLocaleDateString()}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setLicenseToConfirmDelete(license)}
                          className="text-red-600 hover:text-red-800 hover:bg-red-50 p-2 rounded ml-2 flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                          disabled={loading || deletingLicense || !license.licenseId}
                          title={license.licenseId ? 'Remove license' : 'Cannot remove this license (missing ID)'}
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : !showUploadArea && uploadedDocuments.length === 0 && (
              <div className="text-center py-8 bg-gray-50 rounded-lg border border-gray-200">
                <Briefcase className="h-12 w-12 text-gray-400 mx-auto mb-3" />
                <h4 className="font-medium text-gray-700 mb-2">No Licenses Added Yet</h4>
                <p className="text-sm text-gray-500 mb-4">Add your first license document to get started</p>
              </div>
            )}

            {/* File Upload Area - Show only when button is clicked */}
            {showUploadArea && uploadedDocuments.length === 0 && (
              <div className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-medium text-gray-700">Upload License Document</h4>
                  <button
                    type="button"
                    onClick={() => setShowUploadArea(false)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div 
                className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-400 transition-colors cursor-pointer bg-gray-50"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.classList.add('border-blue-400', 'bg-blue-50');
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.classList.remove('border-blue-400', 'bg-blue-50');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.classList.remove('border-blue-400', 'bg-blue-50');
                  
                  if (loading) return;
                  
                  const files = Array.from(e.dataTransfer.files);
                  const validFiles = files.filter(file => {
                    const isValidType = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'].includes(file.type);
                    const isValidSize = file.size <= MAX_DOCUMENT_UPLOAD_BYTES;
                    return isValidType && isValidSize;
                  });
                  
                  if (validFiles.length > 0) {
                    const documentsWithLicense: DocumentWithLicense[] = validFiles.map(file => ({
                      file,
                      licenseType: '',
                      state: '',
                      licenseNumber: '',
                      expirationDate: '',
                      issueDate: '',
                      status: 'Active',
                      residencyType: 'Resident',
                      loaIssueDate: '',
                      companyAppointmentDate: '',
                      renewalDate: ''
                    }));
                    
                    setUploadedDocuments(prev => [...prev, ...documentsWithLicense]);
                  }
                }}
                onClick={() => {
                  const input = document.getElementById('licenseUpload') as HTMLInputElement;
                  if (input && !loading) {
                    input.click();
                  }
                }}
              >
                <input
                  type="file"
                  id="licenseUpload"
                  multiple
                  accept=".pdf,.jpg,.jpeg,.png"
                  onChange={handleFileUpload}
                  className="hidden"
                  disabled={loading}
                />
                <Upload className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                <p className="text-lg font-medium text-gray-700 mb-1">Upload License Documents</p>
                <p className="text-sm text-gray-600 mb-3">Drag and drop your license documents here, or click to browse</p>
                <p className="text-xs text-gray-500">PDF, JPG, PNG up to {MAX_DOCUMENT_UPLOAD_MB}MB each</p>
                <button
                  type="button"
                  className="mt-4 px-6 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark text-sm font-medium"
                  onClick={(e) => {
                    e.stopPropagation();
                    const input = document.getElementById('licenseUpload') as HTMLInputElement;
                    if (input && !loading) {
                      input.click();
                    }
                  }}
                >
                  Choose Files
                </button>
              </div>
              </div>
            )}
            
            {/* Uploaded Files List (New uploads being added) */}
            {uploadedDocuments.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3">
                  New License Documents ({uploadedDocuments.length})
                </h4>
                <div className="space-y-4">
                  {uploadedDocuments.map((docWithLicense, index) => (
                    <div key={index} className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                      {/* File Info Header */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center flex-1">
                          <FileText className="w-4 h-4 text-gray-500 mr-2 flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-900 truncate">{docWithLicense.file.name}</p>
                            <p className="text-xs text-gray-500">{formatFileSize(docWithLicense.file.size)}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeDocument(index)}
                          className="text-red-600 hover:text-red-800 ml-2 flex-shrink-0"
                          disabled={loading}
                          title="Remove document"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      
                      {/* License Information */}
                      <div className="pt-3 border-t border-gray-200">
                        {/* Row 1: License Number and License Type */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              License Number *
                            </label>
                            <input
                              type="text"
                              value={docWithLicense.licenseNumber}
                              onChange={(e) => updateDocumentField(index, 'licenseNumber', e.target.value)}
                              className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                !docWithLicense.licenseNumber ? 'border-red-300 bg-red-50' : 'border-gray-300'
                              }`}
                              placeholder="License number"
                              disabled={loading}
                              required
                            />
                          </div>
                          
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              License Type *
                            </label>
                            <select
                              value={docWithLicense.licenseType}
                              onChange={(e) => updateDocumentField(index, 'licenseType', e.target.value)}
                              className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                !docWithLicense.licenseType ? 'border-red-300 bg-red-50' : 'border-gray-300'
                              }`}
                              disabled={loading}
                              required
                            >
                              <option value="">Select License Type</option>
                              {LICENSE_TYPES.map(type => (
                                <option key={type.value} value={type.value}>{type.label}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        {/* Row 2: State and Residency Type */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              State *
                            </label>
                            <select
                              value={docWithLicense.state}
                              onChange={(e) => updateDocumentField(index, 'state', e.target.value)}
                              className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                !docWithLicense.state ? 'border-red-300 bg-red-50' : 'border-gray-300'
                              }`}
                              disabled={loading}
                              required
                            >
                              <option value="">Select State</option>
                              {US_STATES_FORMATTED.map((state) => (
                                <option key={state.value} value={state.value}>
                                  {state.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              Residency Type *
                            </label>
                            <select
                              value={docWithLicense.residencyType}
                              onChange={(e) => updateDocumentField(index, 'residencyType', e.target.value)}
                              className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                !docWithLicense.residencyType ? 'border-red-300 bg-red-50' : 'border-gray-300'
                              }`}
                              disabled={loading}
                              required
                            >
                              <option value="">Select Residency Type</option>
                              {RESIDENCY_TYPE_OPTIONS.map(residency => (
                                <option key={residency.value} value={residency.value}>{residency.label}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        {/* Row 3: License Status */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              License Status *
                            </label>
                            <select
                              value={docWithLicense.status}
                              onChange={(e) => updateDocumentField(index, 'status', e.target.value)}
                              className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                !docWithLicense.status ? 'border-red-300 bg-red-50' : 'border-gray-300'
                              }`}
                              disabled={loading}
                              required
                            >
                              <option value="">Select Status</option>
                              {LICENSE_STATUS_OPTIONS.map(status => (
                                <option key={status.value} value={status.value}>{status.label}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        {/* Row 4: Required Date Fields */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              Issue Date *
                            </label>
                            <input
                              type="date"
                              value={docWithLicense.issueDate}
                              onChange={(e) => updateDocumentField(index, 'issueDate', e.target.value)}
                              className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                !docWithLicense.issueDate ? 'border-red-300 bg-red-50' : 'border-gray-300'
                              }`}
                              disabled={loading}
                              required
                            />
                          </div>
                          
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              Expiration Date *
                            </label>
                            <input
                              type="date"
                              value={docWithLicense.expirationDate}
                              onChange={(e) => updateDocumentField(index, 'expirationDate', e.target.value)}
                              className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                !docWithLicense.expirationDate ? 'border-red-300 bg-red-50' : 'border-gray-300'
                              }`}
                              disabled={loading}
                              required
                            />
                          </div>
                        </div>

                        {/* Row 5: Optional Date Fields */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              Renewal Date
                            </label>
                            <input
                              type="date"
                              value={docWithLicense.renewalDate}
                              onChange={(e) => updateDocumentField(index, 'renewalDate', e.target.value)}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              disabled={loading}
                            />
                          </div>
                          
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              LOA Issue Date
                            </label>
                            <input
                              type="date"
                              value={docWithLicense.loaIssueDate}
                              onChange={(e) => updateDocumentField(index, 'loaIssueDate', e.target.value)}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              disabled={loading}
                            />
                          </div>
                          
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              Company Appointment Date
                            </label>
                            <input
                              type="date"
                              value={docWithLicense.companyAppointmentDate}
                              onChange={(e) => updateDocumentField(index, 'companyAppointmentDate', e.target.value)}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              disabled={loading}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Add License Button */}
            {!showUploadArea && uploadedDocuments.length === 0 && (
              <button
                type="button"
                onClick={() => setShowUploadArea(true)}
                className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-400 hover:text-oe-primary transition-colors flex items-center justify-center text-sm font-medium"
              >
                <FileText className="h-4 w-4 mr-2" />
                Add License Document
              </button>
            )}

            {/* Add Another License Button (when already adding) */}
            {uploadedDocuments.length > 0 && (
              <>
                <input
                  type="file"
                  id="addMoreLicenses"
                  multiple
                  accept=".pdf,.jpg,.jpeg,.png"
                  onChange={handleFileUpload}
                  className="hidden"
                  disabled={loading}
                />
                
                <button
                  type="button"
                  onClick={() => {
                    const input = document.getElementById('addMoreLicenses') as HTMLInputElement;
                    if (input && !loading) {
                      input.click();
                    }
                  }}
                  className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-400 hover:text-oe-primary transition-colors flex items-center justify-center text-sm font-medium"
                >
                  <FileText className="h-4 w-4 mr-2" />
                  Add Another License Document
                </button>
              </>
            )}
          </div>
          
          <div className="mt-6 flex justify-between items-center">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 flex items-center"
            >
              <CheckCircle className="h-4 w-4 mr-2" />
              Done
            </button>
            
            {uploadedDocuments.length > 0 && (
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Uploading...' : `Upload ${uploadedDocuments.length} License${uploadedDocuments.length !== 1 ? 's' : ''}`}
              </button>
            )}
          </div>
        </form>
      </div>

      {licenseToConfirmDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70]">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Delete License?</h3>
                <button
                  type="button"
                  onClick={() => setLicenseToConfirmDelete(null)}
                  className="text-gray-400 hover:text-gray-600"
                  disabled={deletingLicense}
                >
                  <X size={20} />
                </button>
              </div>
              <p className="text-sm text-gray-600">
                This will remove license <span className="font-medium text-gray-900">{licenseToConfirmDelete.state} - {licenseToConfirmDelete.licenseNumber}</span> from your profile.
              </p>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setLicenseToConfirmDelete(null)}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
                  disabled={deletingLicense}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void confirmDeleteExistingLicense()}
                  className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors disabled:opacity-60"
                  disabled={deletingLicense}
                >
                  {deletingLicense ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LicenseEditModal;

